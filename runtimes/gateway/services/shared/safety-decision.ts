import { Type, type Static } from "typebox"
import { Value } from "typebox/value"

const Identifier = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^(?!\\s)(?!.*\\s$)[^\\u0000\\r\\n]+$",
})

export const PROCESSOR_SAFETY_DECISIONS_HEADER = "x-genio-processor-safety-decisions"
export const MAX_SAFETY_DECISION_HANDOFF_BYTES = 8 * 1024

export const SafetyDecisionSchema = Type.Object({
  adapter_id: Identifier,
  provider: Type.Union([Type.Literal("JEV"), Type.Literal("HTTP")]),
  model: Type.String({ minLength: 1, maxLength: 512 }),
  check_id: Identifier,
  score: Type.Number({ minimum: 0, maximum: 1 }),
  threshold: Type.Number({ minimum: 0, maximum: 1 }),
  decision: Type.Union([Type.Literal("ALLOW"), Type.Literal("BLOCK")]),
}, { additionalProperties: false })

export type SafetyDecision = Static<typeof SafetyDecisionSchema>

export const SafetyDecisionReceiptSchema = Type.Object({
  ...SafetyDecisionSchema.properties,
  direction: Type.Union([Type.Literal("request"), Type.Literal("response")]),
  step_id: Identifier,
}, { additionalProperties: false })

export type SafetyDecisionReceipt = Static<typeof SafetyDecisionReceiptSchema>

function receiptKey(receipt: SafetyDecisionReceipt): string {
  return JSON.stringify([
    receipt.direction,
    receipt.step_id,
    receipt.adapter_id,
    receipt.check_id,
  ])
}

export function mergeSafetyDecisionReceipts(
  target: SafetyDecisionReceipt[],
  source: readonly SafetyDecisionReceipt[],
): void {
  const existing = new Set(target.map(receiptKey))
  for (const receipt of source) {
    const key = receiptKey(receipt)
    if (existing.has(key)) continue
    existing.add(key)
    target.push({ ...receipt })
  }
}

export function safetyDecisionReceipts(
  decisions: readonly SafetyDecision[] | undefined,
  direction: SafetyDecisionReceipt["direction"],
): SafetyDecisionReceipt[] {
  if (!decisions) return []
  return decisions.map((decision) => {
    const receipt = decision as unknown as SafetyDecisionReceipt
    if (!Value.Check(SafetyDecisionReceiptSchema, receipt) || receipt.direction !== direction) {
      throw new Error("safety decision receipt is invalid")
    }
    return { ...receipt }
  })
}

function serializedSafetyDecisionReceipts(
  receipts: readonly SafetyDecisionReceipt[],
): string {
  return JSON.stringify(receipts).replace(/[^\u0000-\u007f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

export function safetyDecisionReceiptSerializedBytes(
  receipts: readonly SafetyDecisionReceipt[],
): number {
  return new TextEncoder().encode(serializedSafetyDecisionReceipts(receipts)).byteLength
}

export function serializeSafetyDecisionReceipts(
  receipts: readonly SafetyDecisionReceipt[],
): string {
  const serialized = serializedSafetyDecisionReceipts(receipts)
  if (safetyDecisionReceiptSerializedBytes(receipts) > MAX_SAFETY_DECISION_HANDOFF_BYTES) {
    throw new Error("safety decision receipt exceeds handoff limit")
  }
  return serialized
}
