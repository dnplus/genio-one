import type { GenioPrincipal } from "./runtime-broker"
import type { HandsProvider } from "@genioone/protocol/hands"
import {
  RUNTIME_CAPABILITY_IDS,
  RUNTIME_POLICY_ACTIONS,
  isRuntimeCapabilityAction,
  isRuntimeCapabilityId,
  type RuntimeCapabilityAction,
  type RuntimeCapabilityId,
  type RuntimePolicyAction,
} from "@genioone/protocol/runtime-capability-actions"

export const RUNTIME_POLICY_RUNTIME_ID = "codex" as const
export const RUNTIME_POLICY_RESOURCE_ID = "genio.personal-bot" as const
export { RUNTIME_CAPABILITY_IDS as RUNTIME_POLICY_CAPABILITY_IDS, RUNTIME_POLICY_ACTIONS }
export type RuntimePolicyCapabilityId = RuntimeCapabilityId
export type RuntimePolicyExecutableAction = RuntimeCapabilityAction
export type { RuntimePolicyAction }
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
  capabilityId: RuntimePolicyCapabilityId
  action: RuntimePolicyExecutableAction
  sessionId?: string
  correlationId?: string
  accessToken?: string
  handsPlacement?: { mode: "inspect" } | { mode: "enforce"; provider: HandsProvider } | { mode: "enforce"; localEndpoint: true }
}

export interface RuntimePolicyReadInput {
  principal: GenioPrincipal
  botId: string
  runtimeId?: string
  capabilityIds?: readonly RuntimePolicyCapabilityId[]
  action?: RuntimePolicyExecutableAction
  sessionId?: string
  accessToken?: string
}

export interface RuntimePolicyReportInput extends RuntimePolicyResolveInput {
  correlationId: string
  outcome: RuntimePolicyObservedOutcome
  reasonCode?: string
}

export function runtimePolicyDecisionTarget(decision: Pick<RuntimePolicyDecision, "capability_id" | "action">): {
  capabilityId: RuntimePolicyCapabilityId
  action: RuntimePolicyExecutableAction
} {
  if (!isRuntimeCapabilityId(decision.capability_id) || !isRuntimeCapabilityAction(decision.capability_id, decision.action)) {
    throw new Error("RUNTIME_POLICY_RESPONSE_INVALID")
  }
  return { capabilityId: decision.capability_id, action: decision.action }
}

export interface RuntimePolicyResolver {
  resolve(input: RuntimePolicyResolveInput): Promise<RuntimePolicyDecision>
  authorize(input: RuntimePolicyResolveInput): Promise<RuntimePolicyDecision>
  read(input: RuntimePolicyReadInput): Promise<RuntimePolicySnapshot>
  report(input: RuntimePolicyReportInput): Promise<void>
}
