import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { accessGovernanceAuditEvent, autoGrantActivationAuditEvent } from "../src/capabilities/access/audit"
import type { GatewayAuthorizationAuditIngest } from "../src/capabilities/audit-events/contract"
import type { GatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/module"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createInMemoryGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/memory"
import { createPostgresGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/postgres"
import { runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter, type SqlAdapter, type SqlQueryResult } from "../src/persistence/sql-adapter"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

const resourceId = "resource-c5a8149e-a059-4018-97b2-b0b6499a1b76"
const tenantA = "tenant-export-a"
const tenantB = "tenant-export-b"
const exportFrom = 1_758_009_600
const exportTo = 1_758_614_399

function auditEvent(input: {
  id: string
  correlationId: string
  resourceId?: string
  occurredAt: number
}): GatewayAuthorizationAuditIngest {
  return {
    audit_event_id: input.id,
    correlation_id: input.correlationId,
    kind: "ONE_POLICY_DECISION",
    outcome: "ALLOW",
    subject: { subject_id: "person-export", evidence_level: "VERIFIED" },
    target_subject_id: null,
    actor_subject: null,
    acting_client: { acting_client_id: "management-ui", evidence_level: "VERIFIED" },
    resource_id: input.resourceId ?? resourceId,
    capability_id: "model.invoke",
    device_id: null,
    endpoint_version: null,
    desired_state_revision: null,
    applied_state_revision: null,
    applied_policy_version: "one-policy@7",
    policy_proposal_id: null,
    proposed_policy_version: null,
    access_group_id: null,
    destination_host: null,
    routing_policy_rule_id: null,
    route: "MANAGED",
    missing_deployment_capability: null,
    decision: {
      decision_id: `${input.id}-decision`,
      correlation_id: input.correlationId,
      policy_version: "one-policy@7",
      winning_rule_id: "rule-export",
      reason: "ALLOW",
      visibility: "VISIBLE",
      access: "ENTITLED",
      route: "MANAGED",
      obligations: [],
      entitlement_conditions: {
        required_verified_acting_client_id: null,
        requires_device: false,
      },
      entitlement_id: null,
      auto_grant_valid_for: null,
      input_receipt: {
        requested_model_id: null,
        effective_model_id: null,
      },
    },
    access_request_id: null,
    entitlement_id: null,
    enforcement_point_id: "AI_GATEWAY",
    obligation_kind: null,
    runaway_trigger: null,
    upstream_attempted: false,
    occurred_at: input.occurredAt,
  }
}

function principals() {
  return createStaticPrincipalAuthenticator({
    "admin-a": {
      tenant_id: tenantA,
      subject_id: "person-admin-a",
      client_id: "management-ui",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: [],
      scopes: ["genioone-management", "audit.export"],
    },
    "admin-b": {
      tenant_id: tenantB,
      subject_id: "person-admin-b",
      client_id: "management-ui",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: [],
      scopes: ["genioone-management", "audit.export"],
    },
    "org-admin-a": {
      tenant_id: tenantA,
      subject_id: "person-org-admin-a",
      client_id: "management-ui",
      role: "ORGANIZATION_ADMINISTRATOR",
      organization_ids: ["organization-a"],
      scopes: ["genioone-management", "audit.export"],
    },
  })
}

async function createApp(options: { auditEvents?: GatewayAuthorizationAuditStore } = {}) {
  const modules = createInMemoryPlatformModules()
  const app = await createManagementApi({
    modules: options.auditEvents ? { ...modules, auditEvents: options.auditEvents } : modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: principals(),
  })
  return { app, modules }
}

function exportUrl(tenantId: string, resource = resourceId) {
  const query = new URLSearchParams({
    from: String(exportFrom),
    to: String(exportTo),
    resource_id: resource,
  })
  return `/v1/tenants/${tenantId}/audit-export?${query}`
}

test("audit export returns only the requested tenant, resource, and time range", async () => {
  const { app, modules } = await createApp()
  await modules.auditEvents.record({
    tenantId: tenantA,
    event: auditEvent({ id: "audit-in-range", correlationId: "decision-in-range", occurredAt: exportFrom }),
  })
  await modules.auditEvents.record({
    tenantId: tenantA,
    event: auditEvent({ id: "audit-after-range", correlationId: "decision-after-range", occurredAt: exportTo + 1 }),
  })
  await modules.auditEvents.record({
    tenantId: tenantA,
    event: auditEvent({ id: "audit-other-resource", correlationId: "decision-other-resource", resourceId: "resource-other", occurredAt: exportFrom }),
  })
  await modules.auditEvents.record({
    tenantId: tenantB,
    event: auditEvent({ id: "audit-foreign-tenant", correlationId: "decision-foreign-tenant", occurredAt: exportFrom }),
  })
  await modules.auditEvents.record({
    tenantId: tenantA,
    event: autoGrantActivationAuditEvent({
      tenantId: tenantA,
      subjectId: "person-export",
      clientId: "self-service-ui",
      correlationId: "activation-in-range",
      resourceId,
      capabilityId: "model.invoke",
      entitlementId: "entitlement-auto-grant",
      disposition: "GRANTED",
      occurredAt: exportFrom,
    }),
  })

  const response = await app.inject({
    method: "GET",
    url: exportUrl(tenantA),
    headers: { authorization: "Bearer admin-a" },
  })

  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), {
    schema_version: "genioone.audit-export.v1",
    tenant_id: tenantA,
    from: exportFrom,
    to: exportTo,
    resource_id: resourceId,
    record_count: 1,
    records: [{
      policy_version: "one-policy@7",
      decision_correlation_id: "decision-in-range",
      audit_event_id: "audit-in-range",
      correlation_id: "decision-in-range",
      resource_id: resourceId,
      occurred_at: exportFrom,
    }],
  })

  const foreignTenant = await app.inject({
    method: "GET",
    url: exportUrl(tenantA),
    headers: { authorization: "Bearer admin-b" },
  })
  assert.equal(foreignTenant.statusCode, 403)
  assert.equal(foreignTenant.json().code, "TENANT_ACCESS_DENIED")
  await app.close()
})

