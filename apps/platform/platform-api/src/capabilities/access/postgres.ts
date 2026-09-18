import { createHash, randomUUID } from "node:crypto"

import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type { TenantConfiguration } from "../configuration/contract"
import type { AccessNotification, AccessRequest, LegacyEntitlement, SubjectCatalog } from "./contract"
import type {
  AccessActor,
  AccessEntitlementReleasePublisher,
  AccessGovernanceStore,
} from "./module"

type Row = Record<string, unknown>

function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === "string" ? value : String(value ?? "")
}
function nullableText(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : text(row, key)
}
function publicationEndpoint(row: Row) {
  const hostname = nullableText(row, "hostname")
  const basePath = nullableText(row, "base_path")
  return hostname && basePath ? { hostname, base_path: basePath } : undefined
}
function seconds(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1_000)
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : Number(value)
}
function nullableSeconds(value: unknown): number | null {
  return value === null || value === undefined ? null : seconds(value)
}
function allowed(actor: AccessActor, organizationId: string): boolean {
  return actor.role === "TENANT_ADMINISTRATOR" || actor.organizationIds.includes(organizationId)
}

const REQUEST_COLUMNS = `tenant_id, access_request_id, requester_subject_id, target_subject_id,
  acting_client_id, resource_id, capability_id, owner_organization_id, justification,
  requested_valid_for, configuration_revision, approval_workflow_version, state,
  created_at, expires_at, resolved_at, resolution_reason, decided_by_subject_id, entitlement_id`

function accessRequest(row: Row): AccessRequest {
  const owner = text(row, "owner_organization_id")
  const state = text(row, "state") as AccessRequest["state"]
  const decidedBy = nullableText(row, "decided_by_subject_id")
  const decidedAt = nullableSeconds(row.resolved_at)
  return {
    access_request_id: text(row, "access_request_id"),
    requester: text(row, "requester_subject_id"),
    target_subject: text(row, "target_subject_id"),
    acting_client: {
      acting_client_id: nullableText(row, "acting_client_id"),
      evidence_level: row.acting_client_id ? "VERIFIED" : "UNKNOWN",
    },
    resource_id: text(row, "resource_id"),
    capability_id: text(row, "capability_id"),
    justification: text(row, "justification"),
    requested_valid_for: Number(row.requested_valid_for),
    configuration_revision: nullableText(row, "configuration_revision"),
    approval_workflow_version: nullableText(row, "approval_workflow_version"),
    approver: owner,
    state,
    created_at: seconds(row.created_at),
    expires_at: nullableSeconds(row.expires_at),
    resolved_at: decidedAt,
    resolution_reason: nullableText(row, "resolution_reason"),
    policy_version_at_creation: nullableText(row, "configuration_revision") ?? "one-policy-current",
    approval_stages: [{
      stage_id: "resource-owner-organization",
      approver: { kind: "ORGANIZATION", organization_id: owner },
      primary_approver: owner,
      assigned_approver: owner,
      delegation_id: null,
      state,
      decided_by: decidedBy ? { subject_id: decidedBy, evidence_level: "VERIFIED" } : null,
      decided_at: decidedAt,
    }],
    current_approval_stage: 0,
  }
}

const ENTITLEMENT_COLUMNS = `entitlement_id, subject_id, resource_id, capability_id, state,
  extract(epoch from starts_at)::bigint as valid_from,
  case when expires_at is null then null else extract(epoch from expires_at)::bigint end as valid_until,
  revocation_reason`

function entitlement(row: Row, now: number): LegacyEntitlement {
  const expires = row.valid_until === null || row.valid_until === undefined ? 4_102_444_800 : Number(row.valid_until)
  const rawState = text(row, "state")
  return {
    entitlement_id: text(row, "entitlement_id"),
    subject_id: text(row, "subject_id"),
    resource_id: text(row, "resource_id"),
    capability_id: text(row, "capability_id"),
    state: rawState === "ACTIVE" && expires <= now ? "EXPIRED" : rawState as LegacyEntitlement["state"],
    valid_from: Number(row.valid_from),
    valid_until: expires,
    revocation_reason: nullableText(row, "revocation_reason"),
  }
}

