import type { SqlTransaction } from "../../persistence/sql-adapter"
import type {
  GatewayPolicyReleasePlan,
  GatewayPolicyReleaseTarget,
  GatewayProjectionReleaseReference,
  PolicyReleaseManifest,
  ReleaseFileArtifact,
} from "./contract"

export interface GatewayPolicyReleaseRecord {
  tenant_id: string
  release_id: string
  gateway_id: string
  policy_artifact_revision: string
  policy_version: string
  issued_at: number
  expires_at: number
  content_digest: string
  projection_set_digest: string
  projections: readonly GatewayProjectionReleaseReference[]
  authorization_bundle: ReleaseFileArtifact
  processor_policy: ReleaseFileArtifact
  gateway_routing_artifact: ReleaseFileArtifact
  enforcement_verification_keys: ReleaseFileArtifact
  created_at: number
  updated_at: number
}

export interface GatewayPolicyReleaseManifestRecord {
  tenant_id: string
  release_id: string
  runtime_id: string
  gateway_id: string
  manifest: PolicyReleaseManifest
  manifest_jws: ReleaseFileArtifact
  created_at: number
  updated_at: number
}

export interface GatewayPolicyReleaseHead {
  tenant_id: string
  gateway_id: string
  release_id: string
  content_digest: string
  head_revision: number
  updated_at: number
}

export interface SavedGatewayPolicyRelease {
  release: GatewayPolicyReleaseRecord
  target: GatewayPolicyReleaseTarget
  manifest: GatewayPolicyReleaseManifestRecord
  head: GatewayPolicyReleaseHead
}

/**
 * The caller supplies the already-resolved active projection set.  The store
 * never chooses a MAX revision or silently expands the set.
 */
export interface SaveGatewayPolicyReleaseInput {
  plan: GatewayPolicyReleasePlan
  /** Null means that this is the first release for the tenant/gateway pair. */
  expectedHeadRevision: number | null
}

export interface GatewayPolicyReleaseStore {
  save(input: SaveGatewayPolicyReleaseInput): Promise<SavedGatewayPolicyRelease>
  /** Join an existing publication/runtime transaction without opening another. */
  saveInTransaction(
    input: SaveGatewayPolicyReleaseInput & { transaction: SqlTransaction },
  ): Promise<SavedGatewayPolicyRelease>
  get(input: {
    tenantId: string
    releaseId: string
  }): Promise<GatewayPolicyReleaseRecord | null>
  getManifest(input: {
    tenantId: string
    releaseId: string
    runtimeId: string
  }): Promise<GatewayPolicyReleaseManifestRecord | null>
  getHead(input: {
    tenantId: string
    gatewayId: string
  }): Promise<GatewayPolicyReleaseHead | null>
  /** Read and lock the current head inside the caller's publication transaction. */
  getHeadInTransaction(input: {
    transaction: SqlTransaction
    tenantId: string
    gatewayId: string
  }): Promise<GatewayPolicyReleaseHead | null>
}
