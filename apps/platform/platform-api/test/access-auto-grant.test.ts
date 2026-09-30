import assert from "node:assert/strict"
import test from "node:test"

import { createInMemoryAccessGovernanceStore } from "../src/capabilities/access/memory"
import { createInMemoryGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/memory"
import { createInMemoryModelEntitlementCatalog } from "../src/capabilities/entitlements/memory"
import type { AccessAuditWriter } from "../src/capabilities/access/module"
import type { ResourceRegistration } from "../src/capabilities/resources/contract"

const tenantId = "tenant-acme"
const actor = {
  subjectId: "person-user",
  clientId: "self-service-ui",
  role: "USER" as const,
  organizationIds: [],
}

function resource(overrides: Partial<ResourceRegistration> = {}): ResourceRegistration {
  return {
    tenant_id: tenantId,
    resource_id: "resource-ai",
    display_name: "Enterprise Chat",
    kind: "MCP",
    owner_organization_id: "org-ai",
    authentication_strategy: "NONE",
    environment_id: "production",
    version: "1.0.0",
    lifecycle: "PUBLISHED",
    publication_endpoint: {
      gateway_id: "gateway-ai",
      hostname: "chat.example.test",
      base_path: "/mcp/chat",
      visibility: "PUBLIC",
      dns_management: "EXTERNAL",
      dns_verification: "VERIFIED",
    },
    operational_state: "HEALTHY",
    capabilities: [{ capability_id: "mcp.invoke", display_name: "Invoke" }],
    enforcement_point_id: "gateway-ai",
    created_at: 100,
    ...overrides,
  }
}

function fixture(input: {
  resource?: ResourceRegistration
  resources?: ResourceRegistration[]
  subject?: { subject_id: string; suspended: boolean }
  discoveryReady?: boolean
  now?: () => number
  audit?: AccessAuditWriter
} = {}) {
  const audit = createInMemoryGatewayAuthorizationAuditStore()
  const entitlements = createInMemoryModelEntitlementCatalog({
    now: input.now ?? (() => 100),
    idFactory: (sequence) => `entitlement-${sequence}`,
  })
  const selectedResources = input.resources ?? [input.resource ?? resource()]
  const subject = input.subject ?? { subject_id: actor.subjectId, suspended: false }
  const access = createInMemoryAccessGovernanceStore({
    resources: {
      async listResources() {
        return selectedResources
      },
      async getResource({ resourceId }: { resourceId: string }) {
        const found = selectedResources.find((candidate) => candidate.resource_id === resourceId)
        if (!found) throw new Error(`Resource not found: ${resourceId}`)
        return found
      },
    } as never,
    entitlements,
    configuration: { async published() { return null } } as never,
    identity: {
      async inventory() {
        return {
          tenant_id: tenantId,
          subjects: [{
            subject_id: subject.subject_id,
            kind: "PERSON" as const,
            profile: { display_name: "User", email: null, department: null },
            suspended: subject.suspended,
            suspended_at: null,
            suspended_by: null,
            suspension_reason: null,
          }],
          external_identity_bindings: [],
          tenant_administrators: [],
        }
      },
    },
    organizations: { async list() { return [] } },
    connections: {
      async list({ resourceId }) {
        const selected = selectedResources.find((candidate) => candidate.resource_id === resourceId)
        if (selected?.builtin_service !== "DISCOVERY" || input.discoveryReady === false) return []
        return [{
          connection_id: selected.resource_id,
          status: "READY",
          lifecycle: "ENABLED",
          verification_state: "VERIFIED",
          health_state: "HEALTHY",
        }] as never
      },
    },
    audit: input.audit ?? audit,
    now: input.now ?? (() => 100),
  })
  return { access, audit, entitlements }
}

function activation(
  correlationId = "activate-1",
  resourceId = "resource-ai",
  capabilityId = "mcp.invoke",
) {
  return {
    tenantId,
    actor,
    value: {
      correlation_id: correlationId,
      resource_id: resourceId,
      capability_id: capabilityId,
    },
  }
}

test("AUTO_GRANT activation creates one Subject entitlement and records a stable audit", async () => {
  let at = 100
  const { access, audit, entitlements } = fixture({ now: () => at })

  const first = await access.activateAutoGrant(activation())
  at = 101
  const retried = await access.activateAutoGrant(activation())

  assert.equal(first.entitlement_id, "entitlement-1")
  assert.equal(first.valid_until, null)
  assert.equal(retried.entitlement_id, first.entitlement_id)
  assert.equal((await entitlements.list({ tenantId })).length, 1)
  const events = await audit.query({ tenantId, correlationId: "activate-1", offset: 0, limit: 10 })
  assert.equal(events.events.length, 1)
  assert.equal(events.events[0]?.kind, "AUTO_GRANT_ACTIVATION")
  if (events.events[0]?.kind === "AUTO_GRANT_ACTIVATION") {
    assert.equal(events.events[0].activation, "GRANTED")
    assert.equal(events.events[0].entitlement_id, first.entitlement_id)
    assert.equal(events.events[0].subject.subject_id, actor.subjectId)
    assert.equal(events.events[0].occurred_at, 100)
  }
})

test("AUTO_GRANT activation serializes concurrent correlations for the same entitlement target", async () => {
  const { access, audit, entitlements } = fixture()

  const [first, second] = await Promise.all([
    access.activateAutoGrant(activation("activate-concurrent-1")),
    access.activateAutoGrant(activation("activate-concurrent-2")),
  ])

  assert.equal(first.entitlement_id, second.entitlement_id)
  assert.equal((await entitlements.list({ tenantId })).filter((value) => value.state === "ACTIVE").length, 1)
  const records = await Promise.all([
    audit.query({ tenantId, correlationId: "activate-concurrent-1", offset: 0, limit: 10 }),
    audit.query({ tenantId, correlationId: "activate-concurrent-2", offset: 0, limit: 10 }),
  ])
  assert.deepEqual(records.map(({ events }) => events.length), [1, 1])
})

test("AUTO_GRANT activation rejects a changed target for a reused correlation without adding an entitlement or audit", async () => {
  const alternate = resource({
    resource_id: "resource-analytics",
    capabilities: [{ capability_id: "mcp.inspect", display_name: "Inspect" }],
  })
  const { access, audit, entitlements } = fixture({ resources: [resource(), alternate] })

  const created = await access.activateAutoGrant(activation("activate-correlation"))
  await assert.rejects(
    access.activateAutoGrant(activation("activate-correlation", alternate.resource_id, "mcp.inspect")),
    (error: unknown) => (error as { code?: string }).code === "AUTO_GRANT_CORRELATION_REUSED",
  )

  const values = await entitlements.list({ tenantId })
  assert.equal(values.length, 1)
  assert.equal(values[0]?.entitlement_id, created.entitlement_id)
  const events = await audit.query({ tenantId, correlationId: "activate-correlation", offset: 0, limit: 10 })
  assert.equal(events.events.length, 1)
  const event = events.events[0]
  assert.equal(event?.kind, "AUTO_GRANT_ACTIVATION")
  if (event?.kind === "AUTO_GRANT_ACTIVATION") {
    assert.equal(event.resource_id, "resource-ai")
    assert.equal(event.capability_id, "mcp.invoke")
  }
})

test("AUTO_GRANT activation revokes a created entitlement when audit recording fails before a retry", async () => {
  let auditAvailable = false
  const events: Array<{ entitlement_id: string }> = []
  const audit: AccessAuditWriter = {
    async findById() {
      return null
    },
    async record({ event }) {
      if (!auditAvailable) throw new Error("audit unavailable")
      events.push(event)
    },
  }
  const { access, entitlements } = fixture({ audit })

  await assert.rejects(access.activateAutoGrant(activation("activate-audit-failure")), /audit unavailable/)
  const failed = await entitlements.list({ tenantId })
  assert.equal(failed.length, 1)
  assert.equal(failed[0]?.state, "REVOKED")

  auditAvailable = true
  const retried = await access.activateAutoGrant(activation("activate-audit-failure"))
  assert.equal(retried.entitlement_id, "entitlement-2")
  assert.equal(retried.state, "ACTIVE")
  assert.deepEqual(events.map(({ entitlement_id }) => ({ entitlement_id })), [{ entitlement_id: retried.entitlement_id }])
})

test("AUTO_GRANT activation returns an effective existing entitlement after eligibility validation", async () => {
  let at = 100
  const { access, audit, entitlements } = fixture({ now: () => at })
  const existing = await entitlements.grant({
    tenantId,
    value: {
      subject_id: actor.subjectId,
      resource_id: "resource-ai",
      capability_id: "mcp.invoke",
    },
    idempotencyKey: "admin-grant",
  })

  const result = await access.activateAutoGrant(activation("activate-existing"))
  at = 101
  const retried = await access.activateAutoGrant(activation("activate-existing"))

  assert.equal(result.entitlement_id, existing.entitlement_id)
  assert.equal(retried.entitlement_id, existing.entitlement_id)
  assert.equal((await entitlements.list({ tenantId })).length, 1)
  const events = await audit.query({ tenantId, correlationId: "activate-existing", offset: 0, limit: 10 })
  assert.equal(events.events[0]?.kind, "AUTO_GRANT_ACTIVATION")
  if (events.events[0]?.kind === "AUTO_GRANT_ACTIVATION") {
    assert.equal(events.events[0].activation, "ALREADY_ENTITLED")
    assert.equal(events.events[0].occurred_at, 100)
  }
})

test("builtin Discovery is connected without creating a self-service entitlement", async () => {
  const { access } = fixture({
    resource: resource({
      builtin_service: "DISCOVERY",
      publication_endpoint: null,
    }),
  })

  const catalog = await access.catalog({ tenantId, actor })

  assert.deepEqual(catalog.capabilities, [{
    resource_id: "resource-ai",
    resource_display_name: "Enterprise Chat",
    capability_id: "mcp.invoke",
    capability_display_name: "Invoke",
    resource_owner_id: "org-ai",
    resource_owner_display_name: "org-ai",
    connection_status: "READY",
    access: "AUTO_GRANT",
    hub_status: "CONNECTED",
    restriction_reason: null,
    builtin_service: "DISCOVERY",
  }])
})

test("AUTO_GRANT activation rejects a published builtin Discovery before creating an entitlement", async () => {
  const { access, audit, entitlements } = fixture({
    resource: resource({ builtin_service: "DISCOVERY" }),
  })

  await assert.rejects(
    access.activateAutoGrant(activation()),
    (error: unknown) => (error as { code?: string }).code === "AUTO_GRANT_NOT_AVAILABLE",
  )

  assert.equal((await entitlements.list({ tenantId })).length, 0)
  assert.equal((await audit.query({ tenantId, correlationId: "activate-1", offset: 0, limit: 10 })).events.length, 0)
})

test("builtin Discovery is absent when its Connection is disabled or unhealthy", async () => {
  const { access } = fixture({
    resource: resource({
      builtin_service: "DISCOVERY",
      publication_endpoint: null,
    }),
    discoveryReady: false,
  })

  const catalog = await access.catalog({ tenantId, actor })

  assert.deepEqual(catalog.capabilities, [])
})

test("AUTO_GRANT activation rejects ineligible resources and unverified actors", async () => {
  for (const selectedResource of [
    resource({ publication_endpoint: { ...resource().publication_endpoint!, visibility: "REQUEST" } }),
    resource({ kind: "EXTENSION" }),
  ]) {
    await assert.rejects(
      fixture({ resource: selectedResource }).access.activateAutoGrant(activation()),
      (error: unknown) => (error as { code?: string }).code === "AUTO_GRANT_NOT_AVAILABLE",
    )
  }
  await assert.rejects(
    fixture({ subject: { subject_id: "person-other", suspended: false } }).access.activateAutoGrant(activation()),
    (error: unknown) => (error as { code?: string }).code === "AUTO_GRANT_ACTOR_NOT_VERIFIED",
  )
  await assert.rejects(
    fixture({ subject: { subject_id: actor.subjectId, suspended: true } }).access.activateAutoGrant(activation()),
    (error: unknown) => (error as { code?: string }).code === "AUTO_GRANT_ACTOR_NOT_VERIFIED",
  )
})
