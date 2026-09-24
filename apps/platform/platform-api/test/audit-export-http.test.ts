import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import type { GatewayAuthorizationAuditIngest } from "../src/capabilities/audit-events/contract"
import type { GatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/module"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
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
      scopes: ["genioone-management"],
    },
    "admin-b": {
      tenant_id: tenantB,
      subject_id: "person-admin-b",
      client_id: "management-ui",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: [],
      scopes: ["genioone-management"],
    },
    "org-admin-a": {
      tenant_id: tenantA,
      subject_id: "person-org-admin-a",
      client_id: "management-ui",
      role: "ORGANIZATION_ADMINISTRATOR",
      organization_ids: ["organization-a"],
      scopes: ["genioone-management"],
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
    async record() { throw new Error("NOT_USED") },
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
    async record() { throw new Error("NOT_USED") },
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
