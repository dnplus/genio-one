import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import { SYSTEM_AUDIT_TENANT_ID, type AuthenticationAttemptReceipt, type AuthorizationAuditEvent, type RuntimePolicyAuditEvent } from "./contract"
import type { GatewayAuthorizationAuditStore, PolicyAuthorizationAuditStore } from "./module"
import { canonicalJson } from "@genioone/protocol/canonical"
import { PlatformApiError } from "../errors"

interface AuditRow extends Record<string, unknown> {
  tenant_id: string
  audit_event_id: string
  event: AuthorizationAuditEvent | AuthenticationAttemptReceipt | string
  occurred_at: number | string
}

function mapRow(row: AuditRow): AuthorizationAuditEvent {
  const event = typeof row.event === "string" ? JSON.parse(row.event) : row.event
  return { ...event, tenant_id: row.tenant_id, occurred_at: Number(row.occurred_at) }
}

async function recordAuthorizationAuditEvent(
  executor: Pick<SqlAdapter, "query"> | SqlTransaction,
  input: Parameters<GatewayAuthorizationAuditStore["record"]>[0],
): Promise<AuthorizationAuditEvent> {
  const { tenantId, event } = input
  const value = { ...event, tenant_id: tenantId }
  const result = await executor.query<AuditRow>(
    `insert into genio_one_gateway_authorization_audit_events
       (tenant_id, audit_event_id, correlation_id, occurred_at, event)
     values ($1,$2,$3,$4,$5::text::jsonb)
     on conflict (tenant_id, audit_event_id) do nothing
     returning tenant_id, audit_event_id, event, occurred_at`,
    [tenantId, event.audit_event_id, event.correlation_id, event.occurred_at, JSON.stringify(value)],
  )
  if (result.rows[0]) return mapRow(result.rows[0])
  const existing = await executor.query<AuditRow>(
    `select tenant_id, audit_event_id, event, occurred_at
       from genio_one_gateway_authorization_audit_events
      where tenant_id = $1 and audit_event_id = $2`,
    [tenantId, event.audit_event_id],
  )
  const row = existing.rows[0]
  if (!row) throw new PlatformApiError("AUDIT_EVENT_WRITE_RACE", 500)
  const mapped = mapRow(row)
  if (canonicalJson(mapped) !== canonicalJson(value)) {
    throw new PlatformApiError("AUDIT_EVENT_CONFLICT", 409)
  }
  return mapped
}

function mapAuthenticationAttemptRow(row: AuditRow): AuthenticationAttemptReceipt {
  const event = typeof row.event === "string" ? JSON.parse(row.event) : row.event
  if (
    row.tenant_id !== SYSTEM_AUDIT_TENANT_ID ||
    !event ||
    typeof event !== "object" ||
    event.kind !== "MANAGEMENT_AUTHENTICATION_ATTEMPT" ||
    event.scope !== "SYSTEM"
  ) {
    throw new PlatformApiError("AUTHENTICATION_ATTEMPT_INVALID", 500)
  }
  return event as AuthenticationAttemptReceipt
}

async function recordAuthenticationAttempt(
  executor: Pick<SqlAdapter, "query"> | SqlTransaction,
  receipt: AuthenticationAttemptReceipt,
): Promise<AuthenticationAttemptReceipt> {
  const result = await executor.query<AuditRow>(
    `insert into genio_one_gateway_authorization_audit_events
       (tenant_id, audit_event_id, correlation_id, occurred_at, event)
     values ($1,$2,$3,$4,$5::text::jsonb)
     on conflict (tenant_id, audit_event_id) do nothing
     returning tenant_id, audit_event_id, event, occurred_at`,
    [SYSTEM_AUDIT_TENANT_ID, receipt.authentication_attempt_id, receipt.correlation_id, receipt.occurred_at, JSON.stringify(receipt)],
  )
  if (result.rows[0]) return mapAuthenticationAttemptRow(result.rows[0])
  const existing = await executor.query<AuditRow>(
    `select tenant_id, audit_event_id, event, occurred_at
       from genio_one_gateway_authorization_audit_events
      where tenant_id = $1 and audit_event_id = $2`,
    [SYSTEM_AUDIT_TENANT_ID, receipt.authentication_attempt_id],
  )
  const row = existing.rows[0]
  if (!row) throw new PlatformApiError("AUTHENTICATION_ATTEMPT_WRITE_RACE", 500)
  const mapped = mapAuthenticationAttemptRow(row)
  if (canonicalJson(mapped) !== canonicalJson(receipt)) {
    throw new PlatformApiError("AUTHENTICATION_ATTEMPT_CONFLICT", 409)
  }
  return mapped
}