test("audit export includes only policy decisions when governance events share its resource and time range", async () => {
  const { app, modules } = await createApp()
  await modules.auditEvents.record({
    tenantId: tenantA,
    event: auditEvent({ id: "audit-policy-decision", correlationId: "decision-policy", occurredAt: exportFrom }),
  })
  await modules.auditEvents.record({
    tenantId: tenantA,
    event: accessGovernanceAuditEvent({
      tenantId: tenantA,
      correlationId: "access-governance-change",
      actorSubjectId: "person-admin-a",
      subjectId: "person-export",
      actingClientId: "management-ui",
      resourceId,
      capabilityId: "model.invoke",
      operation: "APPROVE",
      accessRequestId: "access-request-export",
      entitlementId: "entitlement-export",
      occurredAt: exportFrom + 1,
    }),
  })

  const response = await app.inject({
    method: "GET",
    url: exportUrl(tenantA),
    headers: { authorization: "Bearer admin-a" },
  })

  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json().records, [{
    policy_version: "one-policy@7",
    decision_correlation_id: "decision-policy",
    audit_event_id: "audit-policy-decision",
    correlation_id: "decision-policy",
    resource_id: resourceId,
    occurred_at: exportFrom,
  }])
  assert.equal(response.json().record_count, 1)
  await app.close()
})

test("audit export returns an empty artifact when no audited decision matches", async () => {
  const { app } = await createApp()
  const response = await app.inject({
    method: "GET",
    url: exportUrl(tenantA, "resource-without-audit"),
    headers: { authorization: "Bearer admin-a" },
  })

  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), {
    schema_version: "genioone.audit-export.v1",
    tenant_id: tenantA,
    from: exportFrom,
    to: exportTo,
    resource_id: "resource-without-audit",
    record_count: 0,
    records: [],
  })
  await app.close()
})

test("audit export requires a Tenant Administrator", async () => {
  const { app } = await createApp()
  const response = await app.inject({
    method: "GET",
    url: exportUrl(tenantA),
    headers: { authorization: "Bearer org-admin-a" },
  })

  assert.equal(response.statusCode, 403)
  assert.equal(response.json().code, "TENANT_ADMINISTRATOR_REQUIRED")

  const head = await app.inject({
    method: "HEAD",
    url: exportUrl(tenantA),
    headers: { authorization: "Bearer org-admin-a" },
  })
  assert.equal(head.statusCode, 403)
  await app.close()
})

