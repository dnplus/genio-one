import { createHash } from "node:crypto"

import type { SqlTransaction } from "../../persistence/sql-adapter"
import type { ModelEntitlementCatalog } from "../entitlements/module"
import type { ResourceConnectionRegistry } from "../connections/module"
import { PlatformApiError } from "../errors"
import type { GatewayProjection } from "../gateway-projection/contract"
import type { DurableEd25519Signer } from "../gateway-projection/signer"
import type { ModelRoutingPolicyStore } from "../model-routing/module"
import type { PublicModelCatalog } from "../models/module"
import type { ResourceRegistry } from "../resources/module"
import type { RuntimeControlStore } from "../runtime-control/contract"
import type { GatewayAggregateRuntimeControlStore } from "../gateway-runtime-control/contract"
import type { GatewayReleasePackageSource } from "./package-source"
import type { CompactJwsSigner, GatewayPolicyReleasePlan } from "./contract"
import type {
  GatewayPolicyReleaseHead,
  GatewayPolicyReleaseManifestRecord,
  GatewayPolicyReleaseRecord,
  SavedGatewayPolicyRelease,
} from "./module"
import { canonicalGatewayPolicyReleaseBytes } from "./planner"
import { createGatewayPublicationReleaseCoordinator } from "./publication-commit"

export interface GatewayAggregatePublicationDelivery {
  deliver(input: {
    tenantId: string
    gatewayId: string
    projection: GatewayProjection
    issuedAt: number
  }): Promise<void>
}

export interface InMemoryGatewayAggregatePublicationModule {
  delivery: GatewayAggregatePublicationDelivery
  packages: GatewayReleasePackageSource
}

export interface InMemoryGatewayAggregatePublicationOptions {
  projections: () => readonly GatewayProjection[]
  resources: ResourceRegistry
  connections: ResourceConnectionRegistry
  models: PublicModelCatalog
  entitlements: ModelEntitlementCatalog
  routingPolicies: ModelRoutingPolicyStore
  registrations: Pick<RuntimeControlStore, "listGatewayRuntimes">
  aggregate: GatewayAggregateRuntimeControlStore
  artifactSigner: DurableEd25519Signer
  releaseRootSigner: DurableEd25519Signer
  releaseTtlSeconds?: number
}

const memoryTransaction = {
  async query(): Promise<never> {
    throw new Error("memory aggregate release adapter does not execute SQL")
  },
} as SqlTransaction

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalGatewayPolicyReleaseBytes(value))
    .digest("hex")
}

function compactSigner(signer: DurableEd25519Signer): CompactJwsSigner {
  return {
    algorithm: "EdDSA",
    keyId: signer.keyId,
    sign: (payload) => signer.sign(payload),
  }
}

function packageKey(input: {
  tenantId: string
  runtimeId: string
  releaseId: string
  headRevision: number
}): string {
  return JSON.stringify([
    input.tenantId,
    input.runtimeId,
    input.releaseId,
    input.headRevision,
  ])
}

function releaseRecord(plan: GatewayPolicyReleasePlan): GatewayPolicyReleaseRecord {
  const manifest = plan.manifest
  const projections = manifest.gateway_projections.map((projection) => ({ ...projection }))
  return {
    tenant_id: plan.target.tenant_id,
    release_id: plan.release_id,
    gateway_id: plan.target.gateway_id,
    policy_artifact_revision: manifest.authorization_bundle.revision,
    policy_version: manifest.authorization_bundle.policy_version,
    issued_at: manifest.issued_at,
    expires_at: manifest.expires_at,
    content_digest: plan.release_id.slice("release-".length),
    projection_set_digest: sha256(projections),
    projections,
    authorization_bundle: plan.authorization_bundle,
    processor_policy: plan.processor_policy,
    gateway_routing_artifact: plan.gateway_routing_artifact,
    enforcement_verification_keys: plan.enforcement_verification_keys,
    created_at: manifest.issued_at,
    updated_at: manifest.issued_at,
  }
}

function manifestRecord(plan: GatewayPolicyReleasePlan): GatewayPolicyReleaseManifestRecord {
  return {
    tenant_id: plan.target.tenant_id,
    release_id: plan.release_id,
    runtime_id: plan.target.runtime_id,
    gateway_id: plan.target.gateway_id,
    manifest: plan.manifest,
    manifest_jws: plan.manifest_jws,
    created_at: plan.manifest.issued_at,
    updated_at: plan.manifest.issued_at,
  }
}

