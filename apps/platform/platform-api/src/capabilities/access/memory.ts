import { PlatformApiError } from "../errors"
import type { ModelEntitlementCatalog } from "../entitlements/module"
import type { TenantConfigurationStore } from "../configuration/module"
import type { IdentityDirectory } from "../identity/module"
import type { OrganizationDirectory } from "../organizations/module"
import type { ResourceRegistry } from "../resources/module"
import type { AccessNotification, AccessRequest, LegacyEntitlement } from "./contract"
import type { AccessActor, AccessGovernanceStore } from "./module"

function visibleToOwner(actor: AccessActor, organizationId: string): boolean {
  return actor.role === "TENANT_ADMINISTRATOR" || actor.organizationIds.includes(organizationId)
}

function legacyEntitlement(
  value: Awaited<ReturnType<ModelEntitlementCatalog["grant"]>>,
  now: number,
  revocationReason: string | null = null,
): LegacyEntitlement {
  return {
    entitlement_id: value.entitlement_id,
    subject_id: value.subject_id!,
    resource_id: value.resource_id,
    capability_id: value.capability_id,
    state: value.state === "ACTIVE" && value.expires_at !== null && value.expires_at <= now ? "EXPIRED" : value.state,
    valid_from: value.starts_at,
    valid_until: value.expires_at ?? 4_102_444_800,
    revocation_reason: revocationReason,
  }
}

