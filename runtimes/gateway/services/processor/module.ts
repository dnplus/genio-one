import { observeOperation } from "@genioone/telemetry/operation-observability"
import { randomBytes } from "node:crypto"

import type {
  DataProtectionResult,
  ModelClassifierConfig,
  ProcessingContext,
  ProcessorBuiltinConfig,
  ProcessorHook,
  ProcessorPolicy,
  ProcessorPolicyStep,
} from "./contract"
import { validateExecutableProcessorSteps, validateProcessorPolicy } from "./contract"
import type { TokenVault } from "./token-vault"
import {
  mergeDataClassificationReceipts,
  type DataClassificationReceipt,
} from "../shared/data-classification"

interface CompiledPattern {
  name: string
  expression: RegExp
}

const TOKEN_PREFIX = "__GENIO_"
const TOKEN_REFERENCE_PATTERN = /<[A-Za-z][A-Za-z0-9_]{0,31}\s*:\s*[A-Za-z0-9_-]{6,8}>|__GENIO_[A-Za-z0-9_-]+__/g
const TOKEN_REFERENCE_EXACT_PATTERN = /^<([A-Za-z][A-Za-z0-9_]{0,31})\s*:\s*([A-Za-z0-9_-]{6,8})>$/
const SEMANTIC_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/

/** Keep the DLP semantic label readable; only the vault handle is opaque. */
function canonicalSemanticType(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!SEMANTIC_TYPE_PATTERN.test(normalized)) {
    throw new Error(`processor pattern ${value} has an invalid semantic type`)
  }
  return normalized
}

function canonicalTokenReference(value: string): string | null {
  const match = TOKEN_REFERENCE_EXACT_PATTERN.exec(value)
  if (!match) return null
  return `<${canonicalSemanticType(match[1]!)}:${match[2]}>`
}

function createTokenReference(semanticType: string): string {
  // Six random bytes produce an eight-character base64url handle. The
  // semantic type remains visible so an LLM can reason about the placeholder
  // without receiving the sensitive value itself.
  return `<${canonicalSemanticType(semanticType)}:${randomBytes(6).toString("base64url")}>`
}

function isPossibleAngleTokenPrefix(value: string): boolean {
  return value === "<" ||
    /^<[A-Za-z][A-Za-z0-9_]{0,31}\s*$/.test(value) ||
    /^<[A-Za-z][A-Za-z0-9_]{0,31}\s*:\s*[A-Za-z0-9_-]{0,8}$/.test(value)
}

function tokenSafeBoundary(value: string): number {
  let boundary = value.length
  let offset = 0
  while (true) {
    const start = value.indexOf(TOKEN_PREFIX, offset)
    if (start < 0) break
    const end = value.indexOf("__", start + TOKEN_PREFIX.length)
    if (end < 0) {
      boundary = Math.min(boundary, start)
      break
    }
    offset = end + 2
  }
  const open = value.lastIndexOf("<")
  if (open >= 0 && value.indexOf(">", open) < 0) {
    const fragment = value.slice(open)
    if (isPossibleAngleTokenPrefix(fragment)) {
      boundary = Math.min(boundary, open)
    }
  }
  if (boundary !== value.length) return boundary
  const tail = value.slice(offset)
  const maxSuffix = Math.min(TOKEN_PREFIX.length - 1, tail.length)
  for (let length = maxSuffix; length > 0; length -= 1) {
    if (TOKEN_PREFIX.startsWith(tail.slice(-length))) return value.length - length
  }
  return boundary
}

export interface DataProcessorOptions {
  policy: ProcessorPolicy
  tokenVault: TokenVault
  tokenFactory?: (semanticType: string) => string
}

export interface PayloadProcessor {
  protectJson(
    context: ProcessingContext,
    body: Uint8Array,
  ): Promise<DataProtectionResult>
  protectSseLine(
    context: ProcessingContext,
    line: string,
  ): Promise<DataProtectionResult>
  restoreJson(
    context: ProcessingContext,
    body: Uint8Array,
  ): Promise<DataProtectionResult>
  restoreSseLine(
    context: ProcessingContext,
    line: string,
  ): Promise<DataProtectionResult>
}

