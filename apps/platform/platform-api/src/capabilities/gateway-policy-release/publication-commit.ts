import { createHash } from "node:crypto"

import type { SqlTransaction } from "../../persistence/sql-adapter"
import type { ModelEntitlement } from "../entitlements/contract"
import type { CompiledEnforcementChain } from "../enforcement/contract"
import type { GatewayProjection } from "../gateway-projection/contract"
import type { ModelRoutingPolicy } from "../model-routing/contract"
import type { ConnectionModelMapping, PublicModel } from "../models/contract"
import type { GatewayDiagnosticSettingsSource } from "../gateway-settings/module"
import type {
  CompiledUsageContext,
  CompiledUsagePolicy,
} from "../../../../../../packages/protocol/src/authorization"
import { PlatformApiError } from "../errors"
import type {
  GatewayAggregateCommandRecord,
  GatewayAggregateReleaseScheduler,
  GatewayAggregateRuntimeSelector,
} from "../gateway-runtime-control/contract"
import type {
  CompactJwsSigner,
  GatewayProjectionReleaseReference,
  ReleaseVerificationKeyRing,
} from "./contract"
import type {
  GatewayPolicyReleaseStore,
  SavedGatewayPolicyRelease,
} from "./module"
import type { GatewayActiveProjectionSetSource } from "./active-projections"
import { compileGatewayPolicyArtifacts } from "./compiler"
import {
  buildGatewayReleasePackage,
  type GatewayReleasePackage,
} from "./package"
import { canonicalGatewayPolicyReleaseBytes, planGatewayPolicyRelease } from "./planner"
import type { GatewayPolicyInputSource } from "./policy-inputs"
import {
  compileGatewayRoutingArtifact,
  type GatewayRoutingConnectionFact,
  type GatewayRoutingPricingFact,
  type GatewayRoutingResourceOwnerRef,
} from "./routing-compiler"

export interface GatewayPublicationReleaseCommitInput {
  transaction: SqlTransaction
  tenantId: string
  gatewayId: string
  candidate: GatewayProjection
  issuedAt: number
}

export interface GatewayReleaseReconcileInput {
  transaction: SqlTransaction
  tenantId: string
  gatewayId: string
  issuedAt: number
}

export interface GatewayPublicationReleaseDelivery {
  saved: SavedGatewayPolicyRelease
  package: GatewayReleasePackage
  command: GatewayAggregateCommandRecord
}

export interface GatewayPublicationReleaseCommitResult {
  release_id: string
  deliveries: readonly GatewayPublicationReleaseDelivery[]
}

/** Joins the Publication transaction; it never opens or commits one itself. */
export interface GatewayPublicationReleaseCoordinator {
  commitInTransaction(
    input: GatewayPublicationReleaseCommitInput,
  ): Promise<GatewayPublicationReleaseCommitResult>
  reconcileInTransaction(
    input: GatewayReleaseReconcileInput,
  ): Promise<GatewayPublicationReleaseCommitResult>
}

type TransactionReleaseStore = Pick<
  GatewayPolicyReleaseStore,
  "getHeadInTransaction" | "saveInTransaction"
>

export interface GatewayPublicationReleaseCoordinatorOptions {
  activeProjections: GatewayActiveProjectionSetSource
  policyInputs: GatewayPolicyInputSource
  gatewaySettings?: GatewayDiagnosticSettingsSource
  runtimeSelector: GatewayAggregateRuntimeSelector
  releases: TransactionReleaseStore
  scheduler: GatewayAggregateReleaseScheduler
  artifactSigner: CompactJwsSigner
  releaseRootSigner: CompactJwsSigner
  verificationKeys: ReleaseVerificationKeyRing
  releaseTtlSeconds: number
  subjectAliases?: Readonly<Record<string, readonly string[]>>
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalGatewayPolicyReleaseBytes(value))
    .digest("hex")
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

function projectionReferences(
  projections: readonly GatewayProjection[],
): GatewayProjectionReleaseReference[] {
  return projections
    .map((projection) => ({
      publication_id: projection.publication_id,
      projection_id: projection.projection_id,
      revision: projection.revision,
      digest: projection.digest,
    }))
    .sort((left, right) => {
      const publicationOrder = compareUtf8(left.publication_id, right.publication_id)
      return publicationOrder !== 0
        ? publicationOrder
        : compareUtf8(left.projection_id, right.projection_id)
    })
}

function modelRoutingProjections(
  projections: readonly GatewayProjection[],
): GatewayProjection[] {
  return projections.filter((projection) =>
    projection.operation === "APPLY" &&
    projection.resources.some((resource) => resource.kind === "AIGatewayRoute"),
  )
}

