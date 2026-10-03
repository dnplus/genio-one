import { PlatformApiError } from "../errors"
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
  getLatestPolicy(input: { tenant_id: string; usage_policy_id: string }): Promise<UsagePolicyRevision | null>
  listActivePolicies(input: { tenant_id: string; owner_organization_ids?: readonly string[] }): Promise<UsagePolicyRevision[]>
}

export function assertUsagePolicyRevision(value: UsagePolicyRevision, previous: UsagePolicyRevision | null): void {
  if (previous && value.owner_organization_id !== previous.owner_organization_id) {
    throw new PlatformApiError("USAGE_POLICY_OWNER_IMMUTABLE", 409)
  }
  if (previous && value.accounting_key_id !== previous.accounting_key_id) {
    throw new PlatformApiError("USAGE_POLICY_ACCOUNTING_KEY_IMMUTABLE", 409)
  }
  if (previous && value.revision <= previous.revision) {
    throw new PlatformApiError("USAGE_POLICY_REVISION_EXISTS", 409)
  }
  if (value.revision !== (previous?.revision ?? 0) + 1) {
    throw new PlatformApiError("USAGE_POLICY_REVISION_INVALID", 409)
  }
}

export function createInMemoryUsageGovernanceDirectory(): UsageGovernanceDirectory {
  const useCases = new Map<string, UseCase>()
  const policies = new Map<string, UsagePolicyRevision>()
  const getLatestPolicy = (input: { tenant_id: string; usage_policy_id: string }) =>
    [...policies.values()]
      .filter((policy) => policy.tenant_id === input.tenant_id && policy.usage_policy_id === input.usage_policy_id)
      .sort((left, right) => right.revision - left.revision)[0] ?? null
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
      const key = JSON.stringify([value.tenant_id, value.usage_policy_id, value.revision])
      assertUsagePolicyRevision(value, getLatestPolicy(value))
      policies.set(key, structuredClone(value))
      return structuredClone(value)
    },
    async getLatestPolicy(input) {
      return structuredClone(getLatestPolicy(input))
    },
    async listActivePolicies(input) {
      const latest = new Map<string, UsagePolicyRevision>()
      for (const policy of policies.values()) {
        if (policy.tenant_id !== input.tenant_id) continue
        const previous = latest.get(policy.usage_policy_id)
        if (!previous || previous.revision < policy.revision) latest.set(policy.usage_policy_id, policy)
      }
      return [...latest.values()].filter((policy) => policy.state === "ACTIVE" &&
        (input.owner_organization_ids === undefined || input.owner_organization_ids.includes(policy.owner_organization_id)))
        .sort((left, right) => left.usage_policy_id.localeCompare(right.usage_policy_id))
        .map((policy) => structuredClone(policy))
    },
  }
}
