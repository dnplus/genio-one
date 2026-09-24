export const DISTILLATION_CLASSIFIER_VERSION = "jev-distillation-1"
export const LEGACY_DISTILLATION_EXTRACTOR_VERSION = "timeline-body-1"
export const DISTILLATION_EXTRACTOR_VERSION = "timeline-visible-2"
export const DISTILLATION_EXTRACTOR_VERSIONS = [
  LEGACY_DISTILLATION_EXTRACTOR_VERSION,
  DISTILLATION_EXTRACTOR_VERSION,
] as const
export const DISTILLATION_PROCESSING_STATES = [
  "PENDING",
  "WAITING_FOR_HISTORY",
  "PROCESSING",
  "CANDIDATE_CREATED",
  "FILTERED_OUT",
  "FAILED",
] as const
export const DISTILLATION_TRIAGE_STATE_BYTE_LIMIT = 96_000
export const DISTILLATION_TRIAGE_REQUEST_BYTE_LIMIT = 100_000
// Identifiers are at most 256 UTF-16 code units; a control character serializes
// as a six-byte JSON \u escape, the largest per-unit size, so these
// placeholders reserve the worst-case request overhead for any real IDs.
const TRIAGE_TENANT_ID = "\u0001".repeat(256)
const TRIAGE_ADAPTER_ID = "\u0001".repeat(256)

export const DISTILLATION_SCOPES = [
  "product",
  "department",
  "process",
  "shared",
  "customer_project",
  "unrelated",
] as const

export const DISTILLATION_SENSITIVITIES = ["standard", "restricted"] as const
export const DISTILLATION_TYPES = ["FACT", "PROCEDURE", "DECISION", "SKILL"] as const
export const DISTILLATION_REPRESENTATIONS = ["HUMAN", "MACHINE", "BOTH", "EVIDENCE_ONLY"] as const

export type DistillationScope = (typeof DISTILLATION_SCOPES)[number]
export type DistillationSensitivity = (typeof DISTILLATION_SENSITIVITIES)[number]
export type DistillationType = (typeof DISTILLATION_TYPES)[number]
export type DistillationRepresentation = (typeof DISTILLATION_REPRESENTATIONS)[number]
export type DistillationExtractorVersion = (typeof DISTILLATION_EXTRACTOR_VERSIONS)[number]
export type DistillationProcessingState = (typeof DISTILLATION_PROCESSING_STATES)[number]

export interface DistillationQuestion {
  id: string
  instructions: string
  threshold: number
}

export const DISTILLATION_QUESTIONS = [
  { id: "relevant", instructions: "這段已完成的工作是否含有可重用的團隊知識，而不是寒暄、重試碎片或沒有結論的過程。", threshold: 0.7 },
  { id: "scope_customer_project", instructions: "內容是否含有特定客戶、契約、專案機密，或只屬於該客戶的資料。", threshold: 0.7 },
  { id: "scope_department", instructions: "內容是否主要只適用於某一個部門或團隊的內部做法。", threshold: 0.7 },
  { id: "scope_product", instructions: "內容是否在描述產品行為、設定、缺陷或操作方式。", threshold: 0.7 },
  { id: "scope_process", instructions: "內容是否在描述可重複執行的工作步驟。", threshold: 0.7 },
  { id: "scope_shared", instructions: "內容是否可被同一個組織的多個團隊共用。", threshold: 0.7 },
  { id: "sensitivity_restricted", instructions: "內容是否含有秘密、憑證、個人資料、未公開客戶資料，或其他不應進入一般知識庫的資料。", threshold: 0.7 },
  { id: "type_skill", instructions: "內容是否適合成為可執行的 Skill、腳本或檢查清單。", threshold: 0.7 },
  { id: "type_procedure", instructions: "內容是否是一組有順序的操作程序。", threshold: 0.7 },
  { id: "type_decision", instructions: "內容是否記錄了一個已做出的決定與其理由。", threshold: 0.7 },
  { id: "type_fact", instructions: "內容是否是一個可單獨引用的事實或現況。", threshold: 0.7 },
] as const satisfies readonly DistillationQuestion[]

const SCOPE_PRIORITY = ["customer_project", "department", "product", "process", "shared"] as const
const TYPE_PRIORITY = ["SKILL", "PROCEDURE", "DECISION", "FACT"] as const

export interface DistillationEvidence {
  check_id: string
  score: number
  threshold: number
  matched: boolean
}

export interface DistillationClassification {
  status: "CLASSIFIED"
  relevant: boolean
  scope: DistillationScope
  sensitivity: DistillationSensitivity
  knowledge_type: DistillationType
  representation: DistillationRepresentation
  classifier_version: typeof DISTILLATION_CLASSIFIER_VERSION
  evidence: DistillationEvidence[]
}

export interface DistillationUnavailable {
  status: "UNAVAILABLE"
  classifier_version: typeof DISTILLATION_CLASSIFIER_VERSION
}

export type DistillationTriage = DistillationClassification | DistillationUnavailable

function finiteScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isOneOf(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value)
}

function isEvidence(value: unknown): value is DistillationEvidence {
  return isRecord(value) &&
    hasExactKeys(value, ["check_id", "score", "threshold", "matched"]) &&
    typeof value.check_id === "string" &&
    DISTILLATION_QUESTIONS.some((question) => question.id === value.check_id) &&
    finiteScore(value.score) &&
    finiteScore(value.threshold) &&
    typeof value.matched === "boolean"
}