function normalizedModels(models: readonly PublicModel[]): PublicModel[] {
  return [...models].sort((left, right) => compareUtf8(left.model_id, right.model_id))
}

function normalizedEntitlements(
  entitlements: readonly ModelEntitlement[],
): ModelEntitlement[] {
  return [...entitlements].sort((left, right) =>
    compareUtf8(left.entitlement_id, right.entitlement_id),
  )
}

function normalizedEnforcementChains(
  chains: readonly CompiledEnforcementChain[],
): CompiledEnforcementChain[] {
  return [...chains].sort((left, right) => {
    const resourceOrder = compareUtf8(left.resource_id, right.resource_id)
    return resourceOrder !== 0
      ? resourceOrder
      : compareUtf8(left.capability_id, right.capability_id)
  })
}

function normalizedResourceOwners(
  owners: readonly GatewayRoutingResourceOwnerRef[],
): GatewayRoutingResourceOwnerRef[] {
  return [...owners].sort((left, right) => compareUtf8(left.resource_id, right.resource_id))
}

function normalizedRoutingPolicies(
  policies: readonly ModelRoutingPolicy[],
): ModelRoutingPolicy[] {
  return [...policies].sort((left, right) => {
    const resourceOrder = compareUtf8(left.resource_id, right.resource_id)
    if (resourceOrder !== 0) return resourceOrder
    const capabilityOrder = compareUtf8(left.capability_id, right.capability_id)
    return capabilityOrder !== 0
      ? capabilityOrder
      : left.routing_revision - right.routing_revision
  })
}

function normalizedModelMappings(
  mappings: readonly ConnectionModelMapping[],
): ConnectionModelMapping[] {
  return [...mappings].sort((left, right) => compareUtf8(left.mapping_id, right.mapping_id))
}

function normalizedRoutingConnections(
  connections: readonly GatewayRoutingConnectionFact[],
): GatewayRoutingConnectionFact[] {
  return [...connections].sort((left, right) => compareUtf8(left.connection_id, right.connection_id))
}

function normalizedPricing(pricing: readonly GatewayRoutingPricingFact[]): GatewayRoutingPricingFact[] {
  return [...pricing].sort((left, right) => compareUtf8(left.mapping_id, right.mapping_id))
}

function normalizedUsagePolicies(
  policies: readonly CompiledUsagePolicy[],
): CompiledUsagePolicy[] {
  return [...policies].sort((left, right) => {
    const policyOrder = compareUtf8(left.usage_policy_id, right.usage_policy_id)
    return policyOrder !== 0 ? policyOrder : left.revision - right.revision
  })
}

function normalizedUsageContexts(
  contexts: readonly CompiledUsageContext[],
): CompiledUsageContext[] {
  return [...contexts].sort((left, right) => {
    const subjectOrder = compareUtf8(left.subject_id, right.subject_id)
    if (subjectOrder !== 0) return subjectOrder
    const organizationOrder = compareUtf8(
      left.consumer_organization_id,
      right.consumer_organization_id,
    )
    return organizationOrder !== 0
      ? organizationOrder
      : compareUtf8(left.use_case_id, right.use_case_id)
  })
}

function mergedSubjectAliases(
  configured: Readonly<Record<string, readonly string[]>>,
  persisted: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, string[]> = {}
  for (const subjectId of [...new Set([
    ...Object.keys(configured),
    ...Object.keys(persisted),
  ])].sort(compareUtf8)) {
    result[subjectId] = [...new Set([
      ...(configured[subjectId] ?? []),
      ...(persisted[subjectId] ?? []),
    ])].sort(compareUtf8)
  }
  return result
}

function policyRevision(input: {
  projections: readonly GatewayProjection[]
  enforcementChains: readonly CompiledEnforcementChain[]
  publicModels: readonly PublicModel[]
  entitlements: readonly ModelEntitlement[]
  resourceOwners: readonly GatewayRoutingResourceOwnerRef[]
  routingPolicies: readonly ModelRoutingPolicy[]
  modelMappings: readonly ConnectionModelMapping[]
  connections: readonly GatewayRoutingConnectionFact[]
  usagePolicies: readonly CompiledUsagePolicy[]
  usageContexts: readonly CompiledUsageContext[]
  pricing: readonly GatewayRoutingPricingFact[]
  captureMessageContent: boolean
  subjectAliases: Readonly<Record<string, readonly string[]>>
  subjectContexts: readonly import("../../../../../../packages/protocol/src/authorization").CompiledSubjectContext[]
  agentDelegations: readonly import("../../../../../../packages/protocol/src/authorization").CompiledAgentDelegation[]
  executionGrants: readonly import("../../../../../../packages/protocol/src/authorization").CompiledExecutionGrant[]
}): string {
  return `policy-${sha256({
    projections: projectionReferences(input.projections),
    enforcement_chains: input.enforcementChains,
    public_models: input.publicModels,
    entitlements: input.entitlements,
    resource_owners: input.resourceOwners,
    routing_policies: input.routingPolicies,
    model_mappings: input.modelMappings,
    connections: input.connections,
    usage_policies: input.usagePolicies,
    usage_contexts: input.usageContexts,
    pricing: input.pricing,
    gateway_configuration: {
      capture_message_content: input.captureMessageContent,
    },
    subject_aliases: input.subjectAliases,
    subject_contexts: input.subjectContexts,
    agent_delegations: input.agentDelegations,
    execution_grants: input.executionGrants,
  })}`
}

