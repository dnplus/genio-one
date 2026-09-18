import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createPostgresGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/postgres"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import type { SqlAdapter, SqlQueryResult } from "../src/persistence/sql-adapter"

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
