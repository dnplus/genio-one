import type { EntitlementResolver } from "../tenancy-auth/contract"
import type { GrantModelEntitlementInput, ModelEntitlement } from "./contract"

/** AI model grants are the first concrete Entitlement projection. */
export interface ModelEntitlementCatalog extends EntitlementResolver {
  list(input: { tenantId: string }): Promise<ModelEntitlement[]>
  grant(input: {
    tenantId: string
    value: GrantModelEntitlementInput
    idempotencyKey?: string
  }): Promise<ModelEntitlement>
  revoke(input: {
    tenantId: string
    entitlementId: string
  }): Promise<ModelEntitlement>
}
