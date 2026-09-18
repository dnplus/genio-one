export interface InvocationAccounting {
  invocation_id: string
  correlation_id: string
  tenant_id: string
  subject_id: string
  consumer_organization_id: string
  resource_owner_organization_id: string
  resource_id: string
  capability_id: string
  use_case_id: string
  usage_policy_revisions: string[]
  release_revision: string
  accounting_key_id: string
  created_at: number
}

export interface UsageQuantity {
  quantity_id: string
  invocation_id: string
  quantity: number
  unit: string
  trusted_source: string
  observed_at: number
}

export interface CanonicalCharge {
  charge_id: string
  invocation_id: string
  correlation_id: string
  accounting_key_id: string
  created_at: number
}

export interface CostValuation {
  valuation_id: string
  charge_id: string
  status: "ESTIMATED" | "ACTUAL"
  currency: string
  amount_micros: number
  pricing_source: string
  pricing_version: string
  valued_at: number
}
