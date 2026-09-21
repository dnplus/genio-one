import { canonicalJson } from "@genioone/protocol/canonical"

import { PlatformApiError } from "../errors"
import type { PlatformApiViolation } from "../errors"
import type { GatewayProjection, GatewayProjectionSnapshot } from "../gateway-projection/contract"
import type { ResourcePublicationRequest } from "../resources/publication-types"
import type { ResourceRegistration } from "../resources/contract"
import type { ResourceRegistry } from "../resources/module"
import { resourceContentDigest } from "../resources/resource-content"
import { snapshotDigest, snapshotDigestMatches } from "./snapshot-digest"
import type { ResourceConnectionRegistry } from "../connections/module"
import type { PublicModelCatalog } from "../models/module"
import type { ResourceMemoryState, ResourcePublicationBuildAttempt } from "../resources/state"
import type { GatewayAggregatePublicationDelivery } from "../gateway-policy-release/memory-delivery"
import type {
  AiResourcePublicationWorkflow,
  AiResourcePublicationWorkflowOptions,
  EnforcementChainReader,
  PublicationReference,
  PublicationWorkflowStore,
} from "./module"
import type { PublicationWorkflowRequest } from "./contract"

function resourceKey(tenantId: string, resourceId: string): string {
  return `${tenantId}:${resourceId}`
}

function requestKey(tenantId: string, resourceId: string, requestId: string): string {
  return `${tenantId}:${resourceId}:${requestId}`
}

function publicationKey(tenantId: string, publicationId: string): string {
  return `${tenantId}:${publicationId}`
}

function attemptKey(tenantId: string, publicationId: string, attemptId: string): string {
  return `${tenantId}:${publicationId}:${attemptId}`
}

function cloneRequest(request: ResourcePublicationRequest): ResourcePublicationRequest {
  return { ...request }
}

function withPublicationState(
  request: ResourcePublicationRequest,
  state: ResourcePublicationRequest["state"],
  publicationState: "IDLE" | "PENDING_REVIEW" | "BUILDING" | "FAILED" | "READY",
  attemptId: string | null,
  failureCode: string | null,
  reviewedBy = request.reviewed_by ?? null,
  reviewedAt = request.reviewed_at ?? null,
): ResourcePublicationRequest {
  return {
    ...request,
    state,
    publication_state: publicationState,
    attempt_id: attemptId,
    failure_code: failureCode,
    reviewed_by: reviewedBy,
    reviewed_at: reviewedAt,
  }
}

function workflowRequestView(
  publicationId: string,
  request: ResourcePublicationRequest,
): PublicationWorkflowRequest {
  return {
    publication_id: publicationId,
    ...request,
    publication_state: request.publication_state ?? "IDLE",
    reviewed_by: request.reviewed_by ?? null,
    reviewed_at: request.reviewed_at ?? null,
    attempt_id: request.attempt_id ?? null,
    failure_code: request.failure_code ?? null,
  }
}

export interface InMemoryPublicationStoreOptions {
  state: ResourceMemoryState
  resources: ResourceRegistry
  connections: ResourceConnectionRegistry
  models: PublicModelCatalog
  chains: EnforcementChainReader
  now?: () => number
  idFactory?: (prefix: string) => string
  /** Optional only for isolated store tests; the composed API always injects Runtime Control. */
  gatewayDelivery?: GatewayAggregatePublicationDelivery
}

/**
 * In-memory equivalent of the publication aggregate. It intentionally keeps
 * the same state transitions as the PostgreSQL adapter so UI development can
 * exercise review/build failures without making a fake direct publish path.
 */
