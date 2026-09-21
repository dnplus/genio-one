import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createPostgresGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/postgres"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import type { SqlAdapter, SqlQueryResult } from "../src/persistence/sql-adapter"
import type { GatewayAuthorizationAuditIngest } from "../src/capabilities/audit-events/contract"

test("SIEM configuration is limited to Tenant Administrators", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      admin: {
        tenant_id: "tenant-acme",
        subject_id: "person-admin",
        client_id: "management-ui",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
      },
      user: {
        tenant_id: "tenant-acme",
        subject_id: "person-user",
        client_id: "management-ui",
        role: "USER",
        organization_ids: [],
      },
    }),
  })
  const payload = {
    destination_id: "primary",
    endpoint_url: "https://siem.example/events",
    event_kinds: ["ONE_POLICY_DECISION"],
    enabled: true,
  }

  const denied = await app.inject({
    method: "PUT",
    url: "/v1/tenants/tenant-acme/siem-destination",
    headers: { authorization: "Bearer user" },
    payload,
  })
  assert.equal(denied.statusCode, 403)

  const configured = await app.inject({
    method: "PUT",
    url: "/v1/tenants/tenant-acme/siem-destination",
    headers: { authorization: "Bearer admin" },
    payload,
  })
  assert.equal(configured.statusCode, 200)
  assert.equal(configured.json().configured_by.subject_id, "person-admin")
  await app.close()
})

test("Audit persistence stores an object rather than a JSONB string", async () => {
  let statement = ""
  const sql: SqlAdapter = {
    async query<Row extends Record<string, unknown>>(
      text: string,
      parameters?: readonly unknown[],
    ): Promise<SqlQueryResult<Row>> {
      statement = text
      return {
        rows: [{
          tenant_id: "tenant-acme",
          audit_event_id: "audit-1",
          event: JSON.parse(String(parameters?.[4])),
          occurred_at: 1_000,
        }] as unknown as Row[],
        rowCount: 1,
      }
    },
    async transaction(work) {
      return work(this)
    },
  }
  const store = createPostgresGatewayAuthorizationAuditStore({ sql })
  await store.record({
    tenantId: "tenant-acme",
    event: {
      audit_event_id: "audit-1",
      correlation_id: "correlation-1",
      kind: "ONE_POLICY_DECISION",
      occurred_at: 1_000,
    } as never,
  })
  assert.match(statement, /\$5::text::jsonb/)
})

test("PostgreSQL audit persistence keeps identical retries and rejects a changed event identity", async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const sql: SqlAdapter = {
    async query<Row extends Record<string, unknown>>(
      text: string,
      parameters: readonly unknown[] = [],
    ): Promise<SqlQueryResult<Row>> {
      const key = `${parameters[0]}\0${parameters[1]}`
      if (text.includes("insert into genio_one_gateway_authorization_audit_events")) {
        const existing = rows.get(key)
        if (existing) return { rows: [], rowCount: 0 }
        const row = {
          tenant_id: parameters[0],
          audit_event_id: parameters[1],
          correlation_id: parameters[2],
          occurred_at: parameters[3],
          event: JSON.parse(String(parameters[4])),
        }
        rows.set(key, row)
        return { rows: [row as unknown as Row], rowCount: 1 }
      }
      if (text.includes("where tenant_id = $1 and audit_event_id = $2")) {
        const row = rows.get(key)
        return row ? { rows: [row as Row], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 0 }
    },
    async transaction(work) {
      return work(this)
    },
  }
  const store = createPostgresGatewayAuthorizationAuditStore({ sql })
  const event: GatewayAuthorizationAuditIngest = {
    audit_event_id: "audit-immutable",
    correlation_id: "correlation-immutable",
    kind: "ONE_POLICY_DECISION" as const,
    outcome: "ALLOW" as const,
    occurred_at: 1_000,
  } as never
  const first = await store.record({ tenantId: "tenant", event })
  assert.deepEqual(await store.record({ tenantId: "tenant", event }), first)
  await assert.rejects(store.record({
    tenantId: "tenant",
    event: { ...event, outcome: "DENY" },
  }), { code: "AUDIT_EVENT_CONFLICT" })
  assert.equal((rows.get("tenant\0audit-immutable")?.event as { outcome: string }).outcome, "ALLOW")
})
