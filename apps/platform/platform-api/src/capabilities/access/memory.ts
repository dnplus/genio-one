import { PlatformApiError } from "../errors"
import type { ModelEntitlementCatalog } from "../entitlements/module"
import type { TenantConfigurationStore } from "../configuration/module"
import type { IdentityDirectory } from "../identity/module"
import type { OrganizationDirectory } from "../organizations/module"
import type { ResourceConnectionRegistry } from "../connections/module"
import type { ResourceRegistry } from "../resources/module"
import { accessGovernanceAuditEvent, type AccessGovernanceAuditWriter } from "./audit"
import type { AccessNotification, AccessRequest, LegacyEntitlement } from "./contract"
import { createKeyedSerialExecutor } from "../../persistence/keyed-serial-executor"
import {
  autoGrantActivationAuditEvent,
  autoGrantActivationIdempotencyKey,
  autoGrantActivationRequestDigest,
  recordAutoGrantActivationOnce,
  type AutoGrantActivationDisposition,
} from "./audit"
import type { AccessActor, AccessAuditWriter, AccessGovernanceStore } from "./module"

function canManageOwner(actor: AccessActor, organizationId: string): boolean {
  return actor.role === "TENANT_ADMINISTRATOR" || (
    actor.role === "ORGANIZATION_ADMINISTRATOR" &&
    actor.administratorOrganizationIds?.includes(organizationId) === true
  )
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
    valid_until: value.expires_at,
    revocation_reason: revocationReason,
  }
}

