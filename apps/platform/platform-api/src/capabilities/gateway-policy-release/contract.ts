import type { CompiledAuthorizationBundle } from "@genioone/protocol/authorization"
import type { ProcessorPolicyBundle } from "../../../../../../runtimes/gateway/services/processor/contract"
import type { VerificationKeyRing } from "@genioone/protocol/compact-jws"
import type {
  PolicyReleaseGatewayConfiguration,
  PolicyReleaseManifest,
  PolicyReleaseProjectionReference,
} from "../../../../../../runtimes/gateway/services/shared/policy-release"
import type { GatewayRoutingArtifact } from "../../../../../../runtimes/gateway/services/shared/gateway-routing-artifact"

export {
  POLICY_RELEASE_FILES,
} from "../../../../../../runtimes/gateway/services/shared/policy-release"
export type {
  PolicyReleaseManifest,
  PolicyReleaseGatewayConfiguration,
  PolicyReleaseProjectionReference,
  PolicyReleaseTarget,
} from "../../../../../../runtimes/gateway/services/shared/policy-release"
export type { GatewayRoutingArtifact } from "../../../../../../runtimes/gateway/services/shared/gateway-routing-artifact"
export type {
  ProcessorBuiltinConfig,
  ProcessorHook,
  ProcessorPolicy,
  ProcessorPolicyBundle,
  ProcessorPolicyStep,
  ProcessorPolicyScope,
} from "../../../../../../runtimes/gateway/services/processor/contract"

/** The input uses the CP's snake_case naming; the runtime loader uses its
 * camelCase target adapter when it consumes the emitted manifest. */
export interface GatewayPolicyReleaseTarget {
  tenant_id: string
  runtime_id: string
  gateway_id: string
}

export type GatewayProjectionReleaseReference =
  PolicyReleaseProjectionReference

export type ReleaseVerificationKey = VerificationKeyRing["keys"][number]
export type ReleaseVerificationKeyRing = VerificationKeyRing

export interface CompactJwsSigner {
  readonly algorithm: "EdDSA"
  readonly keyId: string
  sign(payload: Uint8Array): Promise<string> | string
}

export interface GatewayPolicyReleaseInput {
  target: GatewayPolicyReleaseTarget
  issued_at: number
  expires_at: number
  /** The complete Gateway-level closed set, not one separately mutable item. */
  projections: readonly GatewayProjectionReleaseReference[]
  authorization_bundle: CompiledAuthorizationBundle
  processor_policy: ProcessorPolicyBundle
  /** Runtime-neutral, signed model routing input for this Gateway release. */
  gateway_routing_artifact: GatewayRoutingArtifact
  gateway_configuration?: PolicyReleaseGatewayConfiguration
  enforcement_verification_keys: ReleaseVerificationKeyRing
  /** Signs the policy artifact JWS documents. */
  artifact_signer: CompactJwsSigner
  /** Signs the per-runtime manifest with a key outside the release directory. */
  release_root_signer: CompactJwsSigner
}

export interface ReleaseFileArtifact {
  file_name: string
  bytes: Uint8Array
  sha256: string
  key_id?: string
}

export interface GatewayPolicyReleasePlan {
  release_id: string
  /** Relative path under the policy root: `releases/<release_id>`. */
  release_directory: string
  target: GatewayPolicyReleaseTarget
  manifest: PolicyReleaseManifest
  manifest_jws: ReleaseFileArtifact
  authorization_bundle: ReleaseFileArtifact
  processor_policy: ReleaseFileArtifact
  gateway_routing_artifact: ReleaseFileArtifact
  enforcement_verification_keys: ReleaseFileArtifact
}