export function createInMemoryAccessGovernanceStore(options: {
  resources: ResourceRegistry
  entitlements: ModelEntitlementCatalog
  configuration: TenantConfigurationStore
  identity: Pick<IdentityDirectory, "inventory">
  organizations: Pick<OrganizationDirectory, "list">
  now?: () => number
  idFactory?: () => string
}): AccessGovernanceStore {
  const requests = new Map<string, AccessRequest>()
  const ownerOrganizations = new Map<string, string>()
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  const idFactory = options.idFactory ?? (() => crypto.randomUUID())
  const key = (tenantId: string, requestId: string) => `${tenantId}:${requestId}`
  const allEntitlements = async (tenantId: string) => (await options.entitlements.list({ tenantId }))
    .filter((value) => value.subject_id !== null)
    .map((value) => legacyEntitlement(value, now()))
  const get = (tenantId: string, requestId: string) => {
    const request = requests.get(key(tenantId, requestId))
    if (!request) throw new PlatformApiError("ACCESS_REQUEST_NOT_FOUND", 404)
    return request
  }
  return {
    async catalog({ tenantId, actor }) {
      const [resources, entitlements, identity, organizations] = await Promise.all([
        options.resources.listResources({ tenantId }),
        allEntitlements(tenantId),
        options.identity.inventory({ tenantId }),
        options.organizations.list({ tenantId }),
      ])
      const owners = new Map(organizations.map((organization) => [organization.organization_id, organization.display_name]))
      const capabilities = resources.flatMap((resource) => {
        if (resource.lifecycle !== "PUBLISHED") return []
        const visibility = resource.publication_endpoint?.visibility
        return resource.capabilities.map((capability) => {
          const entitled = entitlements.some((value) =>
            value.subject_id === actor.subjectId && value.resource_id === resource.resource_id &&
            value.capability_id === capability.capability_id && value.state === "ACTIVE" && value.valid_from <= now())
          if (resource.kind !== "EXTENSION" && visibility !== "PUBLIC" && visibility !== "REQUEST" && !entitled) return null
          const pending = [...requests.values()].some((request) =>
            request.target_subject === actor.subjectId && request.resource_id === resource.resource_id &&
            request.capability_id === capability.capability_id && request.state === "PENDING")
          const publicationEndpoint = resource.publication_endpoint && (entitled || visibility === "PUBLIC")
            ? { hostname: resource.publication_endpoint.hostname, base_path: resource.publication_endpoint.base_path }
            : undefined
          return {
            resource_id: resource.resource_id,
            resource_display_name: resource.display_name,
            capability_id: capability.capability_id,
            capability_display_name: capability.display_name,
            resource_owner_id: resource.owner_organization_id,
            resource_owner_display_name: owners.get(resource.owner_organization_id) ?? resource.owner_organization_id,
            connection_status: resource.kind === "EXTENSION" && resource.lifecycle === "PUBLISHED" && resource.extension_metadata &&
              typeof resource.extension_metadata.manifest_digest === "string" &&
              resource.extension_metadata.manifest_digest.trim().length > 0 &&
              typeof resource.extension_metadata.artifact_digest === "string" &&
              resource.extension_metadata.artifact_digest.trim().length > 0
              ? "READY"
              : resource.operational_state === "HEALTHY" ? "READY" : "UNAVAILABLE",
            access: entitled ? "ENTITLED" as const : resource.kind === "EXTENSION" ? "REQUEST" as const : visibility === "PUBLIC" ? "AUTO_GRANT" as const : "REQUEST" as const,
            hub_status: entitled ? "CONNECTED" as const : pending ? "PENDING_APPROVAL" as const : resource.kind === "EXTENSION" ? "REQUEST_ACCESS" as const : visibility === "PUBLIC" ? "AVAILABLE" as const : "REQUEST_ACCESS" as const,
            restriction_reason: null,
            ...(publicationEndpoint ? { publication_endpoint: publicationEndpoint } : {}),
            ...(resource.kind === "EXTENSION" ? {
              resource_kind: resource.kind,
              extension_metadata: resource.extension_metadata ?? null,
            } : {}),
          }
        })
      }).filter((capability): capability is NonNullable<typeof capability> => capability !== null)
      const subject = identity.subjects.find((candidate) => candidate.subject_id === actor.subjectId)
      return {
        tenant_id: tenantId,
        catalog_revision: `catalog-${resources.length}`,
        subject_id: actor.subjectId,
        subject_display_name: subject?.profile.display_name ?? subject?.profile.email ?? actor.subjectId,
        capabilities,
      }
    },
    async request({ tenantId, actor, value }) {
      const resource = await options.resources.getResource({ tenantId, resourceId: value.resource_id })
      if (
        resource.lifecycle !== "PUBLISHED" || (resource.kind !== "EXTENSION" && resource.publication_endpoint?.visibility !== "REQUEST") ||
        !resource.capabilities.some((capability) => capability.capability_id === value.capability_id)
      ) throw new PlatformApiError("ACCESS_NOT_REQUESTABLE", 422)
      const entitlements = await allEntitlements(tenantId)
      const existingEntitlement = entitlements.find((candidate) =>
        candidate.subject_id === actor.subjectId && candidate.resource_id === value.resource_id &&
        candidate.capability_id === value.capability_id && candidate.state === "ACTIVE" && candidate.valid_from <= now())
      if (existingEntitlement) return { ALREADY_ENTITLED: existingEntitlement.entitlement_id }
      const existing = [...requests.values()].find((candidate) =>
        candidate.target_subject === actor.subjectId && candidate.resource_id === value.resource_id &&
        candidate.capability_id === value.capability_id && candidate.state === "PENDING")
      if (existing) return { EXISTING: structuredClone(existing) }
      const configuration = await options.configuration.published({ tenantId })
      if (
        !configuration?.settings.request_form.enabled || !value.justification.trim() ||
        !configuration.settings.ttl_options_seconds.includes(value.requested_valid_for_seconds)
      ) throw new PlatformApiError("ACCESS_REQUEST_CONFIGURATION_INVALID", 422)
      const requestId = `access-request-${idFactory()}`
      const createdAt = now()
      const request: AccessRequest = {
        access_request_id: requestId,
        requester: actor.subjectId,
        target_subject: actor.subjectId,
        acting_client: { acting_client_id: actor.clientId, evidence_level: "VERIFIED" },
        resource_id: value.resource_id,
        capability_id: value.capability_id,
        justification: value.justification.trim(),
        requested_valid_for: value.requested_valid_for_seconds,
        configuration_revision: configuration.revision,
        approval_workflow_version: configuration.settings.approval_workflow_version,
        approver: resource.owner_organization_id,
        state: "PENDING",
        created_at: createdAt,
        expires_at: null,
        resolved_at: null,
        resolution_reason: null,
        policy_version_at_creation: "one-policy-current",
        approval_stages: [{
          stage_id: "resource-owner-organization",
          approver: { kind: "ORGANIZATION", organization_id: resource.owner_organization_id },
          primary_approver: resource.owner_organization_id,
          assigned_approver: resource.owner_organization_id,
          delegation_id: null,
          state: "PENDING",
          decided_by: null,
          decided_at: null,
        }],
        current_approval_stage: 0,
      }
      ownerOrganizations.set(key(tenantId, requestId), resource.owner_organization_id)
      requests.set(key(tenantId, requestId), request)
      return { CREATED: structuredClone(request) }
    },
    async listMine({ tenantId, actor }) {
      return [...requests.entries()]
        .filter(([entryKey, value]) => entryKey.startsWith(`${tenantId}:`) &&
          (value.requester === actor.subjectId || value.target_subject === actor.subjectId))
        .map(([, value]) => structuredClone(value))
    },
    async listManagement({ tenantId, actor }) {
      return [...requests.entries()].filter(([entryKey]) => entryKey.startsWith(`${tenantId}:`)).map(([, value]) => value)
        .filter((value) => visibleToOwner(actor, ownerOrganizations.get(key(tenantId, value.access_request_id)) ?? ""))
        .map((value) => structuredClone(value))
    },
    async decide({ tenantId, actor, requestId, value }) {
      const current = get(tenantId, requestId)
      if (current.state !== "PENDING" || !visibleToOwner(actor, ownerOrganizations.get(key(tenantId, requestId)) ?? "")) {
        throw new PlatformApiError("ACCESS_DECISION_DENIED", 403)
      }
      const decidedAt = now()
      let entitlement: LegacyEntitlement | null = null
      if ("APPROVE" in value.decision) {
        if (value.decision.APPROVE.valid_until <= decidedAt) throw new PlatformApiError("ENTITLEMENT_WINDOW_INVALID", 422)
        entitlement = legacyEntitlement(await options.entitlements.grant({
          tenantId,
          value: {
            subject_id: current.target_subject,
            resource_id: current.resource_id,
            capability_id: current.capability_id,
            starts_at: decidedAt,
            expires_at: value.decision.APPROVE.valid_until,
          },
        }), decidedAt)
        current.state = "APPROVED"
        current.expires_at = value.decision.APPROVE.valid_until
      } else {
        current.state = "DENIED"
        current.resolution_reason = value.decision.DENY.reason.trim()
      }
      current.resolved_at = decidedAt
      current.approval_stages[0] = {
        ...current.approval_stages[0]!, state: current.state,
        decided_by: { subject_id: actor.subjectId, evidence_level: "VERIFIED" }, decided_at: decidedAt,
      }
      requests.set(key(tenantId, requestId), current)
      return { request: structuredClone(current), entitlement }
    },
    async cancel({ tenantId, actor, requestId, value }) {
      const current = get(tenantId, requestId)
      if (current.requester !== actor.subjectId || current.state !== "PENDING") {
        throw new PlatformApiError("ACCESS_REQUEST_CANCEL_DENIED", 403)
      }
      current.state = "CANCELLED"
      current.approval_stages[0] = { ...current.approval_stages[0]!, state: "CANCELLED" }
      current.resolved_at = now()
      current.resolution_reason = value.reason.trim()
      requests.set(key(tenantId, requestId), current)
      return structuredClone(current)
    },
    async revokeEntitlement({ tenantId, actor, entitlementId, value }) {
      const entitlement = (await options.entitlements.list({ tenantId }))
        .find((candidate) => candidate.entitlement_id === entitlementId)
      if (!entitlement) throw new PlatformApiError("ENTITLEMENT_NOT_FOUND", 404)
      if (entitlement.state !== "ACTIVE") {
        throw new PlatformApiError("ENTITLEMENT_NOT_ACTIVE", 409)
      }
      const resource = await options.resources.getResource({
        tenantId,
        resourceId: entitlement.resource_id,
      })
      if (!visibleToOwner(actor, resource.owner_organization_id)) {
        throw new PlatformApiError("ENTITLEMENT_REVOCATION_DENIED", 403)
      }
      return legacyEntitlement(await options.entitlements.revoke({
        tenantId,
        entitlementId,
      }), now(), value.reason.trim())
    },
    async entitlementsForSubject({ tenantId, actor }) {
      return (await allEntitlements(tenantId)).filter((value) => value.subject_id === actor.subjectId)
    },
    async entitlementsForOwner({ tenantId, actor }) {
      const resources = await options.resources.listResources({ tenantId })
      const visible = new Set(resources.filter((resource) =>
        visibleToOwner(actor, resource.owner_organization_id)).map((resource) => resource.resource_id))
      return (await allEntitlements(tenantId)).filter((value) => visible.has(value.resource_id))
    },
    async notifications({ tenantId, actor }) {
      return [...requests.entries()].filter(([entryKey]) => entryKey.startsWith(`${tenantId}:`)).map(([, request]) => request)
        .filter((request) => request.state === "PENDING" || request.state === "APPROVED" || request.state === "DENIED")
        .filter((request) => request.requester === actor.subjectId || visibleToOwner(actor, ownerOrganizations.get(key(tenantId, request.access_request_id)) ?? ""))
        .map((request): AccessNotification => ({
          notification_id: `access-notification-${request.access_request_id}-${request.state}`,
          kind: request.state === "PENDING" ? "PENDING_APPROVAL" : request.state === "APPROVED" ? "REQUEST_APPROVED" : "REQUEST_DENIED",
          audience: request.requester === actor.subjectId ? "REQUESTER" : "RESOURCE_OWNER",
          recipient_subject_id: actor.subjectId,
          requester: request.requester,
          access_request_id: request.access_request_id,
          entitlement_id: null,
          resource_id: request.resource_id,
          capability_id: request.capability_id,
          occurred_at: request.resolved_at ?? request.created_at,
          valid_until: request.expires_at,
          delivery_channels: ["IN_APP"],
          action_path: `/management?view=access&request=${request.access_request_id}`,
        }))
    },
  }
}
