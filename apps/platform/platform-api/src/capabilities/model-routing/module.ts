import type {
  ModelRouteLease,
  ResolveModelRouteInput,
} from "./contract"
import type {
  CreateModelRoutingPolicyInput,
  ModelRoutingPolicy,
} from "./contract"
import type { SqlTransaction } from "../../persistence/sql-adapter"

export interface ModelRouter {
  resolve(input: {
    tenantId: string
    value: ResolveModelRouteInput
  }): Promise<ModelRouteLease>
}

export interface ModelRoutingPolicyScope {
  tenantId: string
  ownerOrganizationId: string
  resourceId: string
  capabilityId: string
}

export interface ModelRoutingPolicyRevisionKey extends ModelRoutingPolicyScope {
  routingRevision: number
}

export interface ModelRoutingPolicyReleasePublisher {
  reconcileInTransaction(input: {
    transaction: SqlTransaction
    tenantId: string
    gatewayId: string
    issuedAt: number
  }): Promise<void>
}

/**
 * Immutable policy revisions are addressed by their full tenant,
 * organization, Resource, capability and revision scope. There is no
 * cross-organization lookup by routing_policy_id alone.
 */
export interface ModelRoutingPolicyStore {
  save(input: {
    tenantId: string
    value: CreateModelRoutingPolicyInput
  }): Promise<ModelRoutingPolicy>
  get(input: ModelRoutingPolicyRevisionKey): Promise<ModelRoutingPolicy | null>
  getLatest(input: ModelRoutingPolicyScope): Promise<ModelRoutingPolicy | null>
  list(input: {
    tenantId: string
    ownerOrganizationId: string
    resourceId?: string
    capabilityId?: string
  }): Promise<ModelRoutingPolicy[]>
}
