import type { HandsProvider } from "./hands"

export type HandsExecutionDomain = "ON_PREM" | "MANAGED_CLOUD"

export interface HandsExecutionPlacementConstraint {
  kind: "execution_placement"
  parameters: { execution_domain: HandsExecutionDomain }
}

export function isHandsExecutionPlacementTarget(runtimeId: string, capabilityId: string, action: string): boolean {
  return runtimeId === "codex" && capabilityId === "remote_hands.use" && action === "use"
}

export function handsProviderDomain(provider: HandsProvider): HandsExecutionDomain {
  if (provider === "e2b-self-hosted") return "ON_PREM"
  if (provider === "cloudflare-hands") return "MANAGED_CLOUD"
  throw new Error("HANDS_PROVIDER_INVALID")
}

export function handsProviderForDomain(domain: HandsExecutionDomain): HandsProvider {
  if (domain === "ON_PREM") return "e2b-self-hosted"
  if (domain === "MANAGED_CLOUD") return "cloudflare-hands"
  throw new Error("POLICY_PLACEMENT_INVALID")
}

export function readHandsExecutionPlacement(constraints: readonly { kind: string; parameters: unknown }[]): HandsExecutionDomain | null {
  let domain: HandsExecutionDomain | null = null
  for (const constraint of constraints) {
    if (constraint.kind !== "execution_placement") throw new Error("RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED")
    const parameters = constraint.parameters
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("POLICY_PLACEMENT_INVALID")
    const values = Object.entries(parameters)
    if (values.length !== 1 || values[0]?.[0] !== "execution_domain") throw new Error("POLICY_PLACEMENT_INVALID")
    const next = values[0][1]
    if (next !== "ON_PREM" && next !== "MANAGED_CLOUD") throw new Error("POLICY_PLACEMENT_INVALID")
    if (domain !== null && domain !== next) throw new Error("POLICY_PLACEMENT_CONFLICT")
    domain = next
  }
  return domain
}
