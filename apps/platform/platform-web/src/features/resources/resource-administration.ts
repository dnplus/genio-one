import type {
  ConnectionSummary,
  IdentitySession,
  OverviewSnapshot,
  RegisterConnectionInput,
  ResourceRegistration,
} from "@/domain/contracts"
import { organizationAdministratorSubjectIds } from "@/domain/organization-roles"
import {
  addConnectionModelMapping,
  createPublicModel,
  ensureStandardModelRoutingPolicy,
  registerConnection,
  ProductApiError,
  requestResourcePublication,
  reviewResourcePublication,
  saveStandardResourceEnforcement,
  verifyResourceConnection,
} from "@/lib/product-api"

export type ResourceFamily = "AI" | "API" | "ACCESS" | "EXTENSION"
export type PublicationListState = ResourceRegistration["lifecycle"] | "PENDING_APPROVAL" | "FAILED"
export type InventoryVisibility = "ACTIVE" | "EXITING" | "ARCHIVED"

export function resourceInventoryVisibility(
  resource: Pick<ResourceRegistration, "lifecycle"> & {
    publication_request?: { state?: string; publication_state?: string | null } | null
  },
): InventoryVisibility {
  if (resource.lifecycle === "RETIRED") return "ARCHIVED"
  if (resource.lifecycle === "DEPRECATED") return "EXITING"
  return "ACTIVE"
}

export function connectionInventoryVisibility(
  lifecycle: "DRAFT" | "ENABLED" | "DISABLED" | "REVOKE_PENDING" | "REVOKED",
): InventoryVisibility {
  if (lifecycle === "REVOKED" || lifecycle === "REVOKE_PENDING") return "ARCHIVED"
  return "ACTIVE"
}
export type ResourceAdministrationStage =
  | "REGISTER_CONNECTION"
  | "VERIFY_CONNECTION"
  | "MAP_PUBLIC_MODEL"
  | "PREPARE_ROUTING"
  | "PREPARE_ENFORCEMENT"
  | "REQUEST_PUBLICATION"
  | "REVIEW_PUBLICATION"

export type ResourceAdministrationOutcome<T> =
  | { status: "SUCCEEDED"; value: T; completedStages: ResourceAdministrationStage[] }
  | { status: "FAILED"; error: unknown; failedStage: ResourceAdministrationStage; completedStages: ResourceAdministrationStage[] }

export interface ResourceAdministrationState {
  canManageResource: boolean
  canManageDraft: boolean
  canRequestPublication: boolean
  hasAvailableConnection: boolean
  isDraft: boolean
  isPublished: boolean
  pendingPublication: boolean
  publicationBlocker: "CONNECTION_REQUIRED" | "ENDPOINT_REQUIRED" | null
}

export interface ResourcePublicationError {
  code: string
  violations: ReadonlyArray<{ code: string; message: string; field?: string }>
}

export function publicationErrorDetails(caught: unknown): ResourcePublicationError {
  if (caught instanceof ProductApiError) {
    return {
      code: caught.message,
      violations: caught.violations.length
        ? caught.violations
        : [{ code: caught.message, message: caught.message }],
    }
  }
  const code = caught instanceof Error && caught.message.trim()
    ? caught.message
    : "PUBLICATION_REQUEST_FAILED"
  return { code, violations: [{ code, message: code }] }
}

export interface ResourceAdministrationOperations {
  registerConnection: typeof registerConnection
  verifyResourceConnection: typeof verifyResourceConnection
  addConnectionModelMapping: typeof addConnectionModelMapping
  createPublicModel: typeof createPublicModel
  ensureStandardModelRoutingPolicy: typeof ensureStandardModelRoutingPolicy
  saveStandardResourceEnforcement: typeof saveStandardResourceEnforcement
  requestResourcePublication: typeof requestResourcePublication
  reviewResourcePublication: typeof reviewResourcePublication
}

type RegisteredConnection = Awaited<ReturnType<typeof registerConnection>>

const defaultOperations: ResourceAdministrationOperations = {
  registerConnection,
  verifyResourceConnection,
  addConnectionModelMapping,
  createPublicModel,
  ensureStandardModelRoutingPolicy,
  saveStandardResourceEnforcement,
  requestResourcePublication,
  reviewResourcePublication,
}

async function runStages<T>(
  stages: Array<{
    id: ResourceAdministrationStage
    run: () => Promise<unknown>
  }>,
  result: () => T,
): Promise<ResourceAdministrationOutcome<T>> {
  const completedStages: ResourceAdministrationStage[] = []
  for (const stage of stages) {
    try {
      await stage.run()
      completedStages.push(stage.id)
    } catch (error) {
      return { status: "FAILED", error, failedStage: stage.id, completedStages }
    }
  }
  return { status: "SUCCEEDED", value: result(), completedStages }
}