test("audit export validates the time range and required resource", async () => {
  const { app } = await createApp()
  const invalidRange = await app.inject({
    method: "GET",
    url: `/v1/tenants/${tenantA}/audit-export?from=${exportTo + 1}&to=${exportTo}&resource_id=${resourceId}`,
    headers: { authorization: "Bearer admin-a" },
  })
  assert.equal(invalidRange.statusCode, 400)
  assert.equal(invalidRange.json().code, "AUDIT_EXPORT_TIME_RANGE_INVALID")

  const missingResource = await app.inject({
    method: "GET",
    url: `/v1/tenants/${tenantA}/audit-export?from=${exportFrom}&to=${exportTo}`,
    headers: { authorization: "Bearer admin-a" },
  })
  assert.equal(missingResource.statusCode, 400)
  assert.equal(missingResource.json().code, "REQUEST_VALIDATION_FAILED")
  await app.close()
})

test("audit export rejects an over-limit result instead of truncating it", async () => {
  const total = 10_001
  const auditEvents: GatewayAuthorizationAuditStore = {
    async record({ tenantId, event }) { return { ...event, tenant_id: tenantId } },
    async recordAuthenticationAttempt({ receipt }) { return receipt },
    async findById() { return null },
    async query(input) {
      const remaining = Math.max(0, total - input.offset)
      const count = Math.min(input.limit, remaining)
      const events = Array.from({ length: count }, (_, index) => auditEvent({
        id: `audit-${input.offset + index}`,
        correlationId: `decision-${input.offset + index}`,
        occurredAt: exportFrom + (input.offset + index),
      }))
      return {
        events: events.map((event) => ({ ...event, tenant_id: tenantA })),
        hasMore: input.offset + count < total,
        sourceRevision: total,
      }
    },
    async findRuntimeAuthorization() { return null },
    async findRuntimeReport() { return null },
  }
  const { app } = await createApp({ auditEvents })
  const response = await app.inject({
    method: "GET",
    url: exportUrl(tenantA),
    headers: { authorization: "Bearer admin-a" },
  })

  assert.equal(response.statusCode, 422, response.body)
  assert.equal(response.json().code, "AUDIT_EXPORT_LIMIT_EXCEEDED")
  assert.match(response.json().message, /10000/)
  await app.close()
})

test("audit export fails closed when the audited source revision changes between pages", async () => {
  let queryCount = 0
  const auditEvents: GatewayAuthorizationAuditStore = {
    async record({ tenantId, event }) { return { ...event, tenant_id: tenantId } },
    async recordAuthenticationAttempt({ receipt }) { return receipt },
    async findById() { return null },
    async query(_input) {
      queryCount += 1
      if (queryCount === 1) {
        return {
          events: [{ ...auditEvent({ id: "audit-changing", correlationId: "decision-changing", occurredAt: exportFrom }), tenant_id: tenantA }],
          hasMore: true,
          sourceRevision: 1,
        }
      }
      return { events: [], hasMore: false, sourceRevision: 2 }
    },
    async findRuntimeAuthorization() { return null },
    async findRuntimeReport() { return null },
  }
  const { app } = await createApp({ auditEvents })
  const response = await app.inject({
    method: "GET",
    url: exportUrl(tenantA),
    headers: { authorization: "Bearer admin-a" },
  })

  assert.equal(response.statusCode, 409, response.body)
  assert.equal(response.json().code, "AUDIT_EXPORT_SOURCE_CHANGED")
  assert.equal(queryCount, 2)
  await app.close()
})

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL

type AuditBackend = "memory" | "PostgreSQL"

async function withAuditStore(
  backend: AuditBackend,
  work: (store: GatewayAuthorizationAuditStore, sql?: SqlAdapter) => Promise<void>,
): Promise<void> {
  if (backend === "memory") {
    await work(createInMemoryGatewayAuthorizationAuditStore())
    return
  }
  assert.ok(databaseUrl)
  const schema = `audit_export_${randomUUID().replaceAll("-", "")}`
  const admin = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 1, onnotice: () => {} } })
  const sql = createPostgresSqlAdapter({
    url: databaseUrl,
    options: { max: 1, connection: { search_path: schema }, onnotice: () => {} },
  })
  try {
    await admin.query(`create schema ${schema}`)
    await runMigrations(sql, { advisoryLockKey: schema })
    await work(createPostgresGatewayAuthorizationAuditStore({ sql }), sql)
  } finally {
    await sql.end()
    await admin.query(`drop schema if exists ${schema} cascade`)
    await admin.end()
  }
}