export function createInMemoryGatewayAggregatePublicationModule(
  options: InMemoryGatewayAggregatePublicationOptions,
): InMemoryGatewayAggregatePublicationModule {
  const releases = new Map<string, GatewayPolicyReleaseRecord>()
  const manifests = new Map<string, GatewayPolicyReleaseManifestRecord>()
  const heads = new Map<string, GatewayPolicyReleaseHead>()
  const packages = new Map<string, Awaited<ReturnType<GatewayReleasePackageSource["getPackage"]>>>()
  const artifactSigner = compactSigner(options.artifactSigner)
  const releaseRootSigner = compactSigner(options.releaseRootSigner)
  const verificationKeys = {
    schema_version: 1 as const,
    keys: [{
      key_id: options.artifactSigner.keyId,
      public_key_pem: options.artifactSigner.publicKeyPem,
    }],
  }

  const coordinator = createGatewayPublicationReleaseCoordinator({
    activeProjections: {
      async listActiveForGatewayInTransaction(input) {
        const byPublication = new Map<string, GatewayProjection>()
        for (const projection of options.projections()) {
          if (
            projection.operation === "APPLY" &&
            projection.tenant_id === input.tenantId &&
            projection.publication_endpoint.gateway_id === input.gatewayId
          ) byPublication.set(projection.publication_id, structuredClone(projection))
        }
        if (input.candidate) {
          if (
            input.candidate.operation !== "APPLY" ||
            input.candidate.tenant_id !== input.tenantId ||
            input.candidate.publication_endpoint.gateway_id !== input.gatewayId
          ) throw new PlatformApiError("GATEWAY_ACTIVE_PROJECTION_MISMATCH", 409)
          for (const [publicationId, projection] of byPublication) {
            if (
              projection.resource_id === input.candidate.resource_id &&
              projection.capability_id === input.candidate.capability_id
            ) byPublication.delete(publicationId)
          }
          byPublication.set(input.candidate.publication_id, structuredClone(input.candidate))
        }
        return [...byPublication.values()].sort((left, right) => {
          const publicationOrder = compareUtf8(left.publication_id, right.publication_id)
          return publicationOrder !== 0
            ? publicationOrder
            : compareUtf8(left.projection_id, right.projection_id)
        })
      },
    },
    policyInputs: {
      async loadForGatewayInTransaction(input) {
        const resourceIds = [...new Set(input.projections.map((projection) => projection.resource_id))]
          .sort(compareUtf8)
        const resourceSet = new Set(resourceIds)
        const resources = await Promise.all(resourceIds.map((resourceId) =>
          options.resources.getResource({ tenantId: input.tenantId, resourceId })))
        for (const resource of resources) {
          const expected = resource.resource_id === input.candidateResourceId
            ? ["DRAFT", "PUBLISHED"]
            : ["PUBLISHED", "DEPRECATED"]
          if (!expected.includes(resource.lifecycle)) {
            throw new PlatformApiError("GATEWAY_POLICY_INPUT_MISMATCH", 409)
          }
        }
        const publicModels = (await options.models.list({
          tenantId: input.tenantId,
          includeUnpublishedResources: true,
        })).filter((model) =>
          resourceSet.has(model.resource_id) &&
          model.visibility === "PUBLIC" &&
          model.lifecycle === "PUBLISHED")
        const modelIds = new Set(publicModels.map((model) => model.model_id))
        const modelMappings = (await Promise.all(resourceIds.map((resourceId) =>
          options.models.listMappings({
            tenantId: input.tenantId,
            resourceId,
            readyOnly: true,
          })))).flat().filter((mapping) => modelIds.has(mapping.public_model_id))
        const routingConnections = await Promise.all(
          [...new Map(modelMappings.map((mapping) => [mapping.connection_id, mapping])).values()]
            .map((mapping) => options.connections.get({
              tenantId: input.tenantId,
              resourceId: mapping.resource_id,
              connectionId: mapping.connection_id,
            })),
        )
        const routeProjections = input.projections.filter((projection) =>
          projection.resources.some((resource) => resource.kind === "AIGatewayRoute"))
        const routingPolicies = []
        for (const projection of routeProjections) {
          const owner = resources.find((resource) => resource.resource_id === projection.resource_id)
          if (!owner) throw new PlatformApiError("GATEWAY_POLICY_INPUT_MISMATCH", 409)
          const policy = await options.routingPolicies.getLatest({
            tenantId: input.tenantId,
            ownerOrganizationId: owner.owner_organization_id,
            resourceId: projection.resource_id,
            capabilityId: projection.capability_id,
          })
          if (!policy) throw new PlatformApiError("GATEWAY_ROUTING_POLICY_MISSING", 409)
          routingPolicies.push(policy)
        }
        const entitlements = (await options.entitlements.list({ tenantId: input.tenantId }))
          .filter((entitlement) => resourceSet.has(entitlement.resource_id))
        if (entitlements.some((entitlement) =>
          entitlement.public_model_id !== null && !modelIds.has(entitlement.public_model_id))) {
          throw new PlatformApiError("GATEWAY_POLICY_INPUT_MISMATCH", 409)
        }
        return {
          enforcement_chains: input.projections.map((projection) =>
            projection.policy_bundle.enforcement_chain),
          public_models: publicModels,
          entitlements,
          resource_owners: resources.map((resource) => ({
            tenant_id: input.tenantId,
            resource_id: resource.resource_id,
            owner_organization_id: resource.owner_organization_id,
          })),
          routing_policies: routingPolicies,
          model_mappings: modelMappings,
          connections: routingConnections.map((connection) => ({
            tenant_id: connection.tenant_id,
            resource_id: connection.resource_id,
            connection_id: connection.connection_id,
            configuration_revision: connection.configuration_revision,
            ...(connection.provider_credential_profile ? {
              provider_credential_profile_id: connection.provider_credential_profile.profile_id,
              provider_credential_profile_revision: connection.provider_credential_profile.revision,
              provider_credential_strategy_digest: connection.provider_credential_profile.strategy_digest,
            } : {}),
            lifecycle: connection.lifecycle,
            verification_state: connection.verification_state,
            health_state: connection.health_state,
            health_observed_at: connection.health_observed_at,
            health_source_revision: connection.health_source_revision,
            routing_priority: connection.routing_priority,
            region: connection.region,
            supported_obligations: connection.supported_obligations,
          })),
          subject_aliases: {},
        }
      },
    },
    runtimeSelector: {
      async selectGatewayGroupInTransaction(input) {
        const registrations = await options.registrations.listGatewayRuntimes({
          tenantId: input.tenantId,
          targetId: input.gatewayId,
        })
        const runtimeIds: string[] = []
        for (const registration of registrations) {
          if (registration.status !== "ACTIVE") continue
          const capabilities = await options.aggregate.getCapabilities({
            tenantId: input.tenantId,
            runtimeKind: "GATEWAY",
            runtimeId: registration.runtime_id,
          })
          if (capabilities?.delivery_mode === "AGGREGATE_RELEASE") {
            runtimeIds.push(registration.runtime_id)
          }
        }
        runtimeIds.sort(compareUtf8)
        if (runtimeIds.length === 0) {
          throw new PlatformApiError("GATEWAY_RUNTIME_NOT_REGISTERED", 409)
        }
        return {
          tenant_id: input.tenantId,
          gateway_id: input.gatewayId,
          runtime_ids: runtimeIds,
        }
      },
    },
    releases: {
      async getHeadInTransaction(input) {
        return structuredClone(heads.get(JSON.stringify([input.tenantId, input.gatewayId])) ?? null)
      },
      async saveInTransaction(input) {
        const plan = input.plan
        const headKey = JSON.stringify([plan.target.tenant_id, plan.target.gateway_id])
        const current = heads.get(headKey)
        if (
          current &&
          current.release_id !== plan.release_id &&
          current.head_revision !== input.expectedHeadRevision
        ) throw new PlatformApiError("GATEWAY_POLICY_RELEASE_HEAD_CONFLICT", 409)
        const release = releases.get(plan.release_id) ?? releaseRecord(plan)
        const manifestKey = JSON.stringify([
          plan.target.tenant_id,
          plan.release_id,
          plan.target.runtime_id,
        ])
        const manifest = manifests.get(manifestKey) ?? manifestRecord(plan)
        const head: GatewayPolicyReleaseHead = current?.release_id === plan.release_id
          ? current
          : {
              tenant_id: plan.target.tenant_id,
              gateway_id: plan.target.gateway_id,
              release_id: plan.release_id,
              content_digest: release.content_digest,
              head_revision: (current?.head_revision ?? 0) + 1,
              updated_at: plan.manifest.issued_at,
            }
        releases.set(plan.release_id, release)
        manifests.set(manifestKey, manifest)
        heads.set(headKey, head)
        return structuredClone({ release, target: plan.target, manifest, head }) as SavedGatewayPolicyRelease
      },
    },
    scheduler: options.aggregate,
    artifactSigner,
    releaseRootSigner,
    verificationKeys,
    releaseTtlSeconds: options.releaseTtlSeconds ?? 3_600,
  })

  return {
    delivery: {
      async deliver(input) {
        const result = await coordinator.commitInTransaction({
          transaction: memoryTransaction,
          tenantId: input.tenantId,
          gatewayId: input.gatewayId,
          candidate: input.projection,
          issuedAt: input.issuedAt,
        })
        for (const item of result.deliveries) {
          packages.set(packageKey({
            tenantId: input.tenantId,
            runtimeId: item.saved.target.runtime_id,
            releaseId: item.saved.release.release_id,
            headRevision: item.saved.head.head_revision,
          }), structuredClone(item.package))
        }
      },
    },
    packages: {
      async getPackage(input) {
        return structuredClone(packages.get(packageKey(input)) ?? null)
      },
    },
  }
}
