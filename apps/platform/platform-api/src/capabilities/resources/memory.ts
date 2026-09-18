import { PlatformApiError } from "../errors"
import type { OrganizationDirectory } from "../organizations/module"
import type {
  ResourceCreateInput,
  ResourceLifecycle,
  ResourceRegistration,
  ResourceUpdateInput,
  ResourcePublicationEndpointInput,
} from "./contract"
import type { ResourceMemoryState } from "./state"
import type { ListResourcesInput, ResourceRegistry } from "./module"

export interface ResourceMemoryOptions {
  state: ResourceMemoryState
  organizations: OrganizationDirectory
  now?: () => number
  idFactory?: (sequence: number) => string
}

function resourceKey(tenantId: string, resourceId: string): string {
  return `${tenantId}:${resourceId}`
}

function canTransition(from: ResourceLifecycle, to: ResourceLifecycle, kind?: ResourceRegistration["kind"]): boolean {
  if (from === to) return true
  return (
    (kind === "EXTENSION" && from === "DRAFT" && to === "PUBLISHED") ||
    (kind === "EXTENSION" && from === "PUBLISHED" && to === "DRAFT") ||
    (from === "PUBLISHED" && to === "DEPRECATED") ||
    (from === "DEPRECATED" && to === "RETIRED")
  )
}

const REVERSE_PROXY_FRONTEND_KINDS = new Set<ResourceRegistration["kind"]>([
  "MCP",
  "LLM",
  "API",
])

function assertReverseProxyFrontend(resource: ResourceRegistration): void {
  if (!REVERSE_PROXY_FRONTEND_KINDS.has(resource.kind)) {
    throw new PlatformApiError(
      "RESOURCE_KIND_NOT_FRONTEND",
      422,
      "Only a reverse-proxy Frontend Resource can own a Gateway publication endpoint",
    )
  }
}

function assertInstallationResourceIdentity(
  current: ResourceRegistration,
  value: ResourceUpdateInput,
): void {
  if (!current.installation_owned) return
  if (value.owner_organization_id !== undefined && value.owner_organization_id !== current.owner_organization_id) {
    throw new PlatformApiError("INSTALLATION_OWNED_RESOURCE_IDENTITY", 409)
  }
  const forbiddenField = [
    "kind",
    "resource_id",
    "service_kind",
    "installation_owned",
    "enforcement_point_id",
    "environment_id",
    "authentication_strategy",
  ].find((field) => Object.prototype.hasOwnProperty.call(value, field))
  if (forbiddenField) throw new PlatformApiError("INSTALLATION_OWNED_RESOURCE_IDENTITY", 409)
}

