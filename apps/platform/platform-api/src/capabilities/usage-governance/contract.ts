import type {
  UsagePolicyLimits,
  UsagePolicySelectors,
} from "../../../../../../runtimes/gateway/services/shared/usage-governance"

export type {
  CurrencyAllocation,
  UsageAdmissionDecision,
  UsageAdmissionReason,
  UsageDecisionContext,
  UsagePolicyLimits,
  UsagePolicySelectors,
} from "../../../../../../runtimes/gateway/services/shared/usage-governance"
export type {
  CanonicalCharge,
  CostValuation,
  InvocationAccounting,
  UsageQuantity,
} from "../../../../../../runtimes/gateway/services/shared/usage-accounting"

export interface UsagePolicyRevision {
  usage_policy_id: string
  display_name?: string
  revision: number
  tenant_id: string
  owner_organization_id: string
  accounting_key_id: string
  selectors: UsagePolicySelectors
  limits: UsagePolicyLimits
  state: "DRAFT" | "ACTIVE" | "RETIRED"
  created_at: number
}
