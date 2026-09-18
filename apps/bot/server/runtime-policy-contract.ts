import type { GenioPrincipal } from "./runtime-broker"

export const RUNTIME_POLICY_RUNTIME_ID = "codex" as const
export const RUNTIME_POLICY_RESOURCE_ID = "genio.personal-bot" as const
export const RUNTIME_POLICY_CAPABILITY_IDS = [
  "codex.subscription",
  "model.invoke",
  "shell.exec",
  "filesystem.read",
  "filesystem.write",
  "browser.open",
  "web_search.query",
] as const

export const RUNTIME_POLICY_ACTIONS = [
  "expose",
  "invoke",
  "load_extension",
  "use",
  "execute",
] as const

export type RuntimePolicyCapabilityId = (typeof RUNTIME_POLICY_CAPABILITY_IDS)[number]
export type RuntimePolicyAction = (typeof RUNTIME_POLICY_ACTIONS)[number]
export type RuntimePolicyDecisionEffect = "ALLOW" | "DENY"
export type RuntimePolicyObservedOutcome = "ALLOW" | "DENY" | "COMPLETED" | "FAILED"

export interface RuntimePolicyConstraint {
  kind: string
  parameters: Record<string, unknown>
}

export interface RuntimePolicyDecision {
  tenant_id: string
  subject_id: string
  client_id: string
  bot_id: string
  runtime_id: string
  policy_id: string | null
  policy_display_name: string | null
  policy_revision: number | null
  capability_id: string
  action: RuntimePolicyAction
  target: string
  decision: RuntimePolicyDecisionEffect
  reason_code: string
  constraints: RuntimePolicyConstraint[]
  obligations: Array<{
    kind: string
    enforcement_point_id?: string
    parameters: Record<string, unknown>
  }>
  correlation_id: string | null
  session_id: string | null
  evaluated_at: number
}

export interface RuntimePolicySnapshot {
  tenant_id: string
  subject_id: string
  client_id: string
  bot_id: string
  runtime_id: string
  policy_id: string | null
  policy_display_name: string | null
  policy_revision: number | null
  decisions: RuntimePolicyDecision[]
}

export interface RuntimePolicyResolveInput {
  principal: GenioPrincipal
  botId: string
  runtimeId?: string
  capabilityId: string
  action: RuntimePolicyAction
  sessionId?: string
  correlationId?: string
  accessToken?: string
}

export interface RuntimePolicyReadInput {
  principal: GenioPrincipal
  botId: string
  runtimeId?: string
  capabilityIds?: readonly string[]
  action?: RuntimePolicyAction
  sessionId?: string
  accessToken?: string
}

export interface RuntimePolicyReportInput extends RuntimePolicyResolveInput {
  correlationId: string
  outcome: RuntimePolicyObservedOutcome
  reasonCode?: string
}

export interface RuntimePolicyResolver {
  resolve(input: RuntimePolicyResolveInput): Promise<RuntimePolicyDecision>
  authorize(input: RuntimePolicyResolveInput): Promise<RuntimePolicyDecision>
  read(input: RuntimePolicyReadInput): Promise<RuntimePolicySnapshot>
  report(input: RuntimePolicyReportInput): Promise<void>
}