async function lockedRequest(transaction: SqlTransaction, tenantId: string, requestId: string): Promise<Row> {
  const result = await transaction.query<Row>(
    `select ${REQUEST_COLUMNS} from genio_one_access_requests
      where tenant_id = $1 and access_request_id = $2 for update`,
    [tenantId, requestId],
  )
  if (!result.rows[0]) throw new PlatformApiError("ACCESS_REQUEST_NOT_FOUND", 404)
  return result.rows[0]
}

export function createPostgresAccessGovernanceStore(options: {
  sql: SqlAdapter
  releasePublisher?: AccessEntitlementReleasePublisher
  now?: () => number
  idFactory?: (prefix: string) => string
}): AccessGovernanceStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  const idFactory = options.idFactory ?? ((prefix) => `${prefix}-${randomUUID()}`)
  const listEntitlements = async (query: string, parameters: readonly unknown[]) => {
    const result = await options.sql.query<Row>(query, parameters)
    return result.rows.map((row) => entitlement(row, now()))
  }
  return {
    async catalog({ tenantId, actor }) {
      const [result, subjectResult] = await Promise.all([
        options.sql.query<Row>(
        `select resource.resource_id, resource.display_name as resource_display_name,
                resource.kind as resource_kind, resource.extension_metadata, resource.builtin_service,
                capability.value ->> 'capability_id' as capability_id,
                capability.value ->> 'display_name' as capability_display_name,
                resource.owner_organization_id,
                owner.display_name as resource_owner_display_name,
                case when resource.kind = 'EXTENSION'
                       and resource.lifecycle = 'PUBLISHED'
                       and resource.extension_metadata is not null
                       and nullif(trim(resource.extension_metadata ->> 'manifest_digest'), '') is not null
                       and nullif(trim(resource.extension_metadata ->> 'artifact_digest'), '') is not null
                  then 'READY'
                  when exists (
                  select 1 from genio_one_resource_connections connection
                   where connection.tenant_id = resource.tenant_id
                     and connection.resource_id = resource.resource_id
                     and connection.status = 'READY'
                     and connection.lifecycle = 'ENABLED'
                     and connection.verification_state = 'VERIFIED'
                     and connection.health_state = 'HEALTHY'
                ) then 'READY' else 'UNAVAILABLE' end as connection_status,
                publication.visibility, publication.hostname, publication.base_path,
                entitlement.entitlement_id,
                pending.access_request_id,
                resource.row_revision
           from genio_one_resources resource
           join genio_one_organizations owner
             on owner.tenant_id = resource.tenant_id
            and owner.organization_id = resource.owner_organization_id
            left join lateral (
              select visibility, publication_state, hostname, base_path
                from genio_one_publications publication
               where publication.tenant_id = resource.tenant_id
                 and publication.resource_id = resource.resource_id
                 and publication.publication_state in ('PUBLISHED', 'DEPRECATED')
               order by publication.endpoint_revision desc limit 1
            ) publication on true
            cross join lateral jsonb_array_elements(resource.capabilities) capability(value)
            left join lateral (
              select entitlement_id from genio_one_model_entitlements entitlement
               where entitlement.tenant_id = resource.tenant_id
                 and entitlement.resource_id = resource.resource_id
                 and entitlement.capability_id = capability.value ->> 'capability_id'
                 and entitlement.subject_id = $2 and entitlement.state = 'ACTIVE'
                 and entitlement.starts_at <= now()
                 and (entitlement.expires_at is null or entitlement.expires_at > now())
               limit 1
            ) entitlement on true
            left join lateral (
              select access_request_id from genio_one_access_requests request
               where request.tenant_id = resource.tenant_id
                 and request.resource_id = resource.resource_id
                 and request.capability_id = capability.value ->> 'capability_id'
                 and request.target_subject_id = $2 and request.state = 'PENDING'
               limit 1
            ) pending on true
           where resource.tenant_id = $1 and resource.lifecycle = 'PUBLISHED'
             and (
               resource.kind = 'EXTENSION' or resource.builtin_service = 'DISCOVERY' or
               (
                 publication.publication_state = 'PUBLISHED' and
                 (
                   publication.visibility in ('PUBLIC', 'REQUEST') or
                   entitlement.entitlement_id is not null
                 )
               )
             )
          order by resource.resource_id, capability.value ->> 'capability_id'`,
        [tenantId, actor.subjectId],
        ),
        options.sql.query<Row>(
          `select coalesce(display_name, email, subject_id) as display_name
             from genio_one_subjects
            where tenant_id = $1 and subject_id = $2`,
          [tenantId, actor.subjectId],
        ),
      ])
      const capabilities: SubjectCatalog["capabilities"] = result.rows.map((row) => {
        const isExtension = row.resource_kind === "EXTENSION"
        const visibility = row.builtin_service === "DISCOVERY" ? "PUBLIC" : isExtension ? "REQUEST" : text(row, "visibility")
        const entitled = nullableText(row, "entitlement_id") !== null
        const pending = nullableText(row, "access_request_id") !== null
        const endpoint = entitled || visibility === "PUBLIC" ? publicationEndpoint(row) : undefined
        return {
          resource_id: text(row, "resource_id"),
          resource_display_name: text(row, "resource_display_name"),
          capability_id: text(row, "capability_id"),
          capability_display_name: text(row, "capability_display_name"),
          resource_owner_id: text(row, "owner_organization_id"),
          resource_owner_display_name: text(row, "resource_owner_display_name"),
          connection_status: text(row, "connection_status"),
          access: entitled ? "ENTITLED" : isExtension ? "REQUEST" : visibility === "PUBLIC" ? "AUTO_GRANT" : "REQUEST",
          hub_status: entitled ? "CONNECTED" : pending ? "PENDING_APPROVAL" : isExtension ? "REQUEST_ACCESS" : visibility === "PUBLIC" ? "AVAILABLE" : "REQUEST_ACCESS",
          restriction_reason: null,
          ...(endpoint ? { publication_endpoint: endpoint } : {}),
          ...(row.builtin_service === "DISCOVERY" ? { builtin_service: "DISCOVERY" as const } : {}),
          ...(row.resource_kind === "EXTENSION" ? {
            resource_kind: "EXTENSION",
            extension_metadata: row.extension_metadata && typeof row.extension_metadata === "object" && !Array.isArray(row.extension_metadata)
              ? row.extension_metadata as Record<string, unknown>
              : null,
          } : {}),
        }
      })
      const digest = createHash("sha256").update(JSON.stringify(result.rows.map((row) => [
        row.resource_id, row.capability_id, row.row_revision, row.visibility, row.hostname, row.base_path,
      ]))).digest("hex").slice(0, 16)
      return {
        tenant_id: tenantId,
        catalog_revision: `catalog-${digest}`,
        subject_id: actor.subjectId,
        subject_display_name: nullableText(subjectResult.rows[0] ?? {}, "display_name") ?? actor.subjectId,
        capabilities,
      }
    },
    async request({ tenantId, actor, value }) {
      return options.sql.transaction(async (transaction) => {
        const targetSubjectId = value.target_subject_id?.trim() || actor.subjectId
        let targetApplicationOwnerOrganizationId: string | null = null
        if (targetSubjectId !== actor.subjectId) {
          const targetSubject = await transaction.query<Row>(
            `select subject.kind, application.owner_organization_id
               from genio_one_subjects subject
               left join genio_one_applications application
                 on application.tenant_id = subject.tenant_id
                and application.subject_id = subject.subject_id
              where subject.tenant_id = $1 and subject.subject_id = $2`,
            [tenantId, targetSubjectId],
          )
          const targetRow = targetSubject.rows[0]
          if (!targetRow || text(targetRow, "kind") !== "APPLICATION") {
            throw new PlatformApiError("ACCESS_TARGET_APPLICATION_REQUIRED", 422)
          }
          const ownerOrganizationId = text(targetRow, "owner_organization_id")
          targetApplicationOwnerOrganizationId = ownerOrganizationId
          if (
            actor.role === "USER" ||
            (actor.role === "ORGANIZATION_ADMINISTRATOR" &&
              !actor.organizationIds.includes(ownerOrganizationId))
          ) {
            throw new PlatformApiError("APPLICATION_ACCESS_MANAGEMENT_REQUIRED", 403)
          }
        }
        const configurationResult = await transaction.query<Row>(
          `select revision, settings from genio_one_tenant_configuration_revisions
            where tenant_id = $1 and state = 'PUBLISHED'
              and revision = (
                select projection.revision
                  from genio_one_self_service_configuration_projections projection
                 where projection.tenant_id = $1
              )
            limit 1`,
          [tenantId],
        )
        const configurationRow = configurationResult.rows[0]
        if (!configurationRow) throw new PlatformApiError("ACCESS_REQUEST_CONFIGURATION_REQUIRED", 422)
        const configuration = (typeof configurationRow.settings === "string"
          ? JSON.parse(configurationRow.settings) : configurationRow.settings) as TenantConfiguration
        if (
          !configuration.request_form.enabled || !value.justification.trim() ||
          !configuration.ttl_options_seconds.includes(value.requested_valid_for_seconds)
        ) throw new PlatformApiError("ACCESS_REQUEST_CONFIGURATION_INVALID", 422)
        const target = await transaction.query<Row>(
          `select resource.owner_organization_id
             from genio_one_resources resource
             left join lateral (
               select visibility, publication_state from genio_one_publications publication
                where publication.tenant_id = resource.tenant_id
                  and publication.resource_id = resource.resource_id
                order by publication.created_at desc limit 1
             ) publication on true
             where resource.tenant_id = $1 and resource.resource_id = $2
              and resource.lifecycle = 'PUBLISHED'
              and (resource.kind = 'EXTENSION' or publication.publication_state = 'PUBLISHED' and (
                publication.visibility = 'REQUEST' or
                (publication.visibility = 'PRIVATE' and resource.owner_organization_id = $4)
              ))
              and resource.capabilities @> jsonb_build_array(jsonb_build_object('capability_id', $3::text))`,
          [tenantId, value.resource_id, value.capability_id, targetApplicationOwnerOrganizationId],
        )
        if (!target.rows[0]) throw new PlatformApiError("ACCESS_NOT_REQUESTABLE", 422)
        const active = await transaction.query<{ entitlement_id: string }>(
          `select entitlement_id from genio_one_model_entitlements
            where tenant_id = $1 and subject_id = $2 and resource_id = $3 and capability_id = $4
              and state = 'ACTIVE' and starts_at <= now()
              and (expires_at is null or expires_at > now()) limit 1`,
          [tenantId, targetSubjectId, value.resource_id, value.capability_id],
        )
        if (active.rows[0]) return { ALREADY_ENTITLED: active.rows[0].entitlement_id }
        const existing = await transaction.query<Row>(
          `select ${REQUEST_COLUMNS} from genio_one_access_requests
            where tenant_id = $1 and target_subject_id = $2 and resource_id = $3
              and capability_id = $4 and state = 'PENDING' limit 1`,
          [tenantId, targetSubjectId, value.resource_id, value.capability_id],
        )
        if (existing.rows[0]) return { EXISTING: accessRequest(existing.rows[0]) }
        const result = await transaction.query<Row>(
          `insert into genio_one_access_requests
             (tenant_id, access_request_id, requester_subject_id, target_subject_id,
              acting_client_id, resource_id, capability_id, owner_organization_id,
              justification, requested_valid_for, configuration_revision,
              approval_workflow_version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           returning ${REQUEST_COLUMNS}`,
          [
            tenantId, idFactory("access-request"), actor.subjectId, targetSubjectId, actor.clientId,
            value.resource_id, value.capability_id, text(target.rows[0], "owner_organization_id"),
            value.justification.trim(), value.requested_valid_for_seconds,
            text(configurationRow, "revision"), configuration.approval_workflow_version,
          ],
        )
        return { CREATED: accessRequest(result.rows[0]!) }
      })
    },
    async listMine({ tenantId, actor }) {
      const result = await options.sql.query<Row>(
        `select ${REQUEST_COLUMNS} from genio_one_access_requests
          where tenant_id = $1 and (requester_subject_id = $2 or target_subject_id = $2)
          order by created_at desc, access_request_id desc`,
        [tenantId, actor.subjectId],
      )
      return result.rows.map(accessRequest)
    },
    async listManagement({ tenantId, actor }) {
      const result = await options.sql.query<Row>(
        `select ${REQUEST_COLUMNS} from genio_one_access_requests
          where tenant_id = $1 and ($2::boolean or owner_organization_id = any($3::text[]))
          order by created_at desc, access_request_id desc`,
        [tenantId, actor.role === "TENANT_ADMINISTRATOR", [...actor.organizationIds]],
      )
      return result.rows.map(accessRequest)
    },
    async decide({ tenantId, actor, requestId, value }) {
      return options.sql.transaction(async (transaction) => {
        const row = await lockedRequest(transaction, tenantId, requestId)
        const current = accessRequest(row)
        if (current.state !== "PENDING" || !allowed(actor, text(row, "owner_organization_id"))) {
          throw new PlatformApiError("ACCESS_DECISION_DENIED", 403)
        }
        const at = now()
        let created: LegacyEntitlement | null = null
        if ("APPROVE" in value.decision) {
          if (value.decision.APPROVE.valid_until <= at) throw new PlatformApiError("ENTITLEMENT_WINDOW_INVALID", 422)
          const entitlementId = idFactory("entitlement")
          const grant = await transaction.query<Row>(
            `insert into genio_one_model_entitlements
               (tenant_id, entitlement_id, subject_id, client_id, resource_id,
                capability_id, public_model_id, state, starts_at, expires_at)
             values ($1,$2,$3,null,$4,$5,null,'ACTIVE',to_timestamp($6),to_timestamp($7))
             returning ${ENTITLEMENT_COLUMNS}`,
            [tenantId, entitlementId, current.target_subject, current.resource_id, current.capability_id, at, value.decision.APPROVE.valid_until],
          )
          created = entitlement(grant.rows[0]!, at)
          await transaction.query(
            `update genio_one_access_requests set state = 'APPROVED', expires_at = to_timestamp($3),
                    resolved_at = to_timestamp($4), decided_by_subject_id = $5, entitlement_id = $6
              where tenant_id = $1 and access_request_id = $2`,
            [tenantId, requestId, value.decision.APPROVE.valid_until, at, actor.subjectId, entitlementId],
          )
          const publication = await transaction.query<{ gateway_id: string }>(
            `select gateway_id from genio_one_publications
              where tenant_id = $1 and resource_id = $2 and publication_state = 'PUBLISHED'
              order by endpoint_revision desc limit 1 for update`,
            [tenantId, current.resource_id],
          )
          if (publication.rows[0]) {
            if (!options.releasePublisher) {
              throw new PlatformApiError("GATEWAY_RELEASE_PUBLISHER_REQUIRED", 500)
            }
            await options.releasePublisher.reconcileInTransaction({
              transaction,
              tenantId,
              gatewayId: publication.rows[0].gateway_id,
              issuedAt: at,
            })
          }
        } else {
          await transaction.query(
            `update genio_one_access_requests set state = 'DENIED', resolution_reason = $3,
                    resolved_at = to_timestamp($4), decided_by_subject_id = $5
              where tenant_id = $1 and access_request_id = $2`,
            [tenantId, requestId, value.decision.DENY.reason.trim(), at, actor.subjectId],
          )
        }
        const updated = await transaction.query<Row>(
          `select ${REQUEST_COLUMNS} from genio_one_access_requests
            where tenant_id = $1 and access_request_id = $2`,
          [tenantId, requestId],
        )
        return { request: accessRequest(updated.rows[0]!), entitlement: created }
      })
    },
    async cancel({ tenantId, actor, requestId, value }) {
      const result = await options.sql.query<Row>(
        `update genio_one_access_requests set state = 'CANCELLED', resolution_reason = $4,
                resolved_at = to_timestamp($5), decided_by_subject_id = $3
          where tenant_id = $1 and access_request_id = $2 and requester_subject_id = $3 and state = 'PENDING'
          returning ${REQUEST_COLUMNS}`,
        [tenantId, requestId, actor.subjectId, value.reason.trim(), now()],
      )
      if (!result.rows[0]) throw new PlatformApiError("ACCESS_REQUEST_CANCEL_DENIED", 403)
      return accessRequest(result.rows[0])
    },
    async revokeEntitlement({ tenantId, actor, entitlementId, value }) {
      return options.sql.transaction(async (transaction) => {
        const current = await transaction.query<Row>(
          `select entitlement.entitlement_id, entitlement.state,
                  entitlement.resource_id, resource.owner_organization_id,
                  publication.gateway_id
             from genio_one_model_entitlements entitlement
             join genio_one_resources resource
               on resource.tenant_id = entitlement.tenant_id
              and resource.resource_id = entitlement.resource_id
             left join lateral (
               select gateway_id from genio_one_publications publication
                where publication.tenant_id = entitlement.tenant_id
                  and publication.resource_id = entitlement.resource_id
                  and publication.publication_state = 'PUBLISHED'
                order by publication.endpoint_revision desc limit 1
             ) publication on true
            where entitlement.tenant_id = $1 and entitlement.entitlement_id = $2
            for update of entitlement`,
          [tenantId, entitlementId],
        )
        const row = current.rows[0]
        if (!row) throw new PlatformApiError("ENTITLEMENT_NOT_FOUND", 404)
        if (!allowed(actor, text(row, "owner_organization_id"))) {
          throw new PlatformApiError("ENTITLEMENT_REVOCATION_DENIED", 403)
        }
        if (text(row, "state") !== "ACTIVE") {
          throw new PlatformApiError("ENTITLEMENT_NOT_ACTIVE", 409)
        }
        const at = now()
        const result = await transaction.query<Row>(
          `update genio_one_model_entitlements
              set state = 'REVOKED', revocation_reason = $3,
                  revoked_at = to_timestamp($4), revoked_by_subject_id = $5,
                  revocation_correlation_id = $6,
                  row_revision = row_revision + 1, updated_at = now()
            where tenant_id = $1 and entitlement_id = $2
            returning ${ENTITLEMENT_COLUMNS}`,
          [
            tenantId,
            entitlementId,
            value.reason.trim(),
            at,
            actor.subjectId,
            value.correlation_id,
          ],
        )
        const gatewayId = nullableText(row, "gateway_id")
        if (gatewayId) {
          if (!options.releasePublisher) {
            throw new PlatformApiError("GATEWAY_RELEASE_PUBLISHER_REQUIRED", 500)
          }
          await options.releasePublisher.reconcileInTransaction({
            transaction,
            tenantId,
            gatewayId,
            issuedAt: at,
          })
        }
        return entitlement(result.rows[0]!, at)
      })
    },
    async entitlementsForSubject({ tenantId, actor }) {
      return listEntitlements(
        `select ${ENTITLEMENT_COLUMNS} from genio_one_model_entitlements
          where tenant_id = $1 and subject_id = $2 order by created_at desc`,
        [tenantId, actor.subjectId],
      )
    },
    async entitlementsForOwner({ tenantId, actor }) {
      return listEntitlements(
        `select entitlement.entitlement_id, entitlement.subject_id,
                entitlement.resource_id, entitlement.capability_id, entitlement.state,
                extract(epoch from entitlement.starts_at)::bigint as valid_from,
                case when entitlement.expires_at is null then null
                  else extract(epoch from entitlement.expires_at)::bigint end as valid_until,
                entitlement.revocation_reason
           from genio_one_model_entitlements entitlement
          join genio_one_resources resource on resource.tenant_id = entitlement.tenant_id
            and resource.resource_id = entitlement.resource_id
          where entitlement.tenant_id = $1 and ($2::boolean or resource.owner_organization_id = any($3::text[]))
          order by entitlement.created_at desc`,
        [tenantId, actor.role === "TENANT_ADMINISTRATOR", [...actor.organizationIds]],
      )
    },
    async notifications({ tenantId, actor }) {
      const result = await options.sql.query<Row>(
        `select ${REQUEST_COLUMNS} from genio_one_access_requests
          where tenant_id = $1 and (
            requester_subject_id = $2 or target_subject_id = $2 or
            ($3::boolean or owner_organization_id = any($4::text[]))
          ) and state in ('PENDING','APPROVED','DENIED')
          order by coalesce(resolved_at, created_at) desc limit 100`,
        [tenantId, actor.subjectId, actor.role === "TENANT_ADMINISTRATOR", [...actor.organizationIds]],
      )
      return result.rows.map((row): AccessNotification => {
        const request = accessRequest(row)
        const requester = request.requester === actor.subjectId || request.target_subject === actor.subjectId
        return {
          notification_id: `access-notification-${request.access_request_id}-${request.state}`,
          kind: request.state === "PENDING" ? "PENDING_APPROVAL" : request.state === "APPROVED" ? "REQUEST_APPROVED" : "REQUEST_DENIED",
          audience: requester ? "REQUESTER" : "RESOURCE_OWNER",
          recipient_subject_id: actor.subjectId,
          requester: request.requester,
          access_request_id: request.access_request_id,
          entitlement_id: nullableText(row, "entitlement_id"),
          resource_id: request.resource_id,
          capability_id: request.capability_id,
          occurred_at: request.resolved_at ?? request.created_at,
          valid_until: request.expires_at,
          delivery_channels: ["IN_APP"],
          action_path: `/management?view=access&request=${request.access_request_id}`,
        }
      })
    },
  }
}
