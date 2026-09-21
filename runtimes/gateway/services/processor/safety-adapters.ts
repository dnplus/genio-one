import type {
  DataProtectionResult,
  ProcessingContext,
  SafetyCheckConfig,
  SafetyDecision,
} from "./contract"
import {
  MAX_SAFETY_STATE_BYTES,
  systemOneQuestionsForChecks,
  systemOneQuestionsWithinRequestBudget,
  type PresidioSpan,
  type ProcessorAdapterRuntime,
} from "../shared/processor-adapters"

export function validateSafetyState(value: unknown): unknown {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error("safety state is invalid")
  if (Buffer.byteLength(serialized, "utf8") > MAX_SAFETY_STATE_BYTES) {
    throw new Error("safety state is too large")
  }
  return value
}

function own(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function validModel(value: unknown): value is string {
  return typeof value === "string" &&
    Boolean(value.trim()) &&
    value === value.trim() &&
    value.length <= 512 &&
    !/[\u0000\r\n]/.test(value)
}

export class SafetyCheckProcessor {
  constructor(
    private readonly config: SafetyCheckConfig,
    private readonly adapterRuntime: ProcessorAdapterRuntime | undefined,
  ) {
    if (!systemOneQuestionsWithinRequestBudget(config.checks)) {
      throw new Error("SAFETY_CHECK questions exceed request budget")
    }
  }

  requiresBufferedResponse(_direction: "request" | "response"): boolean {
    return true
  }

  async protectJson(
    context: ProcessingContext,
    body: Uint8Array,
  ): Promise<DataProtectionResult> {
    return this.evaluateJson(context, body)
  }

  async restoreJson(
    context: ProcessingContext,
    body: Uint8Array,
  ): Promise<DataProtectionResult> {
    return this.evaluateJson(context, body)
  }

  async protectSseLine(
    _context: ProcessingContext,
    _line: string,
  ): Promise<DataProtectionResult> {
    throw new Error("SAFETY_CHECK_REQUIRES_BUFFERED_STREAM")
  }

  async restoreSseLine(
    _context: ProcessingContext,
    _line: string,
  ): Promise<DataProtectionResult> {
    throw new Error("SAFETY_CHECK_REQUIRES_BUFFERED_STREAM")
  }

  private async evaluateJson(
    context: ProcessingContext,
    body: Uint8Array,
  ): Promise<DataProtectionResult> {
    if (body.byteLength === 0) {
      return { disposition: "CONTINUE", body, matches: [] }
    }
    let state: unknown
    try {
      state = validateSafetyState(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown,
      )
    } catch {
      return { disposition: "BLOCK", body, matches: ["INVALID_JSON"] }
    }
    return this.evaluateState(context, body, state)
  }

  private async evaluateState(
    context: ProcessingContext,
    body: Uint8Array,
    state: unknown,
  ): Promise<DataProtectionResult> {
    try {
      if (!this.adapterRuntime) throw new Error("safety adapter runtime is unavailable")
      const adapter = this.adapterRuntime.resolveSafetyAdapter(context.tenantId, this.config.adapter_id)
      const response = await adapter.evaluate({
        state,
        questions: systemOneQuestionsForChecks(this.config.checks),
      }, this.config.timeout_ms)
      if (!validModel(response.model) || Object.keys(response.answers).length !== this.config.checks.length) {
        throw new Error("safety adapter response is invalid")
      }
      const safetyDecisions: SafetyDecision[] = []
      for (const check of this.config.checks) {
        if (!own(response.answers, check.id)) throw new Error("safety adapter response is invalid")
        const answer = response.answers[check.id]
        if (
          !answer ||
          answer.type !== "noul" ||
          typeof answer.noul !== "number" ||
          !Number.isFinite(answer.noul) ||
          answer.noul < 0 ||
          answer.noul > 1
        ) {
          throw new Error("safety adapter response is invalid")
        }
        safetyDecisions.push({
          adapter_id: adapter.adapterId,
          provider: adapter.provider,
          model: response.model,
          check_id: check.id,
          score: answer.noul,
          threshold: check.threshold,
          decision: answer.noul >= check.threshold ? "BLOCK" : "ALLOW",
        })
      }
      return {
        disposition: safetyDecisions.some((decision) => decision.decision === "BLOCK")
          ? "BLOCK"
          : "CONTINUE",
        body,
        matches: [],
        safetyDecisions,
      }
    } catch {
      throw new Error("SAFETY_ADAPTER_UNAVAILABLE")
    }
  }
}

export interface PresidioDetection {
  start: number
  end: number
  score: number
  entity: string
  adapterId: string
}

function codePointToUtf16Offset(text: string, codePointOffset: number): number {
  if (!Number.isInteger(codePointOffset) || codePointOffset < 0) {
    throw new Error("Presidio span is invalid")
  }
  let codePoints = 0
  let utf16 = 0
  for (const character of text) {
    if (codePoints === codePointOffset) return utf16
    codePoints += 1
    utf16 += character.length
  }
  if (codePoints === codePointOffset) return utf16
  throw new Error("Presidio span is invalid")
}

function validatePresidioSpan(
  text: string,
  span: PresidioSpan,
  entities: ReadonlySet<string>,
  scoreThreshold: number,
  adapterId: string,
): PresidioDetection | null {
  if (
    !Number.isInteger(span.start) ||
    !Number.isInteger(span.end) ||
    !Number.isFinite(span.score) ||
    span.score < 0 ||
    span.score > 1 ||
    !entities.has(span.entity_type)
  ) {
    throw new Error("Presidio span is invalid")
  }
  const start = codePointToUtf16Offset(text, span.start)
  const end = codePointToUtf16Offset(text, span.end)
  if (start >= end) throw new Error("Presidio span is invalid")
  if (span.score < scoreThreshold) return null
  return { start, end, score: span.score, entity: span.entity_type, adapterId }
}

export async function analyzePresidioText(
  runtime: ProcessorAdapterRuntime | undefined,
  context: ProcessingContext,
  detector: {
    adapter_id: string
    language: string
    entities: readonly string[]
    score_threshold: number
  },
  text: string,
  timeoutMs: number,
): Promise<readonly PresidioDetection[]> {
  if (!runtime) throw new Error("Presidio adapter runtime is unavailable")
  const adapter = runtime.resolvePresidioAdapter(context.tenantId, detector.adapter_id)
  const spans = await adapter.analyze({
    text,
    language: detector.language,
    entities: detector.entities,
    scoreThreshold: detector.score_threshold,
    timeoutMs,
  })
  const entities = new Set(detector.entities)
  const detections = spans.flatMap((span) => {
    const detection = validatePresidioSpan(
      text,
      span,
      entities,
      detector.score_threshold,
      adapter.adapterId,
    )
    return detection ? [detection] : []
  })
  return detections.sort((left, right) =>
    left.start - right.start ||
    right.end - left.end ||
    left.entity.localeCompare(right.entity, "en") ||
    right.score - left.score
  )
}