function compilePatterns(policy: ProcessorPolicy): CompiledPattern[] {
  if (policy.schema_version !== 1 || !policy.revision.trim()) {
    throw new Error("processor policy is invalid")
  }
  if (
    !Number.isSafeInteger(policy.token_ttl_seconds) ||
    policy.token_ttl_seconds < 60 ||
    policy.token_ttl_seconds > 86_400
  ) {
    throw new Error("processor token TTL must be between 60 and 86400 seconds")
  }
  return policy.patterns.map((pattern) => {
    if (!pattern.name.trim() || !pattern.expression) {
      throw new Error("processor pattern is invalid")
    }
    const flags = new Set(`${pattern.flags ?? ""}g`)
    let expression: RegExp
    try {
      expression = new RegExp(pattern.expression, [...flags].join(""))
    } catch {
      throw new Error(`processor pattern ${pattern.name} has an invalid expression`)
    }
    return {
      name: canonicalSemanticType(pattern.name),
      expression,
    }
  })
}

const DEFAULT_TOKEN_TTL_SECONDS = 600

function hookPolicy(
  hook: ProcessorHook,
  bundleRevision: string,
  stepId: string,
): ProcessorPolicy {
  const action = hook.action as ProcessorPolicy["action"]
  const config = hook.config
  if (config === undefined) {
    return {
      schema_version: 1,
      revision: `builtin-${action}-${bundleRevision.slice(0, 64)}-${stepId.slice(0, 64)}`,
      action,
      patterns: [],
      token_ttl_seconds: DEFAULT_TOKEN_TTL_SECONDS,
    }
  }
  // The canonical hook config is action-neutral; the hook owns the action.
  const builtinConfig = config as ProcessorBuiltinConfig
  return validateProcessorPolicy({
    schema_version: 1,
    revision: `builtin-${action}-${bundleRevision.slice(0, 64)}-${stepId.slice(0, 64)}`,
    action,
    patterns: builtinConfig.patterns,
    token_ttl_seconds: builtinConfig.token_ttl_seconds,
  })
}

interface RuntimeHook {
  action: string
  processor: PayloadProcessor
  sourceVersion?: string
}

interface RuntimeStep {
  stepId: string
  request?: RuntimeHook
  response?: RuntimeHook
}

function classifierText(value: Record<string, unknown>): string {
  const messages = value.messages
  if (!Array.isArray(messages)) return ""
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return []
    const content = (message as Record<string, unknown>).content
    if (typeof content === "string") return [content]
    if (!Array.isArray(content)) return []
    return content.flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return []
      const text = (part as Record<string, unknown>).text
      return typeof text === "string" ? [text] : []
    })
  }).join("\n").toLocaleLowerCase("en-US")
}

function createModelClassifier(config: ModelClassifierConfig): PayloadProcessor {
  const classify = async (body: Uint8Array): Promise<DataProtectionResult> => {
    let value: unknown
    try {
      value = JSON.parse(Buffer.from(body).toString("utf8")) as unknown
    } catch {
      return { disposition: "BLOCK", body, matches: ["INVALID_JSON"] }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { disposition: "BLOCK", body, matches: ["INVALID_JSON"] }
    }
    const request = value as Record<string, unknown>
    const text = classifierText(request)
    const selected = config.rules.find((rule) =>
      rule.keywords.some((keyword) => text.includes(keyword.toLocaleLowerCase("en-US"))))
      ?.public_model_name ?? config.fallback_public_model_name
    request.model = selected
    return {
      disposition: "CONTINUE",
      body: Buffer.from(JSON.stringify(request)),
      matches: [],
    }
  }
  const pass = async (body: Uint8Array): Promise<DataProtectionResult> => ({
    disposition: "CONTINUE",
    body,
    matches: [],
  })
  return {
    protectJson: (_context, body) => classify(body),
    protectSseLine: async (_context, line) => classify(Buffer.from(line)),
    restoreJson: (_context, body) => pass(body),
    restoreSseLine: async (_context, line) => pass(Buffer.from(line)),
  }
}

