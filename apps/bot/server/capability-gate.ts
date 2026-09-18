import type { GenioPrincipal } from "./runtime-broker"

export const PERSONAL_BOT_RESOURCE = "genio.personal-bot"
export const PERSONAL_BOT_USE = "personal_bot.use"
export const PERSONAL_BOT_COMPUTER_USE = "personal_bot.computer_use"

export type CapabilityDecision = "allow" | "deny" | "requestable"
export type CapabilityGateMode = "open" | "fixture" | "control-plane"
export type BotModelRouteKind = "codex-subscription" | "genio-gateway"

export interface BotPolicyDecision {
  tenant_id: string
  subject_id: string
  client_id: string
  resource_id: string
  capability_id: string
  decision: "ALLOW" | "DENY"
  policy_id: string
  policy_revision: number
  model_route: BotModelRouteKind | null
  reason_code: string
}

export class CapabilityDeniedError extends Error {
  readonly capabilityId: string
  readonly decision: CapabilityDecision
  readonly reasonCode: string

  constructor(capabilityId: string, decision: CapabilityDecision = "deny", reasonCode?: string) {
    const fallback = decision === "requestable" ? "PERSONAL_BOT_REQUESTABLE" : "PERSONAL_BOT_NOT_ENTITLED"
    super(reasonCode?.trim() || fallback)
    this.name = "CapabilityDeniedError"
    this.capabilityId = capabilityId
    this.decision = decision
    this.reasonCode = reasonCode?.trim() || fallback
  }
}

export interface CapabilityGate {
  mode: CapabilityGateMode
  resolve(principal: GenioPrincipal, capabilityId: string, accessToken?: string): Promise<BotPolicyDecision>
  require(principal: GenioPrincipal, capabilityId: string, accessToken?: string): Promise<CapabilityDecision>
}

export interface CapabilityGateOptions {
  environment?: NodeJS.ProcessEnv
  mode?: CapabilityGateMode
  fetch?: (input: URL, init?: RequestInit) => Promise<Response>
  personalBotAllowlist?: readonly string[]
  computerUseAllowlist?: readonly string[]
}

function principalKey(principal: GenioPrincipal) {
  return `${principal.tenant_id}:${principal.subject_id}`
}

function fallbackDecision(
  principal: GenioPrincipal,
  capabilityId: string,
  decision: "ALLOW" | "DENY",
  reasonCode: string,
  modelRoute: "codex-subscription" | null,
): BotPolicyDecision {
  return {
    tenant_id: principal.tenant_id,
    subject_id: principal.subject_id,
    client_id: principal.acting_client_id,
    resource_id: PERSONAL_BOT_RESOURCE,
    capability_id: capabilityId,
    decision,
    policy_id: "one-policy.local-test",
    policy_revision: 1,
    model_route: modelRoute,
    reason_code: reasonCode,
  }
}

function policyDecision(value: unknown): BotPolicyDecision | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (
    typeof record.tenant_id !== "string" ||
    typeof record.subject_id !== "string" ||
    typeof record.client_id !== "string" ||
    typeof record.resource_id !== "string" ||
    typeof record.capability_id !== "string" ||
    (record.decision !== "ALLOW" && record.decision !== "DENY") ||
    typeof record.policy_id !== "string" ||
    typeof record.policy_revision !== "number" ||
    (record.model_route !== null && record.model_route !== "codex-subscription" && record.model_route !== "genio-gateway") ||
    typeof record.reason_code !== "string"
  ) return null
  return record as unknown as BotPolicyDecision
}

export function createCapabilityGate(options: CapabilityGateOptions = {}): CapabilityGate {
  const environment = options.environment ?? process.env
  const mode = options.mode ?? "control-plane"
  const fetcher = options.fetch ?? fetch
  const origin = environment.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
  const personalBot = new Set(options.personalBotAllowlist ?? [])
  const computerUse = new Set(options.computerUseAllowlist ?? [])

  return {
    mode,
    async resolve(principal, capabilityId, accessToken) {
      if (mode === "open") {
        return fallbackDecision(principal, capabilityId, "ALLOW", "LOCAL_TEST_OPEN", "codex-subscription")
      }
      if (mode === "fixture") {
        const list = capabilityId === PERSONAL_BOT_COMPUTER_USE ? computerUse : personalBot
        return list.has(principalKey(principal))
          ? fallbackDecision(principal, capabilityId, "ALLOW", "LOCAL_TEST_FIXTURE", "codex-subscription")
          : fallbackDecision(principal, capabilityId, "DENY", "LOCAL_TEST_FIXTURE_DENY", null)
      }

      const policyUrl = new URL(
        `/v1/tenants/${encodeURIComponent(principal.tenant_id)}/one-policy/bot-access`,
        origin,
      )
      policyUrl.searchParams.set("capability_id", capabilityId)
      try {
        const response = await fetcher(policyUrl, {
          headers: {
            accept: "application/json",
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          },
          signal: AbortSignal.timeout(2_000),
        })
        if (!response.ok) return fallbackDecision(principal, capabilityId, "DENY", "ONE_POLICY_UNAVAILABLE", null)
        const parsed = policyDecision(await response.json())
        if (!parsed || parsed.tenant_id !== principal.tenant_id || parsed.subject_id !== principal.subject_id || parsed.client_id !== principal.acting_client_id || parsed.capability_id !== capabilityId) {
          return fallbackDecision(principal, capabilityId, "DENY", "ONE_POLICY_RESPONSE_INVALID", null)
        }
        return parsed
      } catch {
        return fallbackDecision(principal, capabilityId, "DENY", "ONE_POLICY_UNAVAILABLE", null)
      }
    },
    async require(principal, capabilityId, accessToken) {
      const decision = await this.resolve(principal, capabilityId, accessToken)
      return decision.decision === "ALLOW" ? "allow" : "deny"
    },
  }
}

export async function assertCapability(
  gate: CapabilityGate,
  principal: GenioPrincipal,
  capabilityId: string,
  accessToken?: string,
): Promise<BotPolicyDecision> {
  const decision = await gate.resolve(principal, capabilityId, accessToken)
  if (decision.decision === "ALLOW") return decision
  throw new CapabilityDeniedError(capabilityId, "deny", decision.reason_code)
}