async function exportDuringAppend(
  store: GatewayAuthorizationAuditStore,
  count: number,
  append: (app: Awaited<ReturnType<typeof createManagementApi>>) => Promise<void>,
) {
  for (let index = 0; index < count; index += 1) {
    await store.record({
      tenantId: tenantA,
      event: auditEvent({ id: `audit-page-${index}`, correlationId: `decision-page-${index}`, occurredAt: exportFrom + index }),
    })
  }
  let app: Awaited<ReturnType<typeof createManagementApi>> | undefined
  let appended = false
  let pageCount = 0
  const observedStore: GatewayAuthorizationAuditStore = {
    ...store,
    async query(input) {
      const page = await store.query(input)
      pageCount += 1
      if (!appended) {
        assert.equal(page.hasMore, count > input.limit)
        appended = true
        assert.ok(app)
        await append(app)
      }
      return page
    },
  }
  app = (await createApp({ auditEvents: observedStore })).app
  try {
    const response = await app.inject({
      method: "GET",
      url: exportUrl(tenantA),
      headers: { authorization: "Bearer admin-a" },
    })
    return { response, pageCount, appended }
  } finally {
    await app.close()
  }
}

for (const backend of ["memory", "PostgreSQL"] as const) {
  const options = {
    skip: backend === "PostgreSQL" && !databaseUrl ? "GENIO_ONE_TEST_DATABASE_URL is not set" : false,
    timeout: 60_000,
  }

  test(`${backend} audit source revision follows every query filter and preserves tenant-wide unfiltered counts`, options, async () => {
    await withAuditStore(backend, async (store) => {
      const matching = auditEvent({ id: "audit-revision-match", correlationId: "revision-target", occurredAt: exportFrom })
      await store.record({ tenantId: tenantA, event: matching })
      const input = {
        tenantId: tenantA,
        correlationId: matching.correlation_id,
        enforcementPointId: matching.enforcement_point_id,
        kind: matching.kind,
        outcome: matching.outcome,
        resourceId,
        subjectId: matching.subject.subject_id,
        from: exportFrom,
        to: exportTo,
        offset: 0,
        limit: 1,
      }
      const excluded: Parameters<GatewayAuthorizationAuditStore["record"]>[0][] = [
        { tenantId: tenantB, event: matching },
        { tenantId: tenantA, event: { ...matching, correlation_id: "revision-other" } },
        { tenantId: tenantA, event: { ...matching, enforcement_point_id: "API_GATEWAY" } },
        { tenantId: tenantA, event: autoGrantActivationAuditEvent({
          tenantId: tenantA,
          subjectId: matching.subject.subject_id,
          clientId: "management-ui",
          correlationId: matching.correlation_id,
          resourceId,
          capabilityId: "model.invoke",
          entitlementId: "entitlement-revision",
          disposition: "GRANTED",
          occurredAt: exportFrom,
        }) },
        { tenantId: tenantA, event: { ...matching, outcome: "DENY" } },
        { tenantId: tenantA, event: { ...matching, resource_id: "resource-other" } },
        { tenantId: tenantA, event: { ...matching, subject: { subject_id: "person-other", evidence_level: "VERIFIED" } } },
        { tenantId: tenantA, event: { ...matching, occurred_at: exportFrom - 1 } },
        { tenantId: tenantA, event: { ...matching, occurred_at: exportTo + 1 } },
      ]
      for (const [index, excludedEvent] of excluded.entries()) {
        await store.record({ ...excludedEvent, event: { ...excludedEvent.event, audit_event_id: `audit-revision-excluded-${index}` } })
        const page = await store.query(input)
        assert.equal(page.sourceRevision, 1)
        assert.deepEqual(page.events.map((event) => event.audit_event_id), [matching.audit_event_id])
      }
      const second = { ...matching, audit_event_id: "audit-revision-match-to", occurred_at: exportTo }
      await store.record({ tenantId: tenantA, event: second })
      await store.record({ tenantId: tenantA, event: second })
      for (const offset of [0, 1, 99]) {
        const page = await store.query({ ...input, offset })
        assert.equal(page.sourceRevision, 2)
        assert.equal(page.events.length, offset < 2 ? 1 : 0)
        assert.equal(page.hasMore, offset === 0)
      }
      const tenantPage = await store.query({ tenantId: tenantA, offset: 99, limit: 1 })
      assert.equal(tenantPage.sourceRevision, 10)
      assert.deepEqual(tenantPage.events, [])
      assert.equal(tenantPage.hasMore, false)
      const decisions = await store.query({ tenantId: tenantA, kind: "ONE_POLICY_DECISION", offset: 99, limit: 1 })
      assert.equal(decisions.sourceRevision, 9)
      assert.deepEqual(decisions.events, [])
      assert.equal((await store.query({ tenantId: "tenant-no-audit", offset: 0, limit: 1 })).sourceRevision, 0)
    })
  })

  test(`${backend} audit export tolerates management requests and foreign tenant/resource/time appends between pages`, options, async () => {
    await withAuditStore(backend, async (store) => {
      const { response, pageCount, appended } = await exportDuringAppend(store, 501, async (app) => {
        const management = await app.inject({
          method: "GET",
          url: `/v1/tenants/${tenantA}/organizations`,
          headers: { authorization: "Bearer admin-a" },
        })
        assert.equal(management.statusCode, 200, management.body)
        for (const input of [
          { tenantId: tenantB, event: auditEvent({ id: "audit-append-tenant", correlationId: "append-tenant", occurredAt: exportFrom }) },
          { tenantId: tenantA, event: auditEvent({ id: "audit-append-resource", correlationId: "append-resource", resourceId: "resource-other", occurredAt: exportFrom }) },
          { tenantId: tenantA, event: auditEvent({ id: "audit-append-before", correlationId: "append-before", occurredAt: exportFrom - 1 }) },
          { tenantId: tenantA, event: auditEvent({ id: "audit-append-after", correlationId: "append-after", occurredAt: exportTo + 1 }) },
        ]) await store.record(input)
      })
      assert.equal(appended, true)
      assert.equal(pageCount, 3)
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.json().record_count, 501)
      assert.deepEqual(new Set(response.json().records.map((record: { audit_event_id: string }) => record.audit_event_id)),
        new Set(Array.from({ length: 501 }, (_, index) => `audit-page-${index}`)))
      const management = await store.query({ tenantId: tenantA, kind: "MANAGEMENT_AUTHORIZATION", offset: 0, limit: 10 })
      assert.ok(management.events.some((event) => event.kind === "MANAGEMENT_AUTHORIZATION" && event.route.endsWith("/organizations")))
    })
  })

  for (const count of [501, 2]) {
    test(`${backend} audit export rejects a matching append before ${count > 500 ? "the next page" : "final verification"}`, options, async () => {
      await withAuditStore(backend, async (store) => {
        const { response, appended } = await exportDuringAppend(store, count, async () => {
          await store.record({
            tenantId: tenantA,
            event: auditEvent({ id: "audit-append-matching", correlationId: "append-matching", occurredAt: exportFrom + count }),
          })
        })
        assert.equal(appended, true)
        assert.equal(response.statusCode, 409, response.body)
        assert.equal(response.json().code, "AUDIT_EXPORT_SOURCE_CHANGED")
      })
    })
  }
}

