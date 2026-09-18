import type {
  GatewayProjection,
  GatewayProjectionRepository,
  GatewayProjectionSnapshot,
  GatewayProjectionSource,
} from "../gateway-projection/contract"
import type { GatewayProjector } from "../gateway-projection/module"
import type {
  EnforcementChainRevision,
  EnforcementChainRevisionReader,
} from "../enforcement/module"
import type {
  ConnectionRegistration,
} from "../connections/contract"
import type { ResourceRegistry } from "../resources/module"
import type {
  ResourceRegistration,
} from "../resources/contract"
import type { ResourcePublicationRequest } from "../resources/publication-types"
import type { PublicModelCatalog } from "../models/module"
import type { ResourceConnectionRegistry } from "../connections/module"
import type {
  PublicationReviewDecision,
  PublicationWorkflowRequest,
} from "./contract"
import type { ProviderCredentialProfileStore } from "../provider-credentials/module"

/**
 * The publication aggregate owns the long-running build boundary. Resource
 * CRUD stays in the Resource capability; this seam only records the review
 * snapshot and commits a signed projection after a successful build.
 */
export interface PublicationWorkflowStore
  extends GatewayProjectionSource, GatewayProjectionRepository {
  preparePublicationReference(input: {
    tenantId: string
    resourceId: string
  }): Promise<PublicationReference | null>

  getRequest(input: {
    tenantId: string
    resourceId: string
    requestId: string
  }): Promise<ResourcePublicationRequest | null>

  saveReviewSnapshot(input: {
    tenantId: string
    resourceId: string
    request: ResourcePublicationRequest
    snapshot: GatewayProjectionSnapshot
  }): Promise<ResourcePublicationRequest>

  claimBuild(input: {
    tenantId: string
    resourceId: string
    requestId: string
    reviewerId: string
    reviewedAt: number
  }): Promise<PublicationBuildClaim>

  markBuildFailed(input: {
    tenantId: string
    resourceId: string
    requestId: string
    attemptId: string
    failureCode: string
  }): Promise<void>

  reject(input: {
    tenantId: string
    resourceId: string
    requestId: string
    reviewerId: string
    reviewedAt: number
  }): Promise<ResourceRegistration>

  commitBuild(input: {
    tenantId: string
    resourceId: string
    requestId: string
    attemptId: string
    reviewerId: string
    reviewedAt: number
    projection: GatewayProjection
  }): Promise<ResourceRegistration>
}

export interface PublicationReference {
  publicationId: string
  endpointRevision: number
  resourceRevision: number
  resourceDigest: string
}

export interface PublicationBuildClaim {
  attemptId: string
  snapshot: GatewayProjectionSnapshot
  state: "BUILDING" | "READY"
}

/** A saved-chain lookup; a missing chain is a publication validation error. */
export interface EnforcementChainReader extends EnforcementChainRevisionReader {}

export interface AiResourcePublicationWorkflow {
  /** Validate and snapshot a Resource for the platform review queue. */
  requestReview(input: {
    tenantId: string
    resourceId: string
    requestedBy: string
  }): Promise<PublicationWorkflowRequest>

  /**
   * Rejects immediately, or claims an immutable build, compiles outside the
   * transaction, and atomically commits the signed projection and lifecycle.
   */
  review(input: {
    tenantId: string
    resourceId: string
    requestId: string
    reviewerId: string
    decision: PublicationReviewDecision
  }): Promise<ResourceRegistration>

  /** The compiler uses the same persisted snapshot source as the workflow. */
  readonly projectionSource: GatewayProjectionSource
}

export interface AiResourcePublicationWorkflowOptions {
  resources: ResourceRegistry
  connections: ResourceConnectionRegistry
  providerCredentials?: ProviderCredentialProfileStore
  models: PublicModelCatalog
  chains: EnforcementChainReader
  store: PublicationWorkflowStore
  projector: GatewayProjector
  now?: () => number
  idFactory?: (prefix: string) => string
  /** Test/diagnostic hook to observe BUILDING while Resource stays DRAFT. */
  onBuildClaimed?: (claim: PublicationBuildClaim) => Promise<void> | void
}

export interface PublicationSnapshotSummary {
  resource: ResourceRegistration
  connections: ConnectionRegistration[]
  models: Awaited<ReturnType<PublicModelCatalog["list"]>>
  chain: EnforcementChainRevision
}