function hookRuntime(
  hook: ProcessorHook | undefined,
  stepId: string,
  bundleRevision: string,
  tokenVault: TokenVault,
  processorFactory?: (policy: ProcessorPolicy, tokenVault: TokenVault) => PayloadProcessor,
): RuntimeHook | undefined {
  if (!hook) return undefined
  if (hook.action === "MODEL_CLASSIFIER") {
    return {
      action: hook.action,
      processor: createModelClassifier(hook.config as ModelClassifierConfig),
    }
  }
  const policy = hookPolicy(hook, bundleRevision, stepId)
  return {
    action: policy.action,
    processor: processorFactory?.(policy, tokenVault) ??
      new DataProcessor({ policy, tokenVault }),
    sourceVersion: policy.revision,
  }
}

/**
 * Build the executable view of one ordered scope. The serialized step array
 * is authoritative for request order; response hooks are traversed in the
 * reverse order, matching Envoy's filter unwinding semantics.
 */
export function createProcessorChain(
  steps: readonly ProcessorPolicyStep[],
  tokenVault: TokenVault,
  bundleRevision: string,
  processorFactory?: (policy: ProcessorPolicy, tokenVault: TokenVault) => PayloadProcessor,
): PayloadProcessor {
  if (steps.length === 0) {
    throw new Error("processor policy scope must contain at least one step")
  }
  validateExecutableProcessorSteps(steps)
  const runtimeSteps: RuntimeStep[] = []
  for (const step of steps) {
    const request = hookRuntime(
      step.hooks.request,
      step.step_id,
      bundleRevision,
      tokenVault,
      processorFactory,
    )
    const response = hookRuntime(
      step.hooks.response,
      step.step_id,
      bundleRevision,
      tokenVault,
      processorFactory,
    )
    runtimeSteps.push({ stepId: step.step_id, request, response })
  }

  const run = async (
    direction: "request" | "response",
    context: ProcessingContext,
    body: Uint8Array,
  ): Promise<DataProtectionResult> => {
    const ordered = direction === "request" ? runtimeSteps : [...runtimeSteps].reverse()
    let current = body
    const matches = new Set<string>()
    const dataClassifications: DataClassificationReceipt[] = []
    const executedSteps: NonNullable<DataProtectionResult["executedSteps"]> = []
    for (const step of ordered) {
      const hook = direction === "request" ? step.request : step.response
      if (!hook) continue
      executedSteps.push({ stepId: step.stepId, action: hook.action })
      const hookMethod = hook.action === "RESTORE" ? "restoreJson" : "protectJson"
      const result = await hook.processor[hookMethod](context, current)
      result.matches.forEach((match) => matches.add(match))
      if (hook.sourceVersion && hook.action !== "RESTORE") {
        for (const classification of result.matches.filter((match) => match !== "INVALID_JSON")) {
          const receipt: DataClassificationReceipt = {
            classification,
            handling_action: hook.action as DataClassificationReceipt["handling_action"],
            source: "DLP_DETECTOR",
            source_version: hook.sourceVersion,
            trust_level: "RUNTIME_OBSERVED",
            step_id: step.stepId,
          }
          mergeDataClassificationReceipts(dataClassifications, [receipt])
        }
      }
      current = result.body
      if (result.disposition === "BLOCK") {
        return { ...result, body: current, matches: [...matches], executedSteps, dataClassifications }
      }
    }
    return { disposition: "CONTINUE", body: current, matches: [...matches], executedSteps, dataClassifications }
  }

  const runSse = async (
    direction: "request" | "response",
    context: ProcessingContext,
    line: string,
  ): Promise<DataProtectionResult> => {
    const ordered = direction === "request" ? runtimeSteps : [...runtimeSteps].reverse()
    let current = Buffer.from(line)
    const matches = new Set<string>()
    const dataClassifications: DataClassificationReceipt[] = []
    const executedSteps: NonNullable<DataProtectionResult["executedSteps"]> = []
    for (const step of ordered) {
      const hook = direction === "request" ? step.request : step.response
      if (!hook) continue
      executedSteps.push({ stepId: step.stepId, action: hook.action })
      const method = hook.action === "RESTORE" ? "restoreSseLine" : "protectSseLine"
      const result = await hook.processor[method](context, current.toString("utf8"))
      result.matches.forEach((match) => matches.add(match))
      if (hook.sourceVersion && hook.action !== "RESTORE") {
        for (const classification of result.matches.filter((match) => match !== "INVALID_JSON")) {
          const receipt: DataClassificationReceipt = {
            classification,
            handling_action: hook.action as DataClassificationReceipt["handling_action"],
            source: "DLP_DETECTOR",
            source_version: hook.sourceVersion,
            trust_level: "RUNTIME_OBSERVED",
            step_id: step.stepId,
          }
          mergeDataClassificationReceipts(dataClassifications, [receipt])
        }
      }
      current = Buffer.from(result.body)
      if (result.disposition === "BLOCK") {
        return { ...result, body: current, matches: [...matches], executedSteps, dataClassifications }
      }
    }
    return { disposition: "CONTINUE", body: current, matches: [...matches], executedSteps, dataClassifications }
  }

  return {
    protectJson: (context, body) => observeOperation("genio-one-processor", "processor.request", context, () => run("request", context, body)),
    protectSseLine: (context, line) => observeOperation("genio-one-processor", "processor.request.sse", context, () => runSse("request", context, line)),
    restoreJson: (context, body) => observeOperation("genio-one-processor", "processor.response", context, () => run("response", context, body)),
    restoreSseLine: (context, line) => observeOperation("genio-one-processor", "processor.response.sse", context, () => runSse("response", context, line)),
  }
}