export function createInMemoryPublicationWorkflowStore(
  options: InMemoryPublicationStoreOptions,
): PublicationWorkflowStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  let attemptSequence = 0
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${++attemptSequence}`)

  const findRequest = async (input: {
    tenantId: string
    resourceId: string
    requestId: string
  }): Promise<ResourcePublicationRequest | null> => {
    const request = options.state.publicationRequests.get(
      requestKey(input.tenantId, input.resourceId, input.requestId),
    )
    return request ? cloneRequest(request) : null
  }

  const updateResourceRequest = async (
    tenantId: string,
    resourceId: string,
    request: ResourcePublicationRequest,
  ): Promise<ResourceRegistration> => {
    const key = resourceKey(tenantId, resourceId)
    const resource = options.state.resources.get(key)
    if (!resource) throw new PlatformApiError("RESOURCE_NOT_FOUND", 404)
    const updated = { ...resource, publication_request: request }
    options.state.resources.set(key, updated)
    return updated
  }

  return {
    async preparePublicationReference(input): Promise<PublicationReference | null> {
      const resource = await options.resources.getResource(input)
      if (!resource.publication_endpoint) return null
      const endpointKey = resourceKey(input.tenantId, input.resourceId)
      let endpointRevision = options.state.publicationEndpointRevisions.get(endpointKey) ?? 1
      const failedDraftBuild =
        resource.lifecycle === "DRAFT" &&
        resource.publication_request?.state === "PENDING" &&
        resource.publication_request.publication_state === "FAILED"
      if (
        (resource.lifecycle === "PUBLISHED" && resource.publication_request?.state !== "PENDING") ||
        failedDraftBuild
      ) {
        endpointRevision += 1
        options.state.publicationEndpointRevisions.set(endpointKey, endpointRevision)
      }
      const resourceRevision =
        options.state.resourceRevisions.get(resourceKey(input.tenantId, input.resourceId)) ?? 1
      // Memory development has no database-generated publication id. Keep a
      // deterministic reference per endpoint revision so retries and reloads
      // address the same immutable review snapshot.
      const publicationId = `publication-${resource.resource_id}-${endpointRevision}`
      return {
        publicationId,
        endpointRevision,
        resourceRevision,
        resourceDigest: resourceContentDigest(resource),
      }
    },

    async getSnapshot(input) {
      const snapshot = options.state.publicationSnapshots.get(
        publicationKey(input.tenantId, input.publicationId),
      )
      if (!snapshot) return null
      if (
        snapshot.tenant_id !== input.tenantId ||
        snapshot.publication_id !== input.publicationId ||
        !snapshotDigestMatches(snapshot, snapshot.snapshot_digest)
      ) {
        throw new PlatformApiError("PUBLICATION_SNAPSHOT_INVALID", 500)
      }
      return snapshot
    },

    async getProjection(input) {
      const projection = [...options.state.publicationProjections.values()].find(
        (candidate) =>
          candidate.tenant_id === input.tenantId &&
          candidate.projection_id === input.projectionId,
      )
      return projection ? structuredClone(projection) : null
    },

    getRequest: findRequest,

    async saveReviewSnapshot(input) {
      const publication = publicationKey(input.tenantId, input.snapshot.publication_id)
      if (options.state.publicationSnapshots.has(publication)) {
        const existing = options.state.publicationSnapshots.get(publication)
        if (existing?.snapshot_digest !== input.snapshot.snapshot_digest) {
          throw new PlatformApiError("PUBLICATION_SNAPSHOT_IMMUTABLE", 409)
        }
      }
      options.state.publicationSnapshots.set(publication, input.snapshot)
      const request = withPublicationState(
        input.request,
        "PENDING",
        "PENDING_REVIEW",
        null,
        null,
      )
      const previousRequest = options.state.resources.get(
        resourceKey(input.tenantId, input.resourceId),
      )?.publication_request
      if (previousRequest && previousRequest.request_id !== request.request_id) {
        options.state.publicationRequests.delete(
          requestKey(input.tenantId, input.resourceId, previousRequest.request_id),
        )
      }
      options.state.publicationRequests.set(
        requestKey(input.tenantId, input.resourceId, request.request_id),
        request,
      )
      await updateResourceRequest(input.tenantId, input.resourceId, request)
      return cloneRequest(request)
    },

    async claimBuild(input) {
      const request = await findRequest(input)
      if (!request) throw new PlatformApiError("PUBLICATION_REQUEST_NOT_PENDING", 409)
      const snapshot = [...options.state.publicationSnapshots.values()].find(
        (candidate) =>
          candidate.tenant_id === input.tenantId &&
          candidate.resource_id === input.resourceId &&
          candidate.request_id === request.request_id,
      )
      if (!snapshot) throw new PlatformApiError("PUBLICATION_SNAPSHOT_NOT_FOUND", 409)

      if (request.publication_state === "BUILDING" && request.attempt_id) {
        throw new PlatformApiError("PUBLICATION_BUILD_IN_PROGRESS", 409)
      }
      if (request.publication_state === "READY") {
        return {
          attemptId: request.attempt_id ?? "",
          snapshot,
          state: "READY" as const,
        }
      }
      if (request.state !== "PENDING") {
        throw new PlatformApiError("PUBLICATION_REQUEST_NOT_PENDING", 409)
      }
      const attemptId = idFactory("publication-attempt")
      const claimedAt = input.reviewedAt
      const attempt: ResourcePublicationBuildAttempt = {
        tenant_id: input.tenantId,
        publication_id: snapshot.publication_id,
        attempt_id: attemptId,
        snapshot_digest: snapshot.snapshot_digest,
        state: "BUILDING",
        claimed_at: claimedAt,
      }
      options.state.publicationAttempts.set(
        attemptKey(input.tenantId, snapshot.publication_id, attemptId),
        attempt,
      )
      const building = withPublicationState(
        request,
        "PENDING",
        "BUILDING",
        attemptId,
        null,
        input.reviewerId,
        input.reviewedAt,
      )
      options.state.publicationRequests.set(
        requestKey(input.tenantId, input.resourceId, request.request_id),
        building,
      )
      await updateResourceRequest(input.tenantId, input.resourceId, building)
      return { attemptId, snapshot, state: "BUILDING" as const }
    },

    async markBuildFailed(input) {
      const attempt = options.state.publicationAttempts.get(
        attemptKey(input.tenantId, input.requestId, input.attemptId),
      )
      // `requestId` is not the Publication ID in the public API. Resolve the
      // immutable attempt by request when the caller uses the API identity.
      const resolvedAttempt = attempt ?? [...options.state.publicationAttempts.values()].find(
        (candidate) =>
          candidate.tenant_id === input.tenantId && candidate.attempt_id === input.attemptId,
      )
      if (!resolvedAttempt || resolvedAttempt.state !== "BUILDING") return
      resolvedAttempt.state = "FAILED"
      resolvedAttempt.failure_code = input.failureCode
      resolvedAttempt.completed_at = now()
      options.state.publicationAttempts.set(
        attemptKey(input.tenantId, resolvedAttempt.publication_id, input.attemptId),
        resolvedAttempt,
      )
      const request = await findRequest(input)
      if (!request) return
      const failed = withPublicationState(
        request,
        "PENDING",
        "FAILED",
        input.attemptId,
        input.failureCode,
        request.reviewed_by,
        request.reviewed_at,
      )
      options.state.publicationRequests.set(
        requestKey(input.tenantId, input.resourceId, request.request_id),
        failed,
      )
      await updateResourceRequest(input.tenantId, input.resourceId, failed)
    },

    async reject(input) {
      const request = await findRequest({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        requestId: input.requestId,
      })
      if (!request || request.state !== "PENDING") {
        throw new PlatformApiError("PUBLICATION_REQUEST_NOT_PENDING", 409)
      }
      const rejected = withPublicationState(
        request,
        "REJECTED",
        "IDLE",
        null,
        null,
        input.reviewerId,
        input.reviewedAt,
      )
      options.state.publicationRequests.set(
        requestKey(input.tenantId, input.resourceId, input.requestId),
        rejected,
      )
      for (const [key, snapshot] of options.state.publicationSnapshots) {
        if (
          snapshot.tenant_id === input.tenantId &&
          snapshot.resource_id === input.resourceId &&
          snapshot.request_id === input.requestId
        ) {
          options.state.publicationSnapshots.delete(key)
        }
      }
      return updateResourceRequest(input.tenantId, input.resourceId, rejected)
    },

    async commitBuild(input) {
      const request = await findRequest({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        requestId: input.requestId,
      })
      if (!request || request.state !== "PENDING" || request.publication_state !== "BUILDING") {
        throw new PlatformApiError("PUBLICATION_BUILD_NOT_ACTIVE", 409)
      }
      if (request.attempt_id !== input.attemptId) {
        throw new PlatformApiError("PUBLICATION_BUILD_ATTEMPT_MISMATCH", 409)
      }
      const snapshot = [...options.state.publicationSnapshots.values()].find(
        (candidate) =>
          candidate.tenant_id === input.tenantId &&
          candidate.resource_id === input.resourceId &&
          candidate.publication_id === input.projection.publication_id,
      )
      if (!snapshot || !snapshotDigestMatches(snapshot, snapshot.snapshot_digest)) {
        throw new PlatformApiError("PUBLICATION_SNAPSHOT_INVALID", 409)
      }
      if (input.projection.publication_id !== snapshot.publication_id) {
        throw new PlatformApiError("PROJECTION_PUBLICATION_MISMATCH", 409)
      }
      if (
        input.projection.tenant_id !== input.tenantId ||
        input.projection.resource_id !== snapshot.resource_id ||
        input.projection.capability_id !== snapshot.capability_id ||
        input.projection.policy_revision !== snapshot.policy_revision ||
        input.projection.endpoint_revision !== snapshot.endpoint_revision ||
        input.projection.publication_endpoint.gateway_id !== snapshot.publication_endpoint.gateway_id ||
        input.projection.publication_endpoint.hostname !== snapshot.publication_endpoint.hostname ||
        input.projection.publication_endpoint.base_path !== snapshot.publication_endpoint.base_path
      ) {
        throw new PlatformApiError("PROJECTION_SNAPSHOT_MISMATCH", 409)
      }
      const current = await options.resources.getResource({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
      })
      if (
        (current.lifecycle !== "DRAFT" && current.lifecycle !== "PUBLISHED") ||
        resourceContentDigest(current) !== snapshot.resource_digest
      ) {
        throw new PlatformApiError("PUBLICATION_SNAPSHOT_STALE", 409)
      }
      const currentEndpointRevision =
        options.state.publicationEndpointRevisions.get(
          resourceKey(input.tenantId, input.resourceId),
        ) ?? 0
      if (
        currentEndpointRevision !== snapshot.endpoint_revision ||
        !current.publication_endpoint ||
        canonicalJson(current.publication_endpoint) !== canonicalJson(snapshot.publication_endpoint)
      ) {
        throw new PlatformApiError("PUBLICATION_SNAPSHOT_STALE", 409)
      }

      const currentConnections = await options.connections.list({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
      })
      const currentConnectionById = new Map(
        currentConnections.map((connection) => [connection.connection_id, connection]),
      )
      if (snapshot.connections.some((connection) => {
        const currentConnection = currentConnectionById.get(connection.connection_id)
        return !currentConnection || canonicalJson(currentConnection) !== canonicalJson(connection)
      })) {
        throw new PlatformApiError("PUBLICATION_SNAPSHOT_STALE", 409)
      }

      const currentModels = (
        await options.models.list({
          tenantId: input.tenantId,
          resourceId: input.resourceId,
          visibility: "PUBLIC",
          includeUnpublishedResources: true,
        })
      ).filter((model) => model.lifecycle === "PUBLISHED")
      if (
        currentModels.length !== snapshot.models.length ||
        currentModels.some((model) => {
          const snapshotModel = snapshot.models.find((candidate) => candidate.model_id === model.model_id)
          return !snapshotModel || canonicalJson(model) !== canonicalJson(snapshotModel)
        })
      ) {
        throw new PlatformApiError("PUBLICATION_SNAPSHOT_STALE", 409)
      }

      const currentModelIds = new Set(currentModels.map((model) => model.model_id))
      const frozenConnectionIds = new Set(snapshot.connections.map((connection) => connection.connection_id))
      const currentMappings = (await options.models.listMappings({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
      })).filter((mapping) =>
        currentModelIds.has(mapping.public_model_id) &&
        frozenConnectionIds.has(mapping.connection_id)
      )
      if (
        currentMappings.length !== snapshot.model_mappings.length ||
        currentMappings.some((mapping) => {
          const frozen = snapshot.model_mappings.find(
            (candidate) => candidate.mapping_id === mapping.mapping_id,
          )
          return !frozen || canonicalJson(mapping) !== canonicalJson(frozen)
        })
      ) {
        throw new PlatformApiError("PUBLICATION_SNAPSHOT_STALE", 409)
      }

      {
        const latestChain = await options.chains.getLatest({
          tenantId: input.tenantId,
          resourceId: input.resourceId,
          capabilityId: snapshot.capability_id,
        })
        if (
          !latestChain ||
          latestChain.one_policy_revision !== snapshot.policy_revision ||
          canonicalJson(latestChain.chain) !== canonicalJson(snapshot.one_policy_chain)
        ) {
          throw new PlatformApiError("PUBLICATION_SNAPSHOT_STALE", 409)
        }
      }

      const attempt = options.state.publicationAttempts.get(
        attemptKey(input.tenantId, snapshot.publication_id, input.attemptId),
      )
      if (!attempt || attempt.state !== "BUILDING") {
        throw new PlatformApiError("PUBLICATION_BUILD_NOT_ACTIVE", 409)
      }
      // Validate every immutable precondition before mutating any in-memory
      // map, matching the all-or-nothing PostgreSQL transaction.
      const ready: ResourcePublicationBuildAttempt = {
        ...attempt,
        state: "READY",
        projection_digest: input.projection.digest,
        completed_at: input.reviewedAt,
      }
      const approved = withPublicationState(
        request,
        "APPROVED",
        "READY",
        input.attemptId,
        null,
        input.reviewerId,
        input.reviewedAt,
      )
      const published = { ...current, lifecycle: "PUBLISHED" as const, publication_request: approved }
      await options.gatewayDelivery?.deliver({
        tenantId: input.tenantId,
        gatewayId: snapshot.publication_endpoint.gateway_id,
        projection: input.projection,
        issuedAt: input.reviewedAt,
      })
      options.state.publicationAttempts.set(
        attemptKey(input.tenantId, snapshot.publication_id, input.attemptId),
        ready,
      )
      for (const [key, projection] of options.state.publicationProjections) {
        if (
          projection.resource_id === input.projection.resource_id &&
          projection.capability_id === input.projection.capability_id
        ) options.state.publicationProjections.delete(key)
      }
      options.state.publicationProjections.set(
        publicationKey(input.tenantId, snapshot.publication_id),
        input.projection,
      )
      options.state.publicationRequests.set(
        requestKey(input.tenantId, input.resourceId, input.requestId),
        approved,
      )
      options.state.resources.set(resourceKey(input.tenantId, input.resourceId), published)
      return published
    },
  }
}

function publicationResourceViolations(resource: ResourceRegistration): PlatformApiViolation[] {
  const violations: PlatformApiViolation[] = []
  if (resource.kind !== "LLM" && resource.kind !== "MCP" && resource.kind !== "API") {
    violations.push({
      code: "AI_GATEWAY_PUBLICATION_RESOURCE_UNSUPPORTED",
      field: "kind",
      message: "Gateway publication supports LLM, MCP, and API Resources",
    })
  }
  if (resource.kind === "API" && !resource.api) {
    violations.push({
      code: "API_METADATA_REQUIRED",
      field: "api",
      message: "Import an OpenAPI document before publication",
    })
  }
  const routeCapabilities = resource.kind === "MCP"
    ? resource.capabilities.filter((capability) => !capability.capability_id.startsWith("mcp-tool-"))
    : resource.capabilities
  if (routeCapabilities.length !== 1) {
    violations.push({
      code: "AI_GATEWAY_PUBLICATION_CAPABILITY_UNSUPPORTED",
      field: "capabilities",
      message: "A Gateway Resource requires exactly one route Capability",
    })
  }
  if (!resource.publication_endpoint) {
    violations.push({
      code: "PUBLICATION_ENDPOINT_REQUIRED",
      field: "publication_endpoint",
      message: "Configure a publication hostname and base path",
    })
  } else if (resource.publication_endpoint.dns_verification !== "VERIFIED") {
    violations.push({
      code: "PUBLICATION_DNS_NOT_VERIFIED",
      field: "publication_endpoint.dns_verification",
      message: "Verify the publication DNS configuration",
    })
  }
  return violations
}

function resourceNotPublishable(violations: PlatformApiViolation[]): never {
  throw new PlatformApiError(
    "RESOURCE_NOT_PUBLISHABLE",
    422,
    "Resource cannot be published",
    violations,
  )
}

async function collectPublicationInputs(
  options: AiResourcePublicationWorkflowOptions,
  resource: ResourceRegistration,
 ) {
  const violations = publicationResourceViolations(resource)
  const publicationEndpoint = resource.publication_endpoint
  const capability = resource.kind === "MCP"
    ? resource.capabilities.find((candidate) => !candidate.capability_id.startsWith("mcp-tool-"))
    : resource.capabilities[0]
  if (!capability) {
    violations.push({
      code: "ENFORCEMENT_CAPABILITY_NOT_FOUND",
      field: "capabilities",
      message: "Add the Capability that the Gateway will enforce",
    })
  }
  const [chain, connections, models, modelMappings] = await Promise.all([
    capability
      ? options.chains.getLatest({
          tenantId: resource.tenant_id,
          resourceId: resource.resource_id,
          capabilityId: capability.capability_id,
        })
      : Promise.resolve(null),
    options.connections.list({
      tenantId: resource.tenant_id,
      resourceId: resource.resource_id,
    }),
    resource.kind === "LLM"
      ? options.models.list({
          tenantId: resource.tenant_id,
          visibility: "PUBLIC",
          resourceId: resource.resource_id,
          includeUnpublishedResources: true,
        }).then((values) => values.filter((model) => model.lifecycle === "PUBLISHED"))
      : Promise.resolve([]),
    resource.kind === "LLM"
      ? options.models.listMappings({
          tenantId: resource.tenant_id,
          resourceId: resource.resource_id,
        })
      : Promise.resolve([]),
  ])
  if (!chain) {
    violations.push({
      code: "ENFORCEMENT_CHAIN_REQUIRED",
      field: "enforcement_chain",
      message: "Configure and save an Enforcement Chain",
    })
  }
  const eligibleIds = new Set(chain?.chain.eligible_connection_ids ?? [])
  const ownedConnections = connections.filter((connection) =>
    eligibleIds.has(connection.connection_id),
  )
  const providerCredentialProfiles = []
  const seenProviderCredentialProfiles = new Set<string>()
  for (const connection of ownedConnections) {
    const binding = connection.provider_credential_profile
    if (!binding) continue
    const profileKey = `${binding.profile_id}\u0000${binding.revision}`
    if (seenProviderCredentialProfiles.has(profileKey)) continue
    seenProviderCredentialProfiles.add(profileKey)
    if (!options.providerCredentials) {
      violations.push({
        code: "PROVIDER_CREDENTIAL_PROFILE_STORE_UNAVAILABLE",
        field: "connections.provider_credential_profile",
        message: "Provider Credential Profile storage is required for a bound Connection",
      })
      continue
    }
    const [profile, latest] = await Promise.all([
      options.providerCredentials.getRevision({
        tenantId: resource.tenant_id,
        profileId: binding.profile_id,
        revision: binding.revision,
      }),
      options.providerCredentials.getLatest({
        tenantId: resource.tenant_id,
        profileId: binding.profile_id,
      }),
    ])
    if (
      !profile ||
      profile.owner_organization_id !== resource.owner_organization_id ||
      profile.strategy_digest !== binding.strategy_digest ||
      latest?.state !== "ACTIVE"
    ) {
      violations.push({
        code: "PROVIDER_CREDENTIAL_PROFILE_NOT_READY",
        field: "connections.provider_credential_profile",
        message: "Every selected Connection requires its exact active Provider Credential Profile revision",
      })
      continue
    }
    providerCredentialProfiles.push(profile)
  }
  if (chain && (ownedConnections.length !== eligibleIds.size || ownedConnections.length === 0)) {
    violations.push({
      code: "ENFORCEMENT_CONNECTION_CANDIDATES_MISMATCH",
      field: "enforcement_chain.eligible_connection_ids",
      message: "Map the Enforcement Chain to at least one Connection owned by this Resource",
    })
  }
  if (ownedConnections.some((connection) => connection.status !== "READY")) {
    violations.push({
      code: "CONNECTION_NOT_READY",
      field: "connections",
      message: "Verify every Connection selected by the Enforcement Chain",
    })
  }
  if (resource.kind === "LLM" && models.length === 0) {
    violations.push({
      code: "PUBLIC_MODEL_REQUIRED",
      field: "public_models",
      message: "Publish at least one Public Model for client requests",
    })
  }
  const publishedModelIds = new Set(models.map((model) => model.model_id))
  const projectedMappings = modelMappings.filter((mapping) =>
    publishedModelIds.has(mapping.public_model_id) &&
    eligibleIds.has(mapping.connection_id),
  )
  const missingModelMapping = resource.kind === "LLM" && models.some((model) =>
    [...eligibleIds].some((connectionId) =>
      !projectedMappings.some(
        (mapping) =>
          mapping.public_model_id === model.model_id &&
          mapping.connection_id === connectionId,
      ),
    ),
  )
  if (missingModelMapping) {
    violations.push({
      code: "MODEL_CONNECTION_MAPPING_REQUIRED",
      field: "public_models.connection_mappings",
      message: "Map every Public Model to each eligible Connection and upstream model",
    })
  }
  if (violations.length > 0) resourceNotPublishable(violations)
  if (!publicationEndpoint || !capability || !chain) {
    throw new PlatformApiError("PUBLICATION_VALIDATION_INCOMPLETE", 500)
  }
  return {
    publicationEndpoint,
    capability,
    chain,
    ownedConnections,
    providerCredentialProfiles: providerCredentialProfiles.sort((left, right) =>
      left.profile_id.localeCompare(right.profile_id) || left.revision - right.revision),
    models,
    projectedMappings,
  }
}

async function snapshotForResource(
  options: AiResourcePublicationWorkflowOptions,
  resource: ResourceRegistration,
  publicationId: string,
  endpointRevision: number,
  resourceRevision: number,
  requestId: string,
  prepared?: Awaited<ReturnType<typeof collectPublicationInputs>>,
): Promise<GatewayProjectionSnapshot> {
  const inputs = prepared ?? await collectPublicationInputs(options, resource)
  const {
    publicationEndpoint,
    capability,
    chain,
    ownedConnections,
    providerCredentialProfiles,
    models,
    projectedMappings,
  } = inputs

  const withoutDigest: Omit<GatewayProjectionSnapshot, "snapshot_digest"> = {
    tenant_id: resource.tenant_id,
    publication_id: publicationId,
    request_id: requestId,
    resource_id: resource.resource_id,
    capability_id: capability.capability_id,
    endpoint_revision: endpointRevision,
    resource_revision: resourceRevision,
    policy_revision: chain.one_policy_revision,
    resource_digest: resourceContentDigest(resource),
    resource: { ...resource },
    publication_endpoint: { ...publicationEndpoint },
    one_policy_chain: chain.chain,
    connections: ownedConnections.map((connection) => ({ ...connection })),
    provider_credential_profiles: providerCredentialProfiles.map((profile) => structuredClone(profile)),
    models: models.map((model) => ({ ...model })),
    model_mappings: projectedMappings.map((mapping) => ({ ...mapping })),
  }
  return {
    ...withoutDigest,
    snapshot_digest: snapshotDigest(withoutDigest),
  }
}

export function createAiResourcePublicationWorkflow(
  options: AiResourcePublicationWorkflowOptions,
): AiResourcePublicationWorkflow {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  let publicationSequence = 0
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${++publicationSequence}`)
  const store = options.store

  return {
    projectionSource: store,

    async requestReview(input) {
      const resource = await options.resources.getResource(input)
      const prepared = await collectPublicationInputs(options, resource)
      const existing = resource.publication_request
      const publicationReference = await store.preparePublicationReference(input)
      if (!publicationReference) {
        resourceNotPublishable([{
          code: "PUBLICATION_ENDPOINT_REQUIRED",
          field: "publication_endpoint",
          message: "Configure a publication hostname and base path",
        }])
      }
      if (existing?.state === "PENDING" && !existing.failure_code) {
        return workflowRequestView(publicationReference.publicationId, existing)
      }
      const request: ResourcePublicationRequest = {
        request_id: idFactory("publication-request"),
        state: "PENDING",
        requested_by: input.requestedBy,
        requested_at: now(),
        reviewed_by: null,
        reviewed_at: null,
        publication_state: "PENDING_REVIEW",
        attempt_id: null,
        failure_code: null,
      }
      const snapshot = await snapshotForResource(
        options,
        resource,
        publicationReference.publicationId,
        publicationReference.endpointRevision,
        publicationReference.resourceRevision,
        request.request_id,
        prepared,
      )
      const saved = await store.saveReviewSnapshot({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        request,
        snapshot,
      })
      return workflowRequestView(publicationReference.publicationId, saved)
    },

    async review(input) {
      const request = await store.getRequest({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        requestId: input.requestId,
      })
      if (!request || request.state !== "PENDING") {
        throw new PlatformApiError("PUBLICATION_REQUEST_NOT_PENDING", 409)
      }
      const reviewedAt = now()
      if (input.decision === "REJECT") {
        return store.reject({
          tenantId: input.tenantId,
          resourceId: input.resourceId,
          requestId: input.requestId,
          reviewerId: input.reviewerId,
          reviewedAt,
        })
      }
      const claim = await store.claimBuild({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        requestId: input.requestId,
        reviewerId: input.reviewerId,
        reviewedAt,
      })
      if (claim.state === "READY") {
        return options.resources.getResource({
          tenantId: input.tenantId,
          resourceId: input.resourceId,
        })
      }
      await options.onBuildClaimed?.(claim)
      let projection: GatewayProjection
      try {
        projection = await options.projector.compile({
          tenantId: input.tenantId,
          value: { publication_id: claim.snapshot.publication_id },
        })
      } catch (error) {
        await store.markBuildFailed({
          tenantId: input.tenantId,
          resourceId: input.resourceId,
          requestId: input.requestId,
          attemptId: claim.attemptId,
          failureCode: error instanceof PlatformApiError ? error.code : "PROJECTION_BUILD_FAILED",
        })
        throw error
      }
      try {
        return await store.commitBuild({
          tenantId: input.tenantId,
          resourceId: input.resourceId,
          requestId: input.requestId,
          attemptId: claim.attemptId,
          reviewerId: input.reviewerId,
          reviewedAt,
          projection,
        })
      } catch (error) {
        await store.markBuildFailed({
          tenantId: input.tenantId,
          resourceId: input.resourceId,
          requestId: input.requestId,
          attemptId: claim.attemptId,
          failureCode: error instanceof PlatformApiError ? error.code : "PROJECTION_COMMIT_FAILED",
        })
        throw error
      }
    },
  }
}
