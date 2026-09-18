import { Type, type Static } from "typebox"
import { Check } from "typebox/value"

export const ModelCandidateEffectSchema = Type.Union([
  Type.Literal("NARROW_ENTITLEMENT_CANDIDATES"),
  Type.Literal("SORT_ENTITLEMENT_CANDIDATES"),
])

export type ModelCandidateEffect = Static<typeof ModelCandidateEffectSchema>

export function isModelCandidateEffect(value: unknown): value is ModelCandidateEffect {
  return Check(ModelCandidateEffectSchema, value)
}