function sameEvidence(left: DistillationEvidence, right: DistillationEvidence): boolean {
  return left.check_id === right.check_id &&
    left.score === right.score &&
    left.threshold === right.threshold &&
    left.matched === right.matched
}

function questionMatched(score: number, threshold: number): boolean {
  return score >= threshold
}

export function mapDistillationAnswers(
  answers: Readonly<Record<string, { noul?: unknown }>> | undefined,
): DistillationTriage {
  const evidence: DistillationEvidence[] = []
  for (const question of DISTILLATION_QUESTIONS) {
    const score = answers?.[question.id]?.noul
    if (!finiteScore(score)) {
      return { status: "UNAVAILABLE", classifier_version: DISTILLATION_CLASSIFIER_VERSION }
    }
    evidence.push({
      check_id: question.id,
      score,
      threshold: question.threshold,
      matched: questionMatched(score, question.threshold),
    })
  }
  const matched = new Map(evidence.map((item) => [item.check_id, item]))
  const relevant = matched.get("relevant")!.matched
  const matchedScope = SCOPE_PRIORITY.find((name) => matched.get(`scope_${name}`)!.matched)
  if (relevant && !matchedScope) {
    return { status: "UNAVAILABLE", classifier_version: DISTILLATION_CLASSIFIER_VERSION }
  }
  const scope: DistillationScope = relevant ? matchedScope! : "unrelated"
  const typeScores = TYPE_PRIORITY.map((name) => matched.get(`type_${name.toLowerCase()}`)! )
  const bestType = typeScores
    .filter((item) => item.matched)
    .sort((left, right) => right.score - left.score || TYPE_PRIORITY.indexOf(typeName(left.check_id)) - TYPE_PRIORITY.indexOf(typeName(right.check_id)))[0]
  const knowledgeType = bestType ? typeName(bestType.check_id) : "FACT"
  const restricted = matched.get("sensitivity_restricted")!.matched || scope === "customer_project"
  const sensitivity: DistillationSensitivity = restricted ? "restricted" : "standard"
  const representation: DistillationRepresentation = restricted
    ? "EVIDENCE_ONLY"
    : knowledgeType === "SKILL"
      ? "MACHINE"
      : knowledgeType === "PROCEDURE"
        ? "BOTH"
        : "HUMAN"
  return {
    status: "CLASSIFIED",
    relevant,
    scope,
    sensitivity,
    knowledge_type: knowledgeType,
    representation,
    classifier_version: DISTILLATION_CLASSIFIER_VERSION,
    evidence,
  }
}

export function isDistillationTriage(value: unknown): value is DistillationTriage {
  if (!isRecord(value)) return false
  if (value.status === "UNAVAILABLE") {
    return hasExactKeys(value, ["status", "classifier_version"]) &&
      value.classifier_version === DISTILLATION_CLASSIFIER_VERSION
  }
  if (value.status !== "CLASSIFIED" ||
    !hasExactKeys(value, [
      "status",
      "relevant",
      "scope",
      "sensitivity",
      "knowledge_type",
      "representation",
      "classifier_version",
      "evidence",
    ]) ||
    typeof value.relevant !== "boolean" ||
    !isOneOf(DISTILLATION_SCOPES, value.scope) ||
    !isOneOf(DISTILLATION_SENSITIVITIES, value.sensitivity) ||
    !isOneOf(DISTILLATION_TYPES, value.knowledge_type) ||
    !isOneOf(DISTILLATION_REPRESENTATIONS, value.representation) ||
    value.classifier_version !== DISTILLATION_CLASSIFIER_VERSION ||
    !Array.isArray(value.evidence) ||
    !value.evidence.every(isEvidence)) {
    return false
  }
  const evidence = value.evidence
  const answers: Record<string, { noul: number }> = {}
  for (const item of evidence) answers[item.check_id] = { noul: item.score }
  const expected = mapDistillationAnswers(answers)
  return expected.status === "CLASSIFIED" &&
    expected.relevant === value.relevant &&
    expected.scope === value.scope &&
    expected.sensitivity === value.sensitivity &&
    expected.knowledge_type === value.knowledge_type &&
    expected.representation === value.representation &&
    expected.classifier_version === value.classifier_version &&
    expected.evidence.length === evidence.length &&
    expected.evidence.every((item, index) => sameEvidence(item, evidence[index]!))
}

function triageRequestFits(text: string): boolean {
  const state = JSON.stringify({ messages: [{ role: "user", content: text }] })
  const request = JSON.stringify({ tenant_id: TRIAGE_TENANT_ID, adapter_id: TRIAGE_ADAPTER_ID, text })
  return Buffer.byteLength(state, "utf8") <= DISTILLATION_TRIAGE_STATE_BYTE_LIMIT
    && Buffer.byteLength(request, "utf8") <= DISTILLATION_TRIAGE_REQUEST_BYTE_LIMIT
}

function trimToCodePoint(value: string): string {
  if (value.length === 0) return value
  const last = value.charCodeAt(value.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value
}

export function fitDistillationExcerpt(text: string): { text: string; truncated: boolean } {
  if (triageRequestFits(text)) return { text, truncated: false }
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (triageRequestFits(text.slice(0, mid))) low = mid
    else high = mid - 1
  }
  return { text: trimToCodePoint(text.slice(0, low)), truncated: true }
}

function typeName(checkId: string): DistillationType {
  const name = checkId.slice("type_".length).toUpperCase()
  if (name === "FACT" || name === "PROCEDURE" || name === "DECISION" || name === "SKILL") return name
  return "FACT"
}