export function createInMemoryAccessGovernanceStore(options: {
  resources: ResourceRegistry
  entitlements: ModelEntitlementCatalog
  configuration: TenantConfigurationStore
  identity: Pick<IdentityDirectory, "inventory">
  organizations: Pick<OrganizationDirectory, "list">
  connections: Pick<ResourceConnectionRegistry, "list">
  audit?: AccessGovernanceAuditWriter | AccessAuditWriter
  now?: () => number
  idFactory?: () => string
}): AccessGovernanceStore {
  const requests = new Map<string, AccessRequest>()
  const ownerOrganizations = new Map<string, string>()
  const autoGrantActivations = new Map<string, {
    entitlementId: string
    requestDigest: string
    disposition: AutoGrantActivationDisposition
  }>()
  const autoGrantMutations = createKeyedSerialExecutor()
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
  const active = (value: LegacyEntitlement, at: number) =>
    value.state === "ACTIVE" && value.valid_from <= at && (value.valid_until === null || value.valid_until > at)
  const recordAutoGrantActivation = async (input: {
    tenantId: string
    actor: AccessActor
    correlationId: string
    resourceId: string
    capabilityId: string
    entitlementId: string
    disposition: "GRANTED" | "ALREADY_ENTITLED"
    occurredAt: number
  }) => {
    const audit = options.audit
    if (!audit || !("findById" in audit) || !audit.findById) {
      throw new PlatformApiError("AUTO_GRANT_AUDIT_REQUIRED", 503)
    }
    const event = autoGrantActivationAuditEvent({
      tenantId: input.tenantId,
      subjectId: input.actor.subjectId,
      clientId: input.actor.clientId,
      correlationId: input.correlationId,
      resourceId: input.resourceId,
      capabilityId: input.capabilityId,
      entitlementId: input.entitlementId,
      disposition: input.disposition,
      occurredAt: input.occurredAt,
    })
    await recordAutoGrantActivationOnce(audit, event, () => audit.record({ tenantId: input.tenantId, event }))
  }
  const governanceAudit = (): AccessGovernanceAuditWriter => {
    const audit = options.audit
    if (!audit) throw new PlatformApiError("ACCESS_AUDIT_REQUIRED", 503)
    return audit as AccessGovernanceAuditWriter
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
      const readyDiscoveries = new Set((await Promise.all(resources
        .filter((resource) => resource.builtin_service === "DISCOVERY")
        .map(async (resource) => {
          const connections = await options.connections.list({
            tenantId,
            resourceId: resource.resource_id,
          })
          return connections.some((connection) =>
            connection.connection_id === resource.resource_id &&
            connection.status === "READY" &&
            connection.lifecycle === "ENABLED" &&
            connection.verification_state === "VERIFIED" &&
            connection.health_state === "HEALTHY")
            ? resource.resource_id
            : null
        }))).filter((resourceId): resourceId is string => resourceId !== null))
      const capabilities = resources.flatMap((resource) => {
        if (resource.lifecycle !== "PUBLISHED") return []
        const visibility = resource.publication_endpoint?.visibility
        const isBuiltinDiscovery = resource.builtin_service === "DISCOVERY"
        if (isBuiltinDiscovery && !readyDiscoveries.has(resource.resource_id)) return []
        const builtinDiscovery = isBuiltinDiscovery
        return resource.capabilities.map((capability) => {
          const entitled = entitlements.some((value) =>
            value.subject_id === actor.subjectId && value.resource_id === resource.resource_id &&
            value.capability_id === capability.capability_id && value.state === "ACTIVE" && value.valid_from <= now())
          if (!builtinDiscovery && resource.kind !== "EXTENSION" && visibility !== "PUBLIC" && visibility !== "REQUEST" && !entitled) return null
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
            connection_status: builtinDiscovery ? "READY" : resource.kind === "EXTENSION" && resource.lifecycle === "PUBLISHED" && resource.extension_metadata &&
              typeof resource.extension_metadata.manifest_digest === "string" &&
              resource.extension_metadata.manifest_digest.trim().length > 0 &&
              typeof resource.extension_metadata.artifact_digest === "string" &&
              resource.extension_metadata.artifact_digest.trim().length > 0
              ? "READY"
              : resource.operational_state === "HEALTHY" ? "READY" : "UNAVAILABLE",
            access: builtinDiscovery ? "AUTO_GRANT" as const : entitled ? "ENTITLED" as const : resource.kind === "EXTENSION" ? "REQUEST" as const : visibility === "PUBLIC" ? "AUTO_GRANT" as const : "REQUEST" as const,
            hub_status: builtinDiscovery ? "CONNECTED" as const : entitled ? "CONNECTED" as const : pending ? "PENDING_APPROVAL" as const : resource.kind === "EXTENSION" ? "REQUEST_ACCESS" as const : visibility === "PUBLIC" ? "AVAILABLE" as const : "REQUEST_ACCESS" as const,
            restriction_reason: null,
            ...(publicationEndpoint ? { publication_endpoint: publicationEndpoint } : {}),
            ...(builtinDiscovery ? { builtin_service: "DISCOVERY" as const } : {}),
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
        request_correlation_id: value.correlation_id,
        decision_correlation_id: null,
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
      await governanceAudit().record({
        tenantId,
        event: accessGovernanceAuditEvent({
          tenantId,
          correlationId: value.correlation_id,
          operation: "CREATED",
          actorSubjectId: actor.subjectId,
          subjectId: request.target_subject,
          actingClientId: actor.clientId,
          resourceId: request.resource_id,
          capabilityId: request.capability_id,
          accessRequestId: request.access_request_id,
          entitlementId: null,
          occurredAt: createdAt,
        }),
      })
      ownerOrganizations.set(key(tenantId, requestId), resource.owner_organization_id)
      requests.set(key(tenantId, requestId), request)
      return { CREATED: structuredClone(request) }
    },
    async activateAutoGrant({ tenantId, actor, value }) {
      const idempotencyKey = autoGrantActivationIdempotencyKey({
        tenantId,
        subjectId: actor.subjectId,
        clientId: actor.clientId,
        correlationId: value.correlation_id,
      })
      const requestDigest = autoGrantActivationRequestDigest({
        tenantId,
        subjectId: actor.subjectId,
        clientId: actor.clientId,
        resourceId: value.resource_id,
        capabilityId: value.capability_id,
      })
      const activationKey = `${tenantId}\u0000${idempotencyKey}`
      const targetKey = `auto-grant-target\u0000${tenantId}\u0000${actor.subjectId}\u0000${value.resource_id}\u0000${value.capability_id}`
      return autoGrantMutations.run(targetKey, () => autoGrantMutations.run(activationKey, async () => {
        const audit = options.audit
        if (!audit || !("findById" in audit) || !audit.findById) {
          throw new PlatformApiError("AUTO_GRANT_AUDIT_REQUIRED", 503)
        }
        const at = now()
        const identity = await options.identity.inventory({ tenantId })
        const subject = identity.subjects.find((candidate) => candidate.subject_id === actor.subjectId)
        if (!subject || subject.suspended) {
          throw new PlatformApiError("AUTO_GRANT_ACTOR_NOT_VERIFIED", 403)
        }
        const resource = await options.resources.getResource({
          tenantId,
          resourceId: value.resource_id,
        })
        if (
          resource.lifecycle !== "PUBLISHED" ||
          resource.kind === "EXTENSION" ||
          resource.builtin_service === "DISCOVERY" ||
          resource.publication_endpoint?.visibility !== "PUBLIC" ||
          !resource.capabilities.some((capability) => capability.capability_id === value.capability_id)
        ) {
          throw new PlatformApiError("AUTO_GRANT_NOT_AVAILABLE", 422)
        }
        const entitlements = await allEntitlements(tenantId)
        const priorActivation = autoGrantActivations.get(activationKey)
        if (priorActivation) {
          if (priorActivation.requestDigest !== requestDigest) {
            throw new PlatformApiError("AUTO_GRANT_CORRELATION_REUSED", 409)
          }
          const prior = entitlements.find((candidate) => candidate.entitlement_id === priorActivation.entitlementId)
          if (!prior || !active(prior, at)) {
            throw new PlatformApiError("AUTO_GRANT_RETRY_NOT_EFFECTIVE", 409)
          }
          await recordAutoGrantActivation({
            tenantId,
            actor,
            correlationId: value.correlation_id,
            resourceId: value.resource_id,
            capabilityId: value.capability_id,
            entitlementId: prior.entitlement_id,
            disposition: priorActivation.disposition,
            occurredAt: at,
          })
          return prior
        }
        const existing = entitlements.find((candidate) =>
          candidate.subject_id === actor.subjectId &&
          candidate.resource_id === value.resource_id &&
          candidate.capability_id === value.capability_id &&
          active(candidate, at))
        if (existing) {
          await recordAutoGrantActivation({
            tenantId,
            actor,
            correlationId: value.correlation_id,
            resourceId: value.resource_id,
            capabilityId: value.capability_id,
            entitlementId: existing.entitlement_id,
            disposition: "ALREADY_ENTITLED",
            occurredAt: at,
          })
          autoGrantActivations.set(activationKey, {
            entitlementId: existing.entitlement_id,
            requestDigest,
            disposition: "ALREADY_ENTITLED",
          })
          return existing
        }
        const created = legacyEntitlement(await options.entitlements.grant({
          tenantId,
          value: {
            subject_id: actor.subjectId,
            resource_id: value.resource_id,
            capability_id: value.capability_id,
          },
        }), at)
        try {
          await recordAutoGrantActivation({
            tenantId,
            actor,
            correlationId: value.correlation_id,
            resourceId: value.resource_id,
            capabilityId: value.capability_id,
            entitlementId: created.entitlement_id,
            disposition: "GRANTED",
            occurredAt: at,
          })
        } catch (error) {
          try {
            await options.entitlements.revoke({ tenantId, entitlementId: created.entitlement_id })
          } catch {
            throw new PlatformApiError("AUTO_GRANT_ROLLBACK_FAILED", 500)
          }
          throw error
        }
        autoGrantActivations.set(activationKey, {
          entitlementId: created.entitlement_id,
          requestDigest,
          disposition: "GRANTED",
        })
        return created
      }))
    },
    async listMine({ tenantId, actor }) {
      return [...requests.entries()]
        .filter(([entryKey, value]) => entryKey.startsWith(`${tenantId}:`) &&
          (value.requester === actor.subjectId || value.target_subject === actor.subjectId))
        .map(([, value]) => structuredClone(value))
    },
    async listManagement({ tenantId, actor }) {
      return [...requests.entries()].filter(([entryKey]) => entryKey.startsWith(`${tenantId}:`)).map(([, value]) => value)
        .filter((value) => canManageOwner(actor, ownerOrganizations.get(key(tenantId, value.access_request_id)) ?? ""))
        .map((value) => structuredClone(value))
    },
    async decide({ tenantId, actor, requestId, value }) {
      const current = get(tenantId, requestId)
      if (current.state !== "PENDING" || !canManageOwner(actor, ownerOrganizations.get(key(tenantId, requestId)) ?? "")) {
        throw new PlatformApiError("ACCESS_DECISION_DENIED", 403)
      }
      const decidedAt = now()
      const next = structuredClone(current)
      next.decision_correlation_id = value.correlation_id
      let entitlement: LegacyEntitlement | null = null
      if ("APPROVE" in value.decision) {
        if (value.decision.APPROVE.valid_until <= decidedAt) throw new PlatformApiError("ENTITLEMENT_WINDOW_INVALID", 422)
        next.state = "APPROVED"
        next.expires_at = value.decision.APPROVE.valid_until
        next.resolved_at = decidedAt
        next.approval_stages[0] = {
          ...next.approval_stages[0]!, state: next.state,
          decided_by: { subject_id: actor.subjectId, evidence_level: "VERIFIED" }, decided_at: decidedAt,
        }
        const granted = await options.entitlements.grant({
          tenantId,
          value: {
            subject_id: next.target_subject,
            resource_id: next.resource_id,
            capability_id: next.capability_id,
            starts_at: decidedAt,
            expires_at: value.decision.APPROVE.valid_until,
          },
        })
        entitlement = legacyEntitlement(granted, decidedAt)
        try {
          await governanceAudit().record({
            tenantId,
            event: accessGovernanceAuditEvent({
              tenantId,
              correlationId: value.correlation_id,
              operation: "APPROVE",
              actorSubjectId: actor.subjectId,
              subjectId: next.target_subject,
              actingClientId: actor.clientId,
              resourceId: next.resource_id,
              capabilityId: next.capability_id,
              accessRequestId: next.access_request_id,
              entitlementId: granted.entitlement_id,
              occurredAt: decidedAt,
            }),
          })
        } catch (error) {
          await options.entitlements.revoke({ tenantId, entitlementId: granted.entitlement_id })
          throw error
        }
      } else {
        next.state = "DENIED"
        next.resolution_reason = value.decision.DENY.reason.trim()
        next.resolved_at = decidedAt
        next.approval_stages[0] = {
          ...next.approval_stages[0]!, state: next.state,
          decided_by: { subject_id: actor.subjectId, evidence_level: "VERIFIED" }, decided_at: decidedAt,
        }
        await governanceAudit().record({
          tenantId,
          event: accessGovernanceAuditEvent({
            tenantId,
            correlationId: value.correlation_id,
            operation: "DENY",
            actorSubjectId: actor.subjectId,
            subjectId: next.target_subject,
            actingClientId: actor.clientId,
            resourceId: next.resource_id,
            capabilityId: next.capability_id,
            accessRequestId: next.access_request_id,
            entitlementId: null,
            occurredAt: decidedAt,
          }),
        })
      }
      requests.set(key(tenantId, requestId), next)
      return { request: structuredClone(next), entitlement }
    },
    async cancel({ tenantId, actor, requestId, value }) {
      const current = get(tenantId, requestId)
      if (current.requester !== actor.subjectId || current.state !== "PENDING") {
        throw new PlatformApiError("ACCESS_REQUEST_CANCEL_DENIED", 403)
      }
      const cancelledAt = now()
      const next = structuredClone(current)
      next.state = "CANCELLED"
      next.decision_correlation_id = value.correlation_id
      next.approval_stages[0] = { ...next.approval_stages[0]!, state: "CANCELLED" }
      next.resolved_at = cancelledAt
      next.resolution_reason = value.reason.trim()
      await governanceAudit().record({
        tenantId,
        event: accessGovernanceAuditEvent({
          tenantId,
          correlationId: value.correlation_id,
          operation: "CANCEL",
          actorSubjectId: actor.subjectId,
          subjectId: next.target_subject,
          actingClientId: actor.clientId,
          resourceId: next.resource_id,
          capabilityId: next.capability_id,
          accessRequestId: next.access_request_id,
          entitlementId: null,
          occurredAt: cancelledAt,
        }),
      })
      requests.set(key(tenantId, requestId), next)
      return structuredClone(next)
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
      if (!canManageOwner(actor, resource.owner_organization_id)) {
        throw new PlatformApiError("ENTITLEMENT_REVOCATION_DENIED", 403)
      }
      const revokedAt = now()
      await governanceAudit().record({
        tenantId,
        event: accessGovernanceAuditEvent({
          tenantId,
          correlationId: value.correlation_id,
          operation: "REVOKE",
          actorSubjectId: actor.subjectId,
          subjectId: entitlement.subject_id ?? actor.subjectId,
          actingClientId: actor.clientId,
          resourceId: entitlement.resource_id,
          capabilityId: entitlement.capability_id,
          accessRequestId: null,
          entitlementId: entitlement.entitlement_id,
          occurredAt: revokedAt,
        }),
      })
      return legacyEntitlement(await options.entitlements.revoke({
        tenantId,
        entitlementId,
      }), revokedAt, value.reason.trim())
    },
    async entitlementsForSubject({ tenantId, actor }) {
      return (await allEntitlements(tenantId)).filter((value) => value.subject_id === actor.subjectId)
    },
    async entitlementsForOwner({ tenantId, actor }) {
      const resources = await options.resources.listResources({ tenantId })
      const visible = new Set(resources.filter((resource) =>
        canManageOwner(actor, resource.owner_organization_id)).map((resource) => resource.resource_id))
      return (await allEntitlements(tenantId)).filter((value) => visible.has(value.resource_id))
    },
    async notifications({ tenantId, actor }) {
      return [...requests.entries()].filter(([entryKey]) => entryKey.startsWith(`${tenantId}:`)).map(([, request]) => request)
        .filter((request) => request.state === "PENDING" || request.state === "APPROVED" || request.state === "DENIED")
        .filter((request) => request.requester === actor.subjectId || canManageOwner(actor, ownerOrganizations.get(key(tenantId, request.access_request_id)) ?? ""))
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
