import type {
  ResourceCreateInput,
  ResourceLifecycle,
  ResourceRegistration,
  ResourceUpdateInput,
  ResourcePublicationEndpointInput,
  ReviewPublicationRequestInput,
} from "./contract"
import type { ResourcePublicationRequest } from "./publication-types"
import type { SqlTransaction } from "../../persistence/sql-adapter"

export interface ListResourcesInput {
  tenantId: string
  authorization?: string
}

export interface GetResourceInput extends ListResourcesInput {
  resourceId: string
}

export interface ResourceCatalog {
  listResources(input: ListResourcesInput): Promise<ResourceRegistration[]>
  getResource(input: GetResourceInput): Promise<ResourceRegistration>
}

export interface PublicationDnsVerifier {
  targetForGateway?: (gatewayId: string) => string | null
  verify(input: {
    tenantId: string
    resourceId: string
    hostname: string
    dnsTarget: string | null
    gatewayId: string
  }): Promise<boolean> | boolean
}

export interface ResourceLifecycleReleasePublisher {
  reconcileInTransaction(input: {
    transaction: SqlTransaction
    tenantId: string
    gatewayId: string
    issuedAt: number
  }): Promise<void>
}

export interface ResourceRegistry {
  listResources(input: ListResourcesInput): Promise<ResourceRegistration[]>
  getResource(input: { tenantId: string; resourceId: string }): Promise<ResourceRegistration>
  createResource(input: {
    tenantId: string
    value: ResourceCreateInput
    resourceId?: string
  }): Promise<ResourceRegistration>
  updateResource(input: {
    tenantId: string
    resourceId: string
    value: ResourceUpdateInput
  }): Promise<ResourceRegistration>
  setLifecycle(input: {
    tenantId: string
    resourceId: string
    lifecycle: ResourceLifecycle
  }): Promise<ResourceRegistration>
  setPublicationEndpoint(input: {
    tenantId: string
    resourceId: string
    value: ResourcePublicationEndpointInput
  }): Promise<ResourceRegistration>
  requestPublication(input: {
    tenantId: string
    resourceId: string
    requestedBy: string
  }): Promise<ResourcePublicationRequest>
  reviewPublication(input: {
    tenantId: string
    resourceId: string
    requestId: string
    value: ReviewPublicationRequestInput
  }): Promise<ResourceRegistration>
}
