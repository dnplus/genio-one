import type { ProcessorPolicy, ProcessorPolicyStep } from "./contract"
import { validateProcessorPolicy } from "./contract"
import {
  FilePolicyReleaseLoader,
  type LoadedPolicyRelease,
  type PolicyReleaseLoaderOptions,
  type PolicyReleaseObservation,
} from "../shared/policy-release"
import {
  verifyCompactEdDsaJws,
  type VerificationKeyRing,
} from "@genioone/protocol/compact-jws"
import type { GatewayReleaseReference } from "@genioone/protocol/runtime-command"
import type { GatewayRoutingScope } from "../shared/gateway-routing-artifact"

export type ProcessorPolicyStoreOptions = PolicyReleaseLoaderOptions

export interface ProcessorPolicyScope {
  resourceId: string
  capabilityId: string
  steps: readonly ProcessorPolicyStep[]
}

export interface ProcessorPolicySnapshot {
  bundleRevision: string
  releaseId: string
  releaseReference: GatewayReleaseReference
  policyVersion: string
  captureMessageContent: boolean
  scopes: readonly ProcessorPolicyScope[]
  stepsFor(resourceId: string, capabilityId: string): readonly ProcessorPolicyStep[] | undefined
  routingScopeFor(resourceId: string, capabilityId: string): GatewayRoutingScope | undefined
}

export interface ProcessorPolicySource {
  current(): Promise<ProcessorPolicySnapshot>
}

function scopedSnapshot(release: LoadedPolicyRelease): ProcessorPolicySnapshot {
  const bundle = release.processorPolicyBundle
  const scopes = bundle.scopes.map((scope) => ({
    resourceId: scope.resource_id,
    capabilityId: scope.capability_id,
    steps: scope.steps,
  }))
  return {
    bundleRevision: bundle.revision,
    releaseId: release.releaseId,
    releaseReference: release.releaseReference,
    policyVersion: bundle.policy_version,
    captureMessageContent: release.manifest.gateway_configuration.capture_message_content,
    scopes,
    stepsFor(resourceId: string, capabilityId: string) {
      return scopes.find(
        (entry) => entry.resourceId === resourceId && entry.capabilityId === capabilityId,
      )?.steps
    },
    routingScopeFor(resourceId: string, capabilityId: string) {
      return release.gatewayRoutingArtifact.scopes.find(
        (entry) => entry.resource_id === resourceId && entry.capability_id === capabilityId,
      )
    },
  }
}

export function verifyProcessorPolicy(
  compactJws: string,
  keyRing: VerificationKeyRing,
): ProcessorPolicy {
  return validateProcessorPolicy(verifyCompactEdDsaJws(compactJws, keyRing))
}

/**
 * Processor view of the shared policy release. The authorization bundle
 * revision is carried alongside the processor policy so ext_proc can verify
 * that Envoy's ext_authz handoff came from the same release.
 */
export class FileProcessorPolicyStore implements ProcessorPolicySource {
  private readonly loader: FilePolicyReleaseLoader

  constructor(options: ProcessorPolicyStoreOptions) {
    this.loader = new FilePolicyReleaseLoader(options)
  }

  async current(): Promise<ProcessorPolicySnapshot> {
    return scopedSnapshot(await this.loader.current())
  }

  async releaseObservation(): Promise<PolicyReleaseObservation> {
    return this.loader.releaseObservation()
  }
}
