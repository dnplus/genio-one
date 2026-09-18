import { BotRulesSchema } from "./drafts"
import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const PolicyId = Type.Literal("one-policy.first-party.bot-default")
const PolicyRevision = Type.Integer({ minimum: 1 })

export const OnePolicyBotCapabilitySchema = Type.Union([
  Type.Literal("personal_bot.use"),
  Type.Literal("personal_bot.computer_use"),
])

export const OnePolicyBotSeedSchema = Type.Object({
  tenant_id: Identifier,
  policy_id: PolicyId,
  policy_revision: PolicyRevision,
  seed: Type.Literal(true),
  rules: BotRulesSchema,
  enabled: Type.Boolean(),
  created_at: Type.Integer({ minimum: 0 }),
  updated_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const OnePolicyBotDecisionSchema = Type.Object({
  tenant_id: Identifier,
  subject_id: Identifier,
  client_id: Identifier,
  resource_id: Type.Literal("genio.personal-bot"),
  capability_id: OnePolicyBotCapabilitySchema,
  decision: Type.Union([Type.Literal("ALLOW"), Type.Literal("DENY")]),
  policy_id: PolicyId,
  policy_revision: PolicyRevision,
  model_route: Type.Union([Type.Literal("codex-subscription"), Type.Null()]),
  reason_code: Identifier,
}, { additionalProperties: false })

export type OnePolicyBotCapability = Static<typeof OnePolicyBotCapabilitySchema>
export type OnePolicyBotSeed = Static<typeof OnePolicyBotSeedSchema>
export type OnePolicyBotDecision = Static<typeof OnePolicyBotDecisionSchema>
