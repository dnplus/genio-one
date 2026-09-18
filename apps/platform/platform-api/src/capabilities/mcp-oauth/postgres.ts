import type { SqlAdapter } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type {
  McpOAuthBindingRecord,
  McpOAuthSessionRecord,
  McpOAuthStore,
} from "./module"

type DatabaseRow = Record<string, unknown>

function string(row: DatabaseRow, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || !value) throw new PlatformApiError("MCP_OAUTH_DATA_INVALID", 500)
  return value
}

function timestamp(row: DatabaseRow, key: string): number {
  const value = Number(row[key])
  if (!Number.isSafeInteger(value) || value < 0) throw new PlatformApiError("MCP_OAUTH_DATA_INVALID", 500)
  return value
}

function session(row: DatabaseRow): McpOAuthSessionRecord {
  return {
    tenant_id: string(row, "tenant_id"),
    session_id: string(row, "session_id"),
    state_hash: string(row, "state_hash"),
    resource_id: string(row, "resource_id"),
    connection_id: string(row, "connection_id"),
    subject_id: string(row, "subject_id"),
    return_url: string(row, "return_url"),
    sealed_state: string(row, "sealed_state"),
    expires_at: timestamp(row, "expires_at"),
    created_at: timestamp(row, "created_at"),
  }
}

function binding(row: DatabaseRow): McpOAuthBindingRecord {
  return {
    tenant_id: string(row, "tenant_id"),
    resource_id: string(row, "resource_id"),
    connection_id: string(row, "connection_id"),
    subject_id: string(row, "subject_id"),
    issuer: string(row, "issuer"),
    resource_url: string(row, "resource_url"),
    sealed_state: string(row, "sealed_state"),
    updated_at: timestamp(row, "updated_at"),
  }
}

const SESSION_COLUMNS = `tenant_id, session_id, state_hash, resource_id, connection_id,
  subject_id, return_url, sealed_state, extract(epoch from expires_at)::bigint as expires_at,
  extract(epoch from created_at)::bigint as created_at`

const BINDING_COLUMNS = `tenant_id, resource_id, connection_id, subject_id, issuer,
  resource_url, sealed_state, extract(epoch from updated_at)::bigint as updated_at`

export function createPostgresMcpOAuthStore(options: { sql: SqlAdapter }): McpOAuthStore {
  return {
    async createSession(value) {
      await options.sql.query(
        `insert into genio_one_mcp_oauth_sessions
           (tenant_id, session_id, state_hash, resource_id, connection_id, subject_id,
            return_url, sealed_state, expires_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8,
                 to_timestamp($9), to_timestamp($10))`,
        [value.tenant_id, value.session_id, value.state_hash, value.resource_id,
          value.connection_id, value.subject_id, value.return_url, value.sealed_state,
          value.expires_at, value.created_at],
      )
    },
    async getSessionById(input) {
      const result = await options.sql.query<DatabaseRow>(
        `select ${SESSION_COLUMNS} from genio_one_mcp_oauth_sessions
          where tenant_id = $1 and session_id = $2`,
        [input.tenantId, input.sessionId],
      )
      return result.rows[0] ? session(result.rows[0]) : null
    },
    async getSessionByStateHash(value) {
      const result = await options.sql.query<DatabaseRow>(
        `select ${SESSION_COLUMNS} from genio_one_mcp_oauth_sessions where state_hash = $1`,
        [value],
      )
      return result.rows[0] ? session(result.rows[0]) : null
    },
    async updateSession(value) {
      const result = await options.sql.query<DatabaseRow>(
        `update genio_one_mcp_oauth_sessions set sealed_state = $3
          where tenant_id = $1 and session_id = $2 returning session_id`,
        [value.tenant_id, value.session_id, value.sealed_state],
      )
      if (!result.rows[0]) throw new PlatformApiError("MCP_OAUTH_SESSION_EXPIRED", 410)
    },
    async deleteSession(input) {
      await options.sql.query(
        `delete from genio_one_mcp_oauth_sessions where tenant_id = $1 and session_id = $2`,
        [input.tenantId, input.sessionId],
      )
    },
    async putBinding(value) {
      await options.sql.query(
        `insert into genio_one_mcp_oauth_bindings
           (tenant_id, resource_id, connection_id, subject_id, issuer,
            resource_url, sealed_state, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))
         on conflict (tenant_id, connection_id, subject_id)
         do update set resource_id = excluded.resource_id,
                       issuer = excluded.issuer,
                       resource_url = excluded.resource_url,
                       sealed_state = excluded.sealed_state,
                       updated_at = excluded.updated_at`,
        [value.tenant_id, value.resource_id, value.connection_id, value.subject_id,
          value.issuer, value.resource_url, value.sealed_state, value.updated_at],
      )
    },
    async updateBindingIfCurrent(previous, value) {
      const result = await options.sql.query(
        `update genio_one_mcp_oauth_bindings set sealed_state=$5, updated_at=to_timestamp($6)
          where tenant_id=$1 and connection_id=$2 and subject_id=$3 and sealed_state=$4 returning connection_id`,
        [previous.tenant_id, previous.connection_id, previous.subject_id, previous.sealed_state, value.sealed_state, value.updated_at],
      )
      return result.rows.length === 1
    },
    async getBinding(input) {
      const result = await options.sql.query<DatabaseRow>(
        `select ${BINDING_COLUMNS} from genio_one_mcp_oauth_bindings
          where tenant_id = $1 and connection_id = $2 and subject_id = $3`,
        [input.tenantId, input.connectionId, input.subjectId],
      )
      return result.rows[0] ? binding(result.rows[0]) : null
    },
    async deleteBinding(input) {
      await options.sql.query(
        `delete from genio_one_mcp_oauth_bindings
          where tenant_id = $1 and connection_id = $2 and subject_id = $3`,
        [input.tenantId, input.connectionId, input.subjectId],
      )
    },
    async listBindings(input) {
      const result = await options.sql.query<DatabaseRow>(
        `select ${BINDING_COLUMNS} from genio_one_mcp_oauth_bindings
          where tenant_id = $1 and resource_id = $2 and subject_id = $3
          order by connection_id`,
        [input.tenantId, input.resourceId, input.subjectId],
      )
      return result.rows.map(binding)
    },
  }
}
