import { randomUUID } from "node:crypto"

import { PlatformApiError } from "../errors"
import type { ModelEntitlementCatalog } from "../entitlements/module"
import type { OrganizationDirectory } from "../organizations/module"
import type { ResourceRegistry } from "../resources/module"
import type { CreateExecutionGrantRequestInput, DecideExecutionGrantRequestInput, ExecutionGrant, ExecutionGrantRequest } from "./contract"

export interface ExecutionGrantRepository {
  createRequest(value: ExecutionGrantRequest): Promise<ExecutionGrantRequest>
  latestRequest(input: { tenantId: string; requestId: string }): Promise<ExecutionGrantRequest | null>
  listLatestRequests(input: { tenantId: string }): Promise<ExecutionGrantRequest[]>
  decide(input: { current: ExecutionGrantRequest; decision: "APPROVE" | "DENY"; actorSubjectId: string; reason: string; decidedAt: number; grant: ExecutionGrant | null }): Promise<ExecutionGrantRequest>
}

export interface ExecutionGrantDirectory {
  request(input: { tenantId: string; actor: { subjectId: string; actingClientId: string }; value: CreateExecutionGrantRequestInput }): Promise<ExecutionGrantRequest>
  decide(input: { tenantId: string; requestId: string; actor: { subjectId: string; tenantAdministrator: boolean }; value: DecideExecutionGrantRequestInput }): Promise<ExecutionGrantRequest>
  list(input: { tenantId: string; actor: { subjectId: string; tenantAdministrator: boolean } }): Promise<ExecutionGrantRequest[]>
}

export function createExecutionGrantDirectory(options: {
  repository: ExecutionGrantRepository
  entitlements: ModelEntitlementCatalog
  resources: ResourceRegistry
  organizations: OrganizationDirectory
  now?: () => number
  idFactory?: (kind: "request" | "grant") => string
}): ExecutionGrantDirectory {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((kind) => `execution-${kind}-${randomUUID()}`)
  return {
    async request(input) {
      const createdAt = now()
      if (input.value.requested_expires_at <= createdAt) throw new PlatformApiError("EXECUTION_GRANT_WINDOW_INVALID", 422)
      const entitlements = await options.entitlements.list({ tenantId: input.tenantId })
      const entitled = entitlements.some((value) =>
        value.subject_id === input.actor.subjectId &&
        value.resource_id === input.value.resource_id &&
        value.capability_id === input.value.capability_id &&
        value.state === "ACTIVE" &&
        value.starts_at <= createdAt &&
        (value.expires_at === null || value.expires_at >= input.value.requested_expires_at)
      )
      if (!entitled) throw new PlatformApiError("EXECUTION_GRANT_ENTITLEMENT_REQUIRED", 409)
      return options.repository.createRequest({
        tenant_id: input.tenantId,
        request_id: idFactory("request"),
        revision: 1,
        subject_id: input.actor.subjectId,
        acting_client_id: input.actor.actingClientId,
        resource_id: input.value.resource_id,
        capability_id: input.value.capability_id,
        action_digest: input.value.action_digest,
        requested_expires_at: input.value.requested_expires_at,
        state: "PENDING",
        created_by_subject_id: input.actor.subjectId,
        created_at: createdAt,
        decided_by_subject_id: null,
        decided_at: null,
        decision_reason: null,
        execution_grant_id: null,
      })
    },
    async decide(input) {
      const current = await options.repository.latestRequest({ tenantId: input.tenantId, requestId: input.requestId })
      if (!current) throw new PlatformApiError("EXECUTION_GRANT_REQUEST_NOT_FOUND", 404)
      if (current.revision !== input.value.expected_revision || current.state !== "PENDING") {
        throw new PlatformApiError("EXECUTION_GRANT_REQUEST_REVISION_CONFLICT", 409)
      }
      const resource = await options.resources.getResource({ tenantId: input.tenantId, resourceId: current.resource_id })
      const owner = await options.organizations.get({ tenantId: input.tenantId, organizationId: resource.owner_organization_id })
      if (!input.actor.tenantAdministrator && !owner.organization_administrator_subject_ids.includes(input.actor.subjectId)) {
        throw new PlatformApiError("EXECUTION_GRANT_APPROVER_DENIED", 403)
      }
      const decidedAt = now()
      if (input.value.decision === "APPROVE" && current.requested_expires_at <= decidedAt) {
        throw new PlatformApiError("EXECUTION_GRANT_REQUEST_EXPIRED", 409)
      }
      const grant = input.value.decision === "APPROVE" ? {
        tenant_id: current.tenant_id,
        execution_grant_id: idFactory("grant"),
        request_id: current.request_id,
        subject_id: current.subject_id,
        acting_client_id: current.acting_client_id,
        resource_id: current.resource_id,
        capability_id: current.capability_id,
        action_digest: current.action_digest,
        issued_at: decidedAt,
        expires_at: current.requested_expires_at,
        issued_by_subject_id: input.actor.subjectId,
      } satisfies ExecutionGrant : null
      return options.repository.decide({ current, decision: input.value.decision, actorSubjectId: input.actor.subjectId, reason: input.value.reason, decidedAt, grant })
    },
    async list(input) {
      const values = await options.repository.listLatestRequests({ tenantId: input.tenantId })
      if (input.actor.tenantAdministrator) return values
      const access = await options.organizations.accessForSubject({ tenantId: input.tenantId, subjectId: input.actor.subjectId })
      const administratorOrganizationIds = new Set(access.administrator_organization_ids)
      const ownedResourceIds = new Set<string>()
      for (const resourceId of new Set(values.map((value) => value.resource_id))) {
        const resource = await options.resources.getResource({ tenantId: input.tenantId, resourceId })
        if (administratorOrganizationIds.has(resource.owner_organization_id)) ownedResourceIds.add(resourceId)
      }
      return values.filter((value) => value.subject_id === input.actor.subjectId || ownedResourceIds.has(value.resource_id))
    },
  }
}
