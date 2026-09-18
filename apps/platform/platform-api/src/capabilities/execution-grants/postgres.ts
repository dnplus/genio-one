import type { SqlAdapter } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type { ResourceLifecycleReleasePublisher } from "../resources/module"
import type { ExecutionGrantRequest } from "./contract"
import type { ExecutionGrantRepository } from "./module"

type Row = Record<string, unknown>

const columns = `tenant_id, request_id, revision, subject_id, acting_client_id,
  resource_id, capability_id, action_digest, requested_expires_at, state,
  created_by_subject_id, created_at, decided_by_subject_id, decided_at,
  decision_reason, execution_grant_id`

function integer(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new PlatformApiError("EXECUTION_GRANT_DATA_INVALID", 500)
  return parsed
}

function nullable(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

function request(row: Row): ExecutionGrantRequest {
  if (row.state !== "PENDING" && row.state !== "APPROVED" && row.state !== "DENIED") {
    throw new PlatformApiError("EXECUTION_GRANT_DATA_INVALID", 500)
  }
  return {
    tenant_id: String(row.tenant_id),
    request_id: String(row.request_id),
    revision: integer(row.revision),
    subject_id: String(row.subject_id),
    acting_client_id: String(row.acting_client_id),
    resource_id: String(row.resource_id),
    capability_id: String(row.capability_id),
    action_digest: String(row.action_digest),
    requested_expires_at: integer(row.requested_expires_at),
    state: row.state,
    created_by_subject_id: String(row.created_by_subject_id),
    created_at: integer(row.created_at),
    decided_by_subject_id: nullable(row.decided_by_subject_id),
    decided_at: row.decided_at == null ? null : integer(row.decided_at),
    decision_reason: nullable(row.decision_reason),
    execution_grant_id: nullable(row.execution_grant_id),
  }
}

export function createPostgresExecutionGrantRepository(options: {
  sql: SqlAdapter
  releasePublisher?: ResourceLifecycleReleasePublisher
}): ExecutionGrantRepository {
  return {
    async createRequest(value) {
      const result = await options.sql.query<Row>(
        `insert into genio_one_execution_grant_request_revisions (${columns})
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         on conflict do nothing returning ${columns}`,
        [value.tenant_id, value.request_id, value.revision, value.subject_id, value.acting_client_id,
          value.resource_id, value.capability_id, value.action_digest, value.requested_expires_at,
          value.state, value.created_by_subject_id, value.created_at, value.decided_by_subject_id,
          value.decided_at, value.decision_reason, value.execution_grant_id],
      )
      if (!result.rows[0]) throw new PlatformApiError("EXECUTION_GRANT_REQUEST_EXISTS", 409)
      return request(result.rows[0])
    },
    async latestRequest(input) {
      const result = await options.sql.query<Row>(
        `select ${columns} from genio_one_execution_grant_request_revisions
          where tenant_id = $1 and request_id = $2 order by revision desc limit 1`,
        [input.tenantId, input.requestId],
      )
      return result.rows[0] ? request(result.rows[0]) : null
    },
    async listLatestRequests(input) {
      const result = await options.sql.query<Row>(
        `select distinct on (request_id) ${columns}
           from genio_one_execution_grant_request_revisions where tenant_id = $1
          order by request_id, revision desc`,
        [input.tenantId],
      )
      return result.rows.map(request).sort((left, right) => right.created_at - left.created_at || left.request_id.localeCompare(right.request_id))
    },
    async decide(input) {
      const next = {
        ...input.current,
        revision: input.current.revision + 1,
        state: input.decision === "APPROVE" ? "APPROVED" as const : "DENIED" as const,
        decided_by_subject_id: input.actorSubjectId,
        decided_at: input.decidedAt,
        decision_reason: input.reason,
        execution_grant_id: input.grant?.execution_grant_id ?? null,
      }
      return options.sql.transaction(async (transaction) => {
        const inserted = await transaction.query<Row>(
          `insert into genio_one_execution_grant_request_revisions (${columns})
           select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
            where exists (select 1 from genio_one_execution_grant_request_revisions
             where tenant_id = $1 and request_id = $2 and revision = $17 and state = 'PENDING')
           on conflict do nothing returning ${columns}`,
          [next.tenant_id, next.request_id, next.revision, next.subject_id, next.acting_client_id,
            next.resource_id, next.capability_id, next.action_digest, next.requested_expires_at,
            next.state, next.created_by_subject_id, next.created_at, next.decided_by_subject_id,
            next.decided_at, next.decision_reason, next.execution_grant_id, input.current.revision],
        )
        if (!inserted.rows[0]) throw new PlatformApiError("EXECUTION_GRANT_REQUEST_REVISION_CONFLICT", 409)
        if (input.grant) {
          await transaction.query(
            `insert into genio_one_execution_grants
               (tenant_id, execution_grant_id, request_id, subject_id, acting_client_id,
                resource_id, capability_id, action_digest, issued_at, expires_at, issued_by_subject_id)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [input.grant.tenant_id, input.grant.execution_grant_id, input.grant.request_id,
              input.grant.subject_id, input.grant.acting_client_id, input.grant.resource_id,
              input.grant.capability_id, input.grant.action_digest, input.grant.issued_at,
              input.grant.expires_at, input.grant.issued_by_subject_id],
          )
          const publication = await transaction.query<{ gateway_id: string }>(
            `select gateway_id from genio_one_publications
              where tenant_id = $1 and resource_id = $2 and publication_state = 'PUBLISHED'
              order by endpoint_revision desc limit 1 for update`,
            [input.grant.tenant_id, input.grant.resource_id],
          )
          if (publication.rows[0]) {
            if (!options.releasePublisher) throw new PlatformApiError("GATEWAY_RELEASE_PUBLISHER_REQUIRED", 503)
            await options.releasePublisher.reconcileInTransaction({ transaction, tenantId: input.grant.tenant_id, gatewayId: publication.rows[0].gateway_id, issuedAt: input.decidedAt })
          }
        }
        return request(inserted.rows[0])
      })
    },
  }
}