export function resourceFamily(resource: ResourceRegistration): ResourceFamily {
  if (resource.kind === "LLM" || resource.kind === "MCP" || resource.api?.a2a) return "AI"
  if (resource.kind === "SAAS") return "ACCESS"
  if (resource.kind === "EXTENSION") return "EXTENSION"
  return "API"
}

export function resourceSubtype(resource: ResourceRegistration) {
  if (resource.kind === "LLM") return "Model"
  if (resource.api?.a2a) return "A2A Agent"
  if (resource.kind === "SAAS") return "Site"
  return resource.kind
}

export function resourceFamilyLabel(resource: ResourceRegistration) {
  const family = resourceFamily(resource)
  if (family === "ACCESS") return "Access resources"
  if (family === "EXTENSION") return "Extension"
  return family
}

export function enforcementLabel(resource: ResourceRegistration) {
  if (resource.builtin_service) return "GenioOne Platform"
  if (resource.service_kind === "GENIO_BOT") return "Genio Bot service"
  if (resourceFamily(resource) === "ACCESS") return "Access Gateway"
  if (resourceFamily(resource) === "EXTENSION") return "Endpoint / Agent Runtime"
  return resourceFamily(resource) === "AI" ? "AI Gateway" : "API Gateway"
}

export function gatewayGroupMatchesResource(resource: ResourceRegistration, gatewayId: string) {
  const family = resourceFamily(resource)
  if (family === "AI") return gatewayId === "genio-ai-mcp-gateway"
  if (family === "API") return gatewayId === "genio-api-gateway"
  if (family === "ACCESS") {
    return gatewayId === "genio-access-gateway" || gatewayId === "genio-secure-access-gateway"
  }
  return false
}

export function governanceStatus(resource: ResourceRegistration) {
  return resource.builtin_service ? "Built-in MCP" : resource.kind === "SAAS" ? "Tracked" : "Governed"
}

export function requiresPublicationEndpoint(resource: ResourceRegistration) {
  return !resource.builtin_service && (resource.kind === "API" || resource.kind === "MCP" || resource.kind === "LLM")
}

export function publicationEndpointReady(resource: ResourceRegistration) {
  if (!requiresPublicationEndpoint(resource)) return true
  const endpoint = resource.publication_endpoint
  return Boolean(endpoint?.hostname && endpoint.base_path && endpoint.dns_verification === "VERIFIED")
}

export function hasPendingPublication(resource: ResourceRegistration) {
  return resource.publication_request?.state === "PENDING" &&
    resource.publication_request.publication_state !== "FAILED"
}

export function publicationState(resource: ResourceRegistration): PublicationListState {
  if (resource.publication_request?.publication_state === "FAILED") return "FAILED"
  return hasPendingPublication(resource) ? "PENDING_APPROVAL" : resource.lifecycle
}

export function resourceAccessSummary(data: OverviewSnapshot, resourceId: string) {
  const entitlements = data.ownedEntitlements.filter(
    (entitlement) => entitlement.resource_id === resourceId && entitlement.state === "ACTIVE",
  )
  const subjectIds = new Set(entitlements.map((entitlement) => entitlement.subject_id))
  data.auditEvents.forEach((event) => {
    if (event.resource_id === resourceId) subjectIds.add(event.subject.subject_id)
  })
  data.activity.recent_activity.forEach((event) => {
    if (event.resource_id === resourceId) subjectIds.add(event.subject_id)
  })
  data.apiActivity.events.forEach((event) => {
    if (event.resource_id === resourceId && event.subject_id) subjectIds.add(event.subject_id)
  })
  return { entitlementCount: entitlements.length, identityCount: subjectIds.size }
}