async function replaceAsync(
  value: string,
  pattern: RegExp,
  replacement: (match: string) => Promise<string>,
): Promise<{ value: string; count: number }> {
  const matches = [...value.matchAll(pattern)]
  if (matches.length === 0) return { value, count: 0 }
  let result = ""
  let offset = 0
  for (const match of matches) {
    const index = match.index ?? 0
    result += value.slice(offset, index)
    result += await replacement(match[0])
    offset = index + match[0].length
  }
  return { value: result + value.slice(offset), count: matches.length }
}

export class DataProcessor {
  private readonly patterns: CompiledPattern[]
  private readonly tokenFactory: (semanticType: string) => string
  private readonly options: DataProcessorOptions
  private sseRestorePending = ""

  constructor(options: DataProcessorOptions) {
    const policy = validateProcessorPolicy(options.policy)
    this.options = { ...options, policy }
    this.patterns = compilePatterns(policy)
    this.tokenFactory =
      options.tokenFactory ??
      ((semanticType) => createTokenReference(semanticType))
  }

  async protectJson(
    context: ProcessingContext,
    body: Uint8Array,
  ): Promise<DataProtectionResult> {
    if (this.options.policy.action === "RESTORE") {
      throw new Error("RESTORE cannot process a request payload")
    }
    if (body.byteLength === 0) {
      return { disposition: "CONTINUE", body, matches: [] }
    }
    let value: unknown
    try {
      value = JSON.parse(Buffer.from(body).toString("utf8"))
    } catch {
      return { disposition: "BLOCK", body, matches: ["INVALID_JSON"] }
    }
    const matches = new Set<string>()
    const transformed = await this.protectValue(context, value, matches)
    if (this.options.policy.action === "BLOCK" && matches.size > 0) {
      return { disposition: "BLOCK", body, matches: [...matches] }
    }
    return {
      disposition: "CONTINUE",
      body: Buffer.from(JSON.stringify(transformed)),
      matches: [...matches],
    }
  }

