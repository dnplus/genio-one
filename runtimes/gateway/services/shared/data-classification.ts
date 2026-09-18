import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })

export const DataClassificationReceiptSchema = Type.Object({
  classification: Identifier,
  handling_action: Type.Union([
    Type.Literal("BLOCK"),
    Type.Literal("REDACT"),
    Type.Literal("TOKENIZE"),
  ]),
  source: Type.Literal("DLP_DETECTOR"),
  source_version: Identifier,
  trust_level: Type.Literal("RUNTIME_OBSERVED"),
  step_id: Identifier,
}, { additionalProperties: false })

export type DataClassificationReceipt = Static<typeof DataClassificationReceiptSchema>

function receiptKey(receipt: DataClassificationReceipt): string {
  return [
    receipt.classification,
    receipt.handling_action,
    receipt.source,
    receipt.source_version,
    receipt.trust_level,
    receipt.step_id,
  ].join("\u0000")
}

export function mergeDataClassificationReceipts(
  target: DataClassificationReceipt[],
  values: readonly DataClassificationReceipt[],
): void {
  const keys = new Set(target.map(receiptKey))
  for (const value of values) {
    const key = receiptKey(value)
    if (keys.has(key)) continue
    target.push(value)
    keys.add(key)
  }
}