function assertOptions(options: GatewayPublicationReleaseCoordinatorOptions): void {
  if (!Number.isSafeInteger(options.releaseTtlSeconds) || options.releaseTtlSeconds < 1) {
    throw new Error("releaseTtlSeconds must be a positive integer")
  }
  if (
    options.artifactSigner === options.releaseRootSigner ||
    options.artifactSigner.keyId === options.releaseRootSigner.keyId
  ) {
    throw new Error("artifact and release-root signing roles must use distinct keys")
  }
}

/**
 * Build, persist, package, and enqueue one immutable aggregate release before
 * the owning Publication is allowed to transition to Published.
 */
export function createGatewayPublicationReleaseCoordinator(
  options: GatewayPublicationReleaseCoordinatorOptions,
): GatewayPublicationReleaseCoordinator {
  assertOptions(options)
  async function commit(
    input: GatewayReleaseReconcileInput & { candidate?: GatewayProjection },
  ): Promise<GatewayPublicationReleaseCommitResult> {
      if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) {
        throw new Error("issuedAt must be a non-negative integer timestamp")
      }
      const projections = await options.activeProjections.listActiveForGatewayInTransaction({
        transaction: input.transaction,
        tenantId: input.tenantId,
        gatewayId: input.gatewayId,
        candidate: input.candidate,
      })
      const group = await options.runtimeSelector.selectGatewayGroupInTransaction({
        transaction: input.transaction,
        tenantId: input.tenantId,
        gatewayId: input.gatewayId,
      })
      if (
        group.tenant_id !== input.tenantId ||
        group.gateway_id !== input.gatewayId
      ) {
        throw new PlatformApiError("RUNTIME_RELEASE_TARGET_MISMATCH", 409)
      }
      const snapshot = await options.policyInputs.loadForGatewayInTransaction({
        transaction: input.transaction,
        tenantId: input.tenantId,
        candidateResourceId: input.candidate?.resource_id,
        projections,
      })
      const gatewaySettings = options.gatewaySettings
        ? await options.gatewaySettings.getInTransaction({
            transaction: input.transaction,
            tenantId: input.tenantId,
            gatewayId: input.gatewayId,
          })
        : { capture_message_content: false }
      const publicModels = normalizedModels(snapshot.public_models)
      const enforcementChains = normalizedEnforcementChains(snapshot.enforcement_chains)
      const entitlements = normalizedEntitlements(snapshot.entitlements)
      const resourceOwners = normalizedResourceOwners(snapshot.resource_owners)
      const routingPolicies = normalizedRoutingPolicies(snapshot.routing_policies)
      const modelMappings = normalizedModelMappings(snapshot.model_mappings)
      const routingConnections = normalizedRoutingConnections(snapshot.connections ?? [])
      const usagePolicies = normalizedUsagePolicies((snapshot.usage_policies ?? []).map((policy) => ({
        usage_policy_id: policy.usage_policy_id,
        revision: policy.revision,
        accounting_key_id: policy.accounting_key_id,
        selectors: policy.selectors,
        limits: policy.limits,
      })))
      const usageContexts = normalizedUsageContexts(snapshot.usage_contexts ?? [])
      const pricing = normalizedPricing(snapshot.pricing ?? [])
      const subjectAliases = mergedSubjectAliases(
        options.subjectAliases ?? {},
        snapshot.subject_aliases ?? {},
      )
      const subjectContexts = [...(snapshot.subject_contexts ?? [])]
        .sort((left, right) => compareUtf8(left.subject_id, right.subject_id))
      const agentDelegations = [...(snapshot.agent_delegations ?? [])]
        .sort((left, right) => compareUtf8(left.delegation_id, right.delegation_id))
      const executionGrants = [...(snapshot.execution_grants ?? [])]
        .sort((left, right) => compareUtf8(left.execution_grant_id, right.execution_grant_id))
      const revision = policyRevision({
        projections,
        enforcementChains,
        publicModels,
        entitlements,
        resourceOwners,
        routingPolicies,
        modelMappings,
        connections: routingConnections,
        usagePolicies,
        usageContexts,
        pricing,
        captureMessageContent: gatewaySettings.capture_message_content,
        subjectAliases,
        subjectContexts,
        agentDelegations,
        executionGrants,
      })
      const configuredExpiresAt = input.issuedAt + options.releaseTtlSeconds
      if (!Number.isSafeInteger(configuredExpiresAt)) {
        throw new Error("Gateway release expiry exceeds the safe timestamp range")
      }
      const artifacts = compileGatewayPolicyArtifacts({
        tenant_id: input.tenantId,
        gateway_id: input.gatewayId,
        revision,
        policy_version: revision,
        issued_at: input.issuedAt,
        expires_at: configuredExpiresAt,
        projections,
        enforcement_chains: enforcementChains,
        public_models: publicModels,
        entitlements,
        subject_aliases: subjectAliases,
        subject_contexts: subjectContexts,
        agent_delegations: agentDelegations,
        execution_grants: executionGrants,
        usage_policies: usagePolicies,
        usage_contexts: usageContexts,
        resource_owners: resourceOwners,
      })
      const expiresAt = artifacts.authorization_bundle.expires_at
      const gatewayRoutingArtifact = compileGatewayRoutingArtifact({
        tenant_id: input.tenantId,
        gateway_id: input.gatewayId,
        revision,
        policy_version: revision,
        issued_at: input.issuedAt,
        expires_at: expiresAt,
        projections: modelRoutingProjections(projections).map((projection) => ({
          operation: "APPLY",
          tenant_id: projection.tenant_id,
          resource_id: projection.resource_id,
          capability_id: projection.capability_id,
          one_policy_revision: projection.policy_revision,
          eligible_connection_ids: enforcementChains.find((chain) =>
            chain.resource_id === projection.resource_id &&
            chain.capability_id === projection.capability_id,
          )?.eligible_connection_ids ?? [],
          required_obligation_kinds: [...new Set(enforcementChains
            .filter((chain) => chain.resource_id === projection.resource_id && chain.capability_id === projection.capability_id)
            .flatMap((chain) => chain.steps.flatMap((step) => step.kind === "PROCESS"
              ? [step.hooks.request?.action, step.hooks.response?.action].filter((value): value is string => typeof value === "string")
              : [])))].sort(compareUtf8),
        })),
        resource_owners: resourceOwners,
        routing_policies: routingPolicies,
        public_models: publicModels,
        model_mappings: modelMappings,
        connections: routingConnections.length ? routingConnections : undefined,
        pricing,
      })
      const currentHead = await options.releases.getHeadInTransaction({
        transaction: input.transaction,
        tenantId: input.tenantId,
        gatewayId: input.gatewayId,
      })
      const deliveries: GatewayPublicationReleaseDelivery[] = []
      for (const runtimeId of group.runtime_ids) {
        const plan = await planGatewayPolicyRelease({
          target: {
            tenant_id: group.tenant_id,
            gateway_id: group.gateway_id,
            runtime_id: runtimeId,
          },
          issued_at: input.issuedAt,
          expires_at: expiresAt,
          projections: projectionReferences(projections),
          authorization_bundle: artifacts.authorization_bundle,
          processor_policy: artifacts.processor_policy,
          gateway_routing_artifact: gatewayRoutingArtifact,
          gateway_configuration: {
            capture_message_content: gatewaySettings.capture_message_content,
          },
          enforcement_verification_keys: options.verificationKeys,
          artifact_signer: options.artifactSigner,
          release_root_signer: options.releaseRootSigner,
        })
        const saved = await options.releases.saveInTransaction({
          transaction: input.transaction,
          plan,
          expectedHeadRevision: currentHead?.head_revision ?? null,
        })
        const built = buildGatewayReleasePackage({ saved, projections })
        const command = await options.scheduler.enqueueGatewayReleaseInTransaction({
          transaction: input.transaction,
          tenantId: input.tenantId,
          runtimeId,
          release: built.reference,
        })
        deliveries.push({ saved, package: built.package, command })
      }
      const releaseId = deliveries[0]?.saved.release.release_id
      if (!releaseId || deliveries.some((delivery) => delivery.saved.release.release_id !== releaseId)) {
        throw new PlatformApiError("RUNTIME_RELEASE_GROUP_INCONSISTENT", 500)
      }
      return { release_id: releaseId, deliveries }
  }

  return {
    commitInTransaction(input) {
      return commit(input)
    },
    reconcileInTransaction(input) {
      return commit(input)
    },
  }
}
