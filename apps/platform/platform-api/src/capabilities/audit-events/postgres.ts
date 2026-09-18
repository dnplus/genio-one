import type { SqlAdapter } from "../../persistence/sql-adapter"
import type { AuthorizationAuditEvent, RuntimePolicyAuditEvent } from "./contract"
import type { GatewayAuthorizationAuditStore } from "./module"

interface AuditRow extends Record<string, unknown> {
  tenant_id: string
  audit_event_id: string
  event: AuthorizationAuditEvent | string
  occurred_at: number | string
}

function mapRow(row: AuditRow): AuthorizationAuditEvent {
  const event = typeof row.event === "string" ? JSON.parse(row.event) : row.event
  return { ...event, tenant_id: row.tenant_id, occurred_at: Number(row.occurred_at) }
}

export function createPostgresGatewayAuthorizationAuditStore(options: { sql: SqlAdapter }): GatewayAuthorizationAuditStore {
  return {
    async record({ tenantId, event }) {
      const value = { ...event, tenant_id: tenantId }
      const result = await options.sql.query<AuditRow>(
        `insert into genio_one_gateway_authorization_audit_events
           (tenant_id, audit_event_id, correlation_id, occurred_at, event)
         values ($1,$2,$3,$4,$5::text::jsonb)
         on conflict (tenant_id, audit_event_id) do update set event = excluded.event
         returning tenant_id, audit_event_id, event, occurred_at`,
        [tenantId, event.audit_event_id, event.correlation_id, event.occurred_at, JSON.stringify(value)],
      )
      return mapRow(result.rows[0]!)
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
         where tenant_id = $1`,
        [input.tenantId],
      )
      return {
        events: result.rows.slice(0, input.limit).map(mapRow),
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
  }
}