export function createInMemoryResourceRegistry(
  options: ResourceMemoryOptions,
): ResourceRegistry {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((sequence) => `resource-${sequence}`)

  const getResource = async ({ tenantId, resourceId }: { tenantId: string; resourceId: string }) => {
    const resource = options.state.resources.get(resourceKey(tenantId, resourceId))
    if (!resource) {
      throw new PlatformApiError("RESOURCE_NOT_FOUND", 404)
    }
    return resource
  }

  const assertReadyOwnedConnection = (tenantId: string, resourceId: string): void => {
    if (
      ![...options.state.connections.values()].some(
        (connection) =>
          connection.tenant_id === tenantId &&
          connection.resource_id === resourceId &&
          connection.status === "READY",
      )
    ) {
      throw new PlatformApiError(
        "RESOURCE_CONNECTION_REQUIRED",
        422,
        "A reverse-proxy Resource needs at least one ready owned Connection before publication",
      )
    }
  }

  const updateResource = async (input: {
    tenantId: string
    resourceId: string
    value: ResourceUpdateInput
  }) => {
    const current = await getResource(input)
    assertInstallationResourceIdentity(current, input.value)
    if (Object.keys(input.value).length === 1 && input.value.documentation !== undefined) {
      const updated = { ...current, documentation: input.value.documentation }
      options.state.resources.set(resourceKey(input.tenantId, input.resourceId), updated)
      return updated
    }
    if (current.lifecycle !== "DRAFT") {
      throw new PlatformApiError(
        "PUBLISHED_RESOURCE_IMMUTABLE",
        409,
        "Only draft Resources can change governed content",
      )
    }
    if (input.value.owner_organization_id) {
      await options.organizations.get({
        tenantId: input.tenantId,
        organizationId: input.value.owner_organization_id,
      })
    }
    if (input.value.extension_metadata !== undefined && input.value.extension_metadata !== null && current.kind !== "EXTENSION") {
      throw new PlatformApiError("EXTENSION_METADATA_NOT_ALLOWED", 422, "Extension metadata is only allowed for EXTENSION resources")
    }
    const updated: ResourceRegistration = {
      ...current,
      ...(input.value.display_name === undefined
        ? {}
        : { display_name: input.value.display_name.trim() }),
      ...(input.value.owner_organization_id === undefined
        ? {}
        : { owner_organization_id: input.value.owner_organization_id }),
      ...(input.value.documentation === undefined ? {} : { documentation: input.value.documentation }),
      ...(input.value.version === undefined ? {} : { version: input.value.version }),
      ...(input.value.capabilities === undefined
        ? {}
        : { capabilities: input.value.capabilities }),
      ...(input.value.extension_metadata === undefined
        ? {}
        : { extension_metadata: input.value.extension_metadata }),
    }
    options.state.resources.set(resourceKey(input.tenantId, input.resourceId), updated)
    const revisionKey = resourceKey(input.tenantId, input.resourceId)
    options.state.resourceRevisions.set(
      revisionKey,
      (options.state.resourceRevisions.get(revisionKey) ?? 1) + 1,
    )
    return updated
  }

  const setLifecycle = async (input: {
    tenantId: string
    resourceId: string
    lifecycle: ResourceLifecycle
  }) => {
    const current = await getResource(input)
    if (current.installation_owned && input.lifecycle !== current.lifecycle && ["DEPRECATED", "RETIRED"].includes(input.lifecycle)) {
      throw new PlatformApiError("INSTALLATION_OWNED_RESOURCE_CANNOT_RETIRE", 409)
    }
    if (input.lifecycle === "PUBLISHED" && current.kind !== "EXTENSION") {
      throw new PlatformApiError(
        "PUBLICATION_REQUIRES_APPROVAL",
        409,
        "Use a publication request and reviewer decision to publish a Resource",
      )
    }
    if (!canTransition(current.lifecycle, input.lifecycle, current.kind)) {
      throw new PlatformApiError(
        "INVALID_RESOURCE_LIFECYCLE_TRANSITION",
        409,
        `Cannot transition Resource from ${current.lifecycle} to ${input.lifecycle}`,
      )
    }
    const updated = { ...current, lifecycle: input.lifecycle }
    options.state.resources.set(resourceKey(input.tenantId, input.resourceId), updated)
    return updated
  }

  return {
    async listResources(input: ListResourcesInput) {
      return [...options.state.resources.values()]
        .filter((resource) => resource.tenant_id === input.tenantId)
        .sort((left, right) => left.display_name.localeCompare(right.display_name))
    },

    getResource,

    async createResource(input: { tenantId: string; value: ResourceCreateInput; resourceId?: string }) {
      if ((input.value.kind === "API") !== (input.value.api !== undefined)) {
        throw new PlatformApiError("API_RESOURCE_METADATA_INVALID", 422)
      }
      if (input.value.extension_metadata !== undefined && input.value.extension_metadata !== null && input.value.kind !== "EXTENSION") {
        throw new PlatformApiError("EXTENSION_METADATA_NOT_ALLOWED", 422, "Extension metadata is only allowed for EXTENSION resources")
      }
      await options.organizations.get({
        tenantId: input.tenantId,
        organizationId: input.value.owner_organization_id,
      })
      const resourceId = input.resourceId?.trim() || (() => {
        options.state.resourceSequence += 1
        return idFactory(options.state.resourceSequence)
      })()
      if (options.state.resources.has(resourceKey(input.tenantId, resourceId))) {
        throw new PlatformApiError("RESOURCE_ID_EXISTS", 409)
      }
      const extensionMetadata = input.value.extension_metadata
        ? {
            ...input.value.extension_metadata,
            ...(input.value.extension_metadata.package_type === "BOT" && !input.value.extension_metadata.resource_id
              ? { resource_id: resourceId }
              : {}),
          }
        : null
      const resource: ResourceRegistration = {
        tenant_id: input.tenantId,
        resource_id: resourceId,
        display_name: input.value.display_name.trim(),
        kind: input.value.kind,
        owner_organization_id: input.value.owner_organization_id,
        registered_by_subject_id: undefined,
        authentication_strategy: input.value.authentication_strategy,
        environment_id: input.value.environment_id,
        version: input.value.version,
        lifecycle: "DRAFT",
        publication_endpoint: null,
        publication_request: null,
        operational_state: "UNKNOWN",
        health_observed_at: undefined,
        capabilities: input.value.capabilities ?? [],
        capabilities_owner_defined: true,
        mcp_authorization: null,
        api: input.value.api ?? null,
        extension_metadata: extensionMetadata,
        enforcement_point_id: input.value.enforcement_point_id,
        created_at: now(),
      }
      options.state.resources.set(resourceKey(input.tenantId, resource.resource_id), resource)
      options.state.resourceRevisions.set(resourceKey(input.tenantId, resource.resource_id), 1)
      return resource
    },

    updateResource,
    setLifecycle,

    async setPublicationEndpoint(input: {
      tenantId: string
      resourceId: string
      value: ResourcePublicationEndpointInput
    }) {
      const current = await getResource(input)
      if (current.lifecycle !== "DRAFT") {
        throw new PlatformApiError(
          "PUBLISHED_RESOURCE_IMMUTABLE",
          409,
          "A published Resource cannot change its publication endpoint",
        )
      }
      assertReverseProxyFrontend(current)
      assertReadyOwnedConnection(input.tenantId, input.resourceId)
      const updated = {
        ...current,
        // A new endpoint creates a new publication revision. Any request for
        // the previous endpoint must not remain attached to the draft.
        publication_request: null,
        publication_endpoint: {
          ...input.value,
          visibility: input.value.visibility ?? "PRIVATE",
        },
      }
      options.state.resources.set(resourceKey(input.tenantId, input.resourceId), updated)
      const endpointKey = resourceKey(input.tenantId, input.resourceId)
      options.state.publicationEndpointRevisions.set(
        endpointKey,
        (options.state.publicationEndpointRevisions.get(endpointKey) ?? 0) + 1,
      )
      return updated
    },

    async requestPublication() {
      throw new PlatformApiError(
        "PUBLICATION_WORKFLOW_REQUIRED",
        409,
        "Resource publication must go through the snapshot/build/review workflow",
      )
    },

    async reviewPublication() {
      throw new PlatformApiError(
        "PUBLICATION_WORKFLOW_REQUIRED",
        409,
        "Resource publication must go through the snapshot/build/review workflow",
      )
    },
  }
}