test("PostgreSQL audit page and revision use the same statement snapshot when a matching append follows the page read", {
  skip: !databaseUrl ? "GENIO_ONE_TEST_DATABASE_URL is not set" : false,
  timeout: 60_000,
}, async () => {
  await withAuditStore("PostgreSQL", async (store, sql) => {
    assert.ok(sql)
    await store.record({
      tenantId: tenantA,
      event: auditEvent({ id: "audit-snapshot-initial", correlationId: "snapshot-initial", occurredAt: exportFrom }),
    })
    let appended = false
    const observedSql: SqlAdapter = {
      async query<Row extends Record<string, unknown>>(text: string, parameters?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
        const result = await sql.query<Row>(text, parameters)
        if (!appended && text.includes("order by") && text.includes("genio_one_gateway_authorization_audit_events")) {
          appended = true
          await store.record({
            tenantId: tenantA,
            event: auditEvent({ id: "audit-snapshot-appended", correlationId: "snapshot-appended", occurredAt: exportFrom + 1 }),
          })
        }
        return result
      },
      transaction: (work) => sql.transaction(work),
    }
    const observedStore = createPostgresGatewayAuthorizationAuditStore({ sql: observedSql })
    const input = { tenantId: tenantA, kind: "ONE_POLICY_DECISION", resourceId, from: exportFrom, to: exportTo, offset: 0, limit: 1 }
    const page = await observedStore.query(input)
    assert.equal(appended, true)
    assert.equal(page.sourceRevision, 1)
    assert.equal(page.hasMore, false)
    assert.deepEqual(page.events.map((event) => event.audit_event_id), ["audit-snapshot-initial"])
    assert.equal((await observedStore.query(input)).sourceRevision, 2)
  })
})