  async restoreJson(
    context: ProcessingContext,
    body: Uint8Array,
  ): Promise<DataProtectionResult> {
    if (body.byteLength === 0) {
      return { disposition: "CONTINUE", body, matches: [] }
    }
    let value: unknown
    try {
      value = JSON.parse(Buffer.from(body).toString("utf8"))
    } catch {
      return { disposition: "BLOCK", body, matches: ["INVALID_JSON"] }
    }
    return {
      disposition: "CONTINUE",
      body: Buffer.from(JSON.stringify(await this.restoreValue(context, value))),
      matches: [],
    }
  }

  async protectSseLine(
    context: ProcessingContext,
    line: string,
  ): Promise<DataProtectionResult> {
    if (!line.startsWith("data:") || line.trim() === "data: [DONE]") {
      return { disposition: "CONTINUE", body: Buffer.from(line), matches: [] }
    }
    const prefix = line.slice(0, line.indexOf(":") + 1)
    const spacing = line.slice(prefix.length).match(/^\s*/)?.[0] ?? ""
    const payload = line.slice(prefix.length + spacing.length)
    const protectedPayload = await this.protectJson(context, Buffer.from(payload))
    return {
      ...protectedPayload,
      body: Buffer.from(`${prefix}${spacing}${Buffer.from(protectedPayload.body).toString("utf8")}`),
    }
  }

  async restoreSseLine(
    context: ProcessingContext,
    line: string,
  ): Promise<DataProtectionResult> {
    if (line.trim() === "data: [DONE]") {
      if (!this.sseRestorePending) {
        return { disposition: "CONTINUE", body: Buffer.from(line), matches: [] }
      }
      if (
        this.sseRestorePending.startsWith(TOKEN_PREFIX) ||
        isPossibleAngleTokenPrefix(this.sseRestorePending)
      ) {
        throw new Error("stream ended with an incomplete token vault reference")
      }
      const pending = this.sseRestorePending
      this.sseRestorePending = ""
      return {
        disposition: "CONTINUE",
        body: Buffer.from(
          `data: ${JSON.stringify({ choices: [{ delta: { content: pending } }] })}\n\n${line}`,
        ),
        matches: [],
      }
    }
    if (!line.startsWith("data:")) {
      return { disposition: "CONTINUE", body: Buffer.from(line), matches: [] }
    }
    const prefix = line.slice(0, line.indexOf(":") + 1)
    const spacing = line.slice(prefix.length).match(/^\s*/)?.[0] ?? ""
    const payload = line.slice(prefix.length + spacing.length)
    let parsed: { choices?: Array<{ delta?: { content?: unknown } }> }
    try {
      parsed = JSON.parse(payload) as typeof parsed
    } catch {
      return { disposition: "BLOCK", body: Buffer.from(line), matches: ["INVALID_JSON"] }
    }
    const contentChoices = (parsed.choices ?? []).filter(
      (choice) => typeof choice.delta?.content === "string",
    )
    if (contentChoices.length > 1) {
      throw new Error("multiple streamed choices are not supported by token restoration")
    }
    if (contentChoices.length === 0) {
      return { disposition: "CONTINUE", body: Buffer.from(line), matches: [] }
    }
    const choice = contentChoices[0]!
    const combined = `${this.sseRestorePending}${choice.delta!.content as string}`
    const boundary = tokenSafeBoundary(combined)
    const safe = combined.slice(0, boundary)
    this.sseRestorePending = combined.slice(boundary)
    choice.delta!.content = await this.restoreValue(context, safe)
    return {
      disposition: "CONTINUE",
      body: Buffer.from(`${prefix}${spacing}${JSON.stringify(parsed)}`),
      matches: [],
    }
  }

