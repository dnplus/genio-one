import type { UsagePolicyRevision } from "./contract"

export interface UseCase {
  tenant_id: string
  organization_id: string
  use_case_id: string
  display_name: string
  risk_level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
  state: "ACTIVE" | "DISABLED"
  created_at: number
}

export interface UsageGovernanceDirectory {
  createUseCase(value: UseCase): Promise<UseCase>
  listUseCases(input: { tenant_id: string; organization_id: string }): Promise<UseCase[]>
  getActiveUseCase(input: { tenant_id: string; organization_id: string; use_case_id: string }): Promise<UseCase | null>
  createPolicyRevision(value: UsagePolicyRevision): Promise<UsagePolicyRevision>
  listActivePolicies(input: { tenant_id: string }): Promise<UsagePolicyRevision[]>
}

export function createInMemoryUsageGovernanceDirectory(): UsageGovernanceDirectory {
  const useCases = new Map<string, UseCase>()
  const policies = new Map<string, UsagePolicyRevision>()
  return {
    async createUseCase(value) {
      const key = `${value.tenant_id}:${value.organization_id}:${value.use_case_id}`
      if (useCases.has(key)) throw new Error("USE_CASE_EXISTS")
      useCases.set(key, structuredClone(value))
      return structuredClone(value)
    },
    async getActiveUseCase(input) {
      const value = useCases.get(`${input.tenant_id}:${input.organization_id}:${input.use_case_id}`)
      return value?.state === "ACTIVE" ? structuredClone(value) : null
    },
    async listUseCases(input) {
      return [...useCases.values()]
        .filter((value) => value.tenant_id === input.tenant_id && value.organization_id === input.organization_id)
        .sort((left, right) => left.display_name.localeCompare(right.display_name))
        .map((value) => structuredClone(value))
    },
    async createPolicyRevision(value) {
      const key = `${value.tenant_id}:${value.usage_policy_id}:${value.revision}`
      if (policies.has(key)) throw new Error("USAGE_POLICY_REVISION_EXISTS")
      const previous = [...policies.values()]
        .filter((policy) => policy.tenant_id === value.tenant_id && policy.usage_policy_id === value.usage_policy_id)
        .sort((left, right) => right.revision - left.revision)[0]
      if (previous && value.revision !== previous.revision + 1) throw new Error("USAGE_POLICY_REVISION_INVALID")
      if (!previous && value.revision !== 1) throw new Error("USAGE_POLICY_REVISION_INVALID")
      policies.set(key, structuredClone(value))
      return structuredClone(value)
    },
    async listActivePolicies(input) {
      const latest = new Map<string, UsagePolicyRevision>()
      for (const policy of policies.values()) {
        if (policy.tenant_id !== input.tenant_id) continue
        const previous = latest.get(policy.usage_policy_id)
        if (!previous || previous.revision < policy.revision) latest.set(policy.usage_policy_id, policy)
      }
      return [...latest.values()].filter((policy) => policy.state === "ACTIVE")
        .sort((left, right) => left.usage_policy_id.localeCompare(right.usage_policy_id))
        .map((policy) => structuredClone(policy))
    },
  }
}
