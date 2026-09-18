import type { SqlAdapter } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type { AgentDelegation } from "./contract"
import type { AgentDelegationRepository } from "./module"
import type { ResourceLifecycleReleasePublisher } from "../resources/module"

type Row = Record<string, unknown>

function integer(value: unknown): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new PlatformApiError("AGENT_DELEGATION_DATA_INVALID", 500)
  return result
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new PlatformApiError("AGENT_DELEGATION_DATA_INVALID", 500)
  }
  return [...value]
}

function map(row: Row): AgentDelegation {
  if (row.state !== "ACTIVE" && row.state !== "REVOKED") {
    throw new PlatformApiError("AGENT_DELEGATION_DATA_INVALID", 500)
  }
  return {
    tenant_id: String(row.tenant_id),
    delegation_id: String(row.delegation_id),
    revision: integer(row.revision),
    principal_subject_id: String(row.principal_subject_id),
    agent_subject_id: String(row.agent_subject_id),
    resource_id: String(row.resource_id),
    capability_ids: strings(row.capability_ids),
    acting_client_ids: strings(row.acting_client_ids),
    starts_at: integer(row.starts_at),
    expires_at: integer(row.expires_at),
    revocation_generation: integer(row.revocation_generation),
    state: row.state,
    created_by_subject_id: String(row.created_by_subject_id),
    created_at: integer(row.created_at),
  }
}

const COLUMNS = `tenant_id, delegation_id, revision, principal_subject_id,
  agent_subject_id, resource_id, capability_ids, acting_client_ids, starts_at,
  expires_at, revocation_generation, state, created_by_subject_id, created_at`

export function createPostgresAgentDelegationRepository(options: {
  sql: SqlAdapter
  releasePublisher?: ResourceLifecycleReleasePublisher
}): AgentDelegationRepository {
  const sql = options.sql
  return {
    async create(value) {
      return sql.transaction(async (transaction) => {
        const result = await transaction.query<Row>(
          `insert into genio_one_agent_delegation_revisions (${COLUMNS})
           values ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$11,$12,$13,$14)
           on conflict do nothing returning ${COLUMNS}`,
          [value.tenant_id, value.delegation_id, value.revision, value.principal_subject_id,
            value.agent_subject_id, value.resource_id, value.capability_ids,
            value.acting_client_ids, value.starts_at, value.expires_at,
            value.revocation_generation, value.state, value.created_by_subject_id, value.created_at],
        )
        if (!result.rows[0]) throw new PlatformApiError("AGENT_DELEGATION_EXISTS", 409)
        const publication = await transaction.query<{ gateway_id: string }>(
          `select gateway_id from genio_one_publications
            where tenant_id = $1 and resource_id = $2 and publication_state = 'PUBLISHED'
            order by endpoint_revision desc limit 1 for update`,
          [value.tenant_id, value.resource_id],
        )
        if (publication.rows[0]) {
          if (!options.releasePublisher) throw new PlatformApiError("GATEWAY_RELEASE_PUBLISHER_REQUIRED", 503)
          await options.releasePublisher.reconcileInTransaction({
            transaction,
            tenantId: value.tenant_id,
            gatewayId: publication.rows[0].gateway_id,
            issuedAt: value.created_at,
          })
        }
        return map(result.rows[0])
      })
    },
    async latest(input) {
      const result = await sql.query<Row>(
        `select ${COLUMNS} from genio_one_agent_delegation_revisions
          where tenant_id = $1 and delegation_id = $2
          order by revision desc limit 1`,
        [input.tenantId, input.delegationId],
      )
      return result.rows[0] ? map(result.rows[0]) : null
    },
    async listLatest(input) {
      const result = await sql.query<Row>(
        `select distinct on (delegation_id) ${COLUMNS}
           from genio_one_agent_delegation_revisions
          where tenant_id = $1
          order by delegation_id, revision desc`,
        [input.tenantId],
      )
      return result.rows.map(map)
    },
    async appendRevoked(input) {
      const value = {
        ...input.current,
        revision: input.current.revision + 1,
        revocation_generation: input.current.revocation_generation + 1,
        state: "REVOKED" as const,
        created_by_subject_id: input.actorSubjectId,
        created_at: input.createdAt,
      }
      return sql.transaction(async (transaction) => {
        const result = await transaction.query<Row>(
          `insert into genio_one_agent_delegation_revisions (${COLUMNS})
           select $1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$11,$12,$13,$14
            where exists (
              select 1 from genio_one_agent_delegation_revisions
               where tenant_id = $1 and delegation_id = $2 and revision = $15 and state = 'ACTIVE'
            )
           on conflict do nothing returning ${COLUMNS}`,
          [value.tenant_id, value.delegation_id, value.revision, value.principal_subject_id,
            value.agent_subject_id, value.resource_id, value.capability_ids,
            value.acting_client_ids, value.starts_at, value.expires_at,
            value.revocation_generation, value.state, value.created_by_subject_id,
            value.created_at, input.current.revision],
        )
        if (!result.rows[0]) throw new PlatformApiError("AGENT_DELEGATION_REVISION_CONFLICT", 409)
        const publication = await transaction.query<{ gateway_id: string }>(
          `select gateway_id from genio_one_publications
            where tenant_id = $1 and resource_id = $2 and publication_state = 'PUBLISHED'
            order by endpoint_revision desc limit 1 for update`,
          [value.tenant_id, value.resource_id],
        )
        if (publication.rows[0]) {
          if (!options.releasePublisher) throw new PlatformApiError("GATEWAY_RELEASE_PUBLISHER_REQUIRED", 503)
          await options.releasePublisher.reconcileInTransaction({
            transaction,
            tenantId: value.tenant_id,
            gatewayId: publication.rows[0].gateway_id,
            issuedAt: value.created_at,
          })
        }
        return map(result.rows[0])
      })
    },
  }
}