  private async protectValue(
    context: ProcessingContext,
    value: unknown,
    matches: Set<string>,
  ): Promise<unknown> {
    if (typeof value === "string") {
      let current = value
      for (const pattern of this.patterns) {
        const replaced = await replaceAsync(current, pattern.expression, async (match) => {
          matches.add(pattern.name)
          if (this.options.policy.action === "BLOCK") return match
          if (this.options.policy.action === "REDACT") return `[REDACTED:${pattern.name}]`
          const token = this.tokenFactory(pattern.name)
          await this.options.tokenVault.store(
            context,
            token,
            match,
            this.options.policy.token_ttl_seconds,
          )
          return token
        })
        current = replaced.value
      }
      return current
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((entry) => this.protectValue(context, entry, matches)))
    }
    if (value && typeof value === "object") {
      const entries = await Promise.all(
        Object.entries(value).map(async ([key, entry]) => [
          key,
          await this.protectValue(context, entry, matches),
        ] as const),
      )
      return Object.fromEntries(entries)
    }
    return value
  }

  private async restoreValue(context: ProcessingContext, value: unknown): Promise<unknown> {
    if (typeof value === "string") {
      return replaceAsync(value, TOKEN_REFERENCE_PATTERN, async (token) => {
        const vaultToken = canonicalTokenReference(token) ?? token
        const resolved = await this.options.tokenVault.resolve(context, vaultToken)
        if (resolved === null) throw new Error("token vault mapping is unavailable")
        return resolved
      }).then((result) => result.value)
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((entry) => this.restoreValue(context, entry)))
    }
    if (value && typeof value === "object") {
      const entries = await Promise.all(
        Object.entries(value).map(async ([key, entry]) => [
          key,
          await this.restoreValue(context, entry),
        ] as const),
      )
      return Object.fromEntries(entries)
    }
    return value
  }
}

export class SseLineBuffer {
  private buffered = ""

  async push(
    chunk: Uint8Array,
    endOfStream: boolean,
    transform: (line: string) => Promise<DataProtectionResult>,
  ): Promise<DataProtectionResult> {
    this.buffered += Buffer.from(chunk).toString("utf8")
    const parts = this.buffered.split("\n")
    this.buffered = endOfStream ? "" : (parts.pop() ?? "")
    if (endOfStream && parts.at(-1) === "") parts.pop()
    const matches = new Set<string>()
    const dataClassifications: DataClassificationReceipt[] = []
    const executedSteps: NonNullable<DataProtectionResult["executedSteps"]> = []
    const output: string[] = []
    for (const line of parts) {
      const transformed = await transform(line)
      if (transformed.disposition === "BLOCK") return transformed
      transformed.matches.forEach((match) => matches.add(match))
      mergeDataClassificationReceipts(dataClassifications, transformed.dataClassifications ?? [])
      for (const step of transformed.executedSteps ?? []) {
        if (!executedSteps.some((existing) =>
          existing.stepId === step.stepId && existing.action === step.action
        )) {
          executedSteps.push(step)
        }
      }
      output.push(Buffer.from(transformed.body).toString("utf8"))
    }
    if (endOfStream && this.buffered) {
      const transformed = await transform(this.buffered)
      if (transformed.disposition === "BLOCK") return transformed
      transformed.matches.forEach((match) => matches.add(match))
      mergeDataClassificationReceipts(dataClassifications, transformed.dataClassifications ?? [])
      for (const step of transformed.executedSteps ?? []) {
        if (!executedSteps.some((existing) =>
          existing.stepId === step.stepId && existing.action === step.action
        )) {
          executedSteps.push(step)
        }
      }
      output.push(Buffer.from(transformed.body).toString("utf8"))
      this.buffered = ""
    }
    const suffix = output.length > 0 && (!endOfStream || chunk.at(-1) === 10) ? "\n" : ""
    return {
      disposition: "CONTINUE",
      body: Buffer.from(`${output.join("\n")}${suffix}`),
      matches: [...matches],
      executedSteps,
      dataClassifications,
    }
  }
}
