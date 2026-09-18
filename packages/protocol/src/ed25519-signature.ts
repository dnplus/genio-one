import { Type, type Static } from "typebox"
import { Check } from "typebox/value"

export const Ed25519SignatureSchema = Type.Object({
  algorithm: Type.Literal("Ed25519"),
  key_id: Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^[^\\u0000\\r\\n]+$",
  }),
  value: Type.String({ pattern: "^[A-Za-z0-9_-]{86}$" }),
}, { additionalProperties: false })

export type Ed25519Signature = Static<typeof Ed25519SignatureSchema>

export function isEd25519Signature(value: unknown): value is Ed25519Signature {
  return Check(Ed25519SignatureSchema, value)
}