export function resourceAdministrationState(input: {
  data: OverviewSnapshot
  identity: IdentitySession
  isTenantAdministrator: boolean
  resource: ResourceRegistration
}): ResourceAdministrationState {
  const { data, identity, isTenantAdministrator, resource } = input
  const ownerOrganization = data.organizations.find(
    (organization) => organization.organization_id === resource.owner_organization_id,
  )
  const isOrganizationAdministrator = ownerOrganization
    ? organizationAdministratorSubjectIds(ownerOrganization).includes(identity.subject_id)
    : false
  const pendingPublication = hasPendingPublication(resource)
  const isDraft = resource.lifecycle === "DRAFT"
  const hasAvailableConnection = data.connections.some(
    (connection) => connection.resource_id === resource.resource_id && connection.lifecycle === "ENABLED",
  )
  const publicationBlocker = requiresPublicationEndpoint(resource) && !hasAvailableConnection
    ? "CONNECTION_REQUIRED"
    : !publicationEndpointReady(resource)
      ? "ENDPOINT_REQUIRED"
      : null
  const canManageResource = !resource.builtin_service && (isTenantAdministrator || isOrganizationAdministrator)
  return {
    canManageResource,
    canManageDraft: isDraft && !pendingPublication && canManageResource,
    canRequestPublication: canManageResource && !pendingPublication && (isDraft || resource.lifecycle === "PUBLISHED"),
    hasAvailableConnection,
    isDraft,
    isPublished: resource.lifecycle === "PUBLISHED" || resource.lifecycle === "DEPRECATED",
    pendingPublication,
    publicationBlocker,
  }
}

export function createResourceAdministration(
  operations: ResourceAdministrationOperations = defaultOperations,
) {
  return {
    async registerVerifiedConnection(input: {
      tenantId: string
      connection: RegisterConnectionInput
      mappings?: Array<{ modelId: string; providerModel: string }>
      initialPublicModel?: { modelName: string; displayName: string; providerModel: string }
    }): Promise<ResourceAdministrationOutcome<{ connection: RegisteredConnection; verified: ConnectionSummary }>> {
      let connection: RegisteredConnection | null = null
      let verified: ConnectionSummary | null = null
      const stages: Array<{ id: ResourceAdministrationStage; run: () => Promise<unknown> }> = [
        {
          id: "REGISTER_CONNECTION",
          run: async () => {
            connection = await operations.registerConnection(input.tenantId, input.connection)
          },
        },
        {
          id: "VERIFY_CONNECTION",
          run: async () => {
            verified = await operations.verifyResourceConnection(
              input.tenantId,
              input.connection.resourceId,
              connection!.connection_id,
            )
          },
        },
      ]
      for (const mapping of input.mappings ?? []) {
        stages.push({
          id: "MAP_PUBLIC_MODEL",
          run: () => operations.addConnectionModelMapping(
            input.tenantId,
            input.connection.resourceId,
            mapping.modelId,
            {
              connectionId: connection!.connection_id,
              providerModel: mapping.providerModel,
              expectedConnectionRevision: verified!.configuration_revision,
            },
          ),
        })
      }
      if (input.initialPublicModel) {
        stages.push({
          id: "MAP_PUBLIC_MODEL",
          run: () => operations.createPublicModel(
            input.tenantId,
            input.connection.resourceId,
            {
              modelName: input.initialPublicModel!.modelName,
              displayName: input.initialPublicModel!.displayName,
              connectionId: connection!.connection_id,
              providerModel: input.initialPublicModel!.providerModel,
            },
          ),
        })
      }
      return runStages(stages, () => ({ connection: connection!, verified: verified! }))
    },

    requestPublication(input: {
      tenantId: string
      resource: ResourceRegistration
      prepareStandardWorkflow: boolean
      autoApprove: boolean
    }) {
      let requestId = ""
      const stages: Array<{ id: ResourceAdministrationStage; run: () => Promise<unknown> }> = []
      if (input.prepareStandardWorkflow) {
        stages.push(
          { id: "PREPARE_ROUTING", run: () => operations.ensureStandardModelRoutingPolicy(input.tenantId, input.resource) },
          { id: "PREPARE_ENFORCEMENT", run: () => operations.saveStandardResourceEnforcement(input.tenantId, input.resource) },
        )
      }
      stages.push({
        id: "REQUEST_PUBLICATION",
        run: async () => {
          const request = await operations.requestResourcePublication(input.tenantId, input.resource.resource_id)
          requestId = request.request_id
        },
      })
      if (input.autoApprove) {
        stages.push({
          id: "REVIEW_PUBLICATION",
          run: () => operations.reviewResourcePublication(
            input.tenantId,
            input.resource.resource_id,
            requestId,
            "APPROVE",
          ),
        })
      }
      return runStages(stages, () => ({ requestId }))
    },

    reviewPublication(input: {
      tenantId: string
      resource: ResourceRegistration
      requestId: string
      decision: "APPROVE" | "REJECT"
    }) {
      const stages: Array<{ id: ResourceAdministrationStage; run: () => Promise<unknown> }> = []
      stages.push({
        id: "REVIEW_PUBLICATION",
        run: () => operations.reviewResourcePublication(
          input.tenantId,
          input.resource.resource_id,
          input.requestId,
          input.decision,
        ),
      })
      return runStages(stages, () => ({ decision: input.decision }))
    },
  }
}

export const resourceAdministration = createResourceAdministration()