export function createPostgresGatewayAuthorizationAuditStore(options: { sql: SqlAdapter }): PolicyAuthorizationAuditStore {
  return {
    async record(input) {
      return recordAuthorizationAuditEvent(options.sql, input)
    },
    async recordAuthenticationAttempt({ receipt }) {
      return recordAuthenticationAttempt(options.sql, receipt)
    },
    async recordInTransaction(input) {
      return recordAuthorizationAuditEvent(input.transaction, input)
    },
    async findById({ tenantId, auditEventId, transaction }) {
      const result = await (transaction ?? options.sql).query<AuditRow>(
        `select tenant_id, audit_event_id, event, occurred_at
           from genio_one_gateway_authorization_audit_events
          where tenant_id = $1 and audit_event_id = $2`,
        [tenantId, auditEventId],
      )
      return result.rows[0] ? mapRow(result.rows[0]) : null
    },
    async query(input) {
      const conditions = ["tenant_id = $1"]
      const parameters: unknown[] = [input.tenantId]
      const addCondition = (sql: string, value: unknown) => {
        parameters.push(value)
        conditions.push(sql.replace("?", `$${parameters.length}`))
      }
      if (input.correlationId) addCondition("correlation_id = ?", input.correlationId)
      if (input.enforcementPointId) addCondition("event ->> 'enforcement_point_id' = ?", input.enforcementPointId)
      if (input.kind) addCondition("event ->> 'kind' = ?", input.kind)
      if (input.outcome) addCondition("event ->> 'outcome' = ?", input.outcome)
      if (input.resourceId) addCondition("event ->> 'resource_id' = ?", input.resourceId)
      if (input.subjectId) addCondition("event -> 'subject' ->> 'subject_id' = ?", input.subjectId)
      if (input.from !== undefined) addCondition("occurred_at >= ?", input.from)
      if (input.to !== undefined) addCondition("occurred_at <= ?", input.to)
      parameters.push(input.limit + 1, input.offset)
      const result = await options.sql.query<AuditRow & { source_revision: number | string }>(
        `select page.tenant_id, page.audit_event_id, page.event, page.occurred_at, revision.source_revision
         from (
           select count(*) as source_revision
           from genio_one_gateway_authorization_audit_events
           where ${conditions.join(" and ")}
         ) revision
         left join (
           select tenant_id, audit_event_id, event, occurred_at
           from genio_one_gateway_authorization_audit_events
           where ${conditions.join(" and ")}
           order by occurred_at desc, audit_event_id desc
           limit $${parameters.length - 1} offset $${parameters.length}
         ) page on true
         order by page.occurred_at desc, page.audit_event_id desc`,
        parameters,
      )
      const rows = result.rows.filter((row) => row.audit_event_id !== null)
      return {
        events: rows.slice(0, input.limit).map(mapRow),
        hasMore: rows.length > input.limit,
        sourceRevision: Number(result.rows[0]?.source_revision ?? 0),
      }
    },
    async queryAuthenticationAttempts(input) {
      const conditions = ["tenant_id = $1", "event ->> 'kind' = 'MANAGEMENT_AUTHENTICATION_ATTEMPT'"]
      const parameters: unknown[] = [SYSTEM_AUDIT_TENANT_ID]
      const addCondition = (sql: string, value: unknown) => {
        parameters.push(value)
        conditions.push(sql.replace("?", `$${parameters.length}`))
      }
      if (input.correlationId) addCondition("correlation_id = ?", input.correlationId)
      if (input.code) addCondition("event ->> 'code' = ?", input.code)
      if (input.outcome) addCondition("event ->> 'outcome' = ?", input.outcome)
      parameters.push(input.limit + 1, input.offset)
      const result = await options.sql.query<AuditRow>(
        `select tenant_id, audit_event_id, event, occurred_at
           from genio_one_gateway_authorization_audit_events
          where ${conditions.join(" and ")}
          order by occurred_at desc, audit_event_id desc
          limit $${parameters.length - 1} offset $${parameters.length}`,
        parameters,
      )
      const revision = await options.sql.query<{ source_revision: number | string }>(
        `select count(*) as source_revision
           from genio_one_gateway_authorization_audit_events
          where tenant_id = $1 and event ->> 'kind' = 'MANAGEMENT_AUTHENTICATION_ATTEMPT'`,
        [SYSTEM_AUDIT_TENANT_ID],
      )
      return {
        receipts: result.rows.slice(0, input.limit).map(mapAuthenticationAttemptRow),
        hasMore: result.rows.length > input.limit,
        sourceRevision: Number(revision.rows[0]?.source_revision ?? 0),
      }
    },
    async findRuntimeAuthorization({ tenantId, correlationId }) {
      const result = await options.sql.query<AuditRow>(
        `select tenant_id, audit_event_id, event, occurred_at
         from genio_one_gateway_authorization_audit_events
         where tenant_id = $1
           and correlation_id = $2
           and event ->> 'kind' = 'RUNTIME_POLICY_DECISION'
           and event ->> 'phase' = 'AUTHORIZE'
         order by occurred_at desc, audit_event_id desc
         limit 1`,
        [tenantId, correlationId],
      )
      const value = result.rows[0] ? mapRow(result.rows[0]) : null
      return value && value.kind === "RUNTIME_POLICY_DECISION" ? value as RuntimePolicyAuditEvent : null
    },
    async findRuntimeReport({ tenantId, correlationId }) {
      const result = await options.sql.query<AuditRow>(
        `select tenant_id, audit_event_id, event, occurred_at
         from genio_one_gateway_authorization_audit_events
         where tenant_id = $1
           and correlation_id = $2
           and event ->> 'kind' = 'RUNTIME_POLICY_DECISION'
           and event ->> 'phase' = 'REPORT'
         order by occurred_at desc, audit_event_id desc
         limit 1`,
        [tenantId, correlationId],
      )
      const value = result.rows[0] ? mapRow(result.rows[0]) : null
      return value && value.kind === "RUNTIME_POLICY_DECISION" ? value as RuntimePolicyAuditEvent : null
    },
  } as PolicyAuthorizationAuditStore
}
