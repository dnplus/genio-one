import assert from "node:assert/strict"
import test from "node:test"

import {
  autoGrantActivationAuditEvent,
  autoGrantActivationRequestDigest,
  type AccessGovernanceAuditEvent,
  type AccessGovernanceAuditWriter,
} from "../src/capabilities/access/audit"
import type { AutoGrantActivationAuditEvent } from "../src/capabilities/access/contract"
import { createPostgresAccessGovernanceStore } from "../src/capabilities/access/postgres"
import { createInMemoryGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/memory"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

type Row = Record<string, unknown>

class FakeSql implements SqlAdapter, SqlTransaction {
  readonly calls: string[] = []
  readonly parameters: unknown[][] = []

  constructor(private readonly rows: (text: string) => Row[]) {}

  async query<Result extends Row = Row>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push(text)
    this.parameters.push([...parameters])
    const rows = this.rows(text) as Result[]
    return { rows, rowCount: rows.length }
  }

  async transaction<Result>(work: (transaction: SqlTransaction) => Promise<Result>): Promise<Result> {
    return work(this)
  }
}

const audit: AccessGovernanceAuditWriter = {
  async record() {},
  async recordInTransaction() {},
}

test("Organization Administrator requests same-owner private API access for an Application subject", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_subjects subject")) {
      return [{ kind: "APPLICATION", owner_organization_id: "org-ai" }]
    }
    if (text.includes("from genio_one_tenant_configuration_revisions")) {
      return [{
        revision: "configuration-1",
        settings: {
          request_form: { enabled: true },
          ttl_options_seconds: [28_800],
          approval_workflow_version: "owner-review-v1",
        },
      }]
    }
    if (text.includes("from genio_one_resources resource")) {
      return [{ owner_organization_id: "org-ai" }]
    }
    if (text.includes("insert into genio_one_access_requests")) {
      return [{
        ...pendingRequest,
        requester_subject_id: "person-org-admin",
        target_subject_id: "application-subject-1",
        acting_client_id: "management-ui",
        resource_id: "resource-api",
        capability_id: "incident.list",
        owner_organization_id: "org-ai",
        requested_valid_for: 28_800,
        configuration_revision: "configuration-1",
        approval_workflow_version: "owner-review-v1",
        request_correlation_id: "request-application-correlation",
        decision_correlation_id: null,
      }]
    }
    return []
  })
  const store = createPostgresAccessGovernanceStore({
    sql,
    audit,
    idFactory: () => "request-application-1",
  })

  const result = await store.request({
    tenantId: "tenant-acme",
    actor: {
      subjectId: "person-org-admin",
      clientId: "management-ui",
      role: "ORGANIZATION_ADMINISTRATOR",
      organizationIds: ["org-ai"],
      administratorOrganizationIds: ["org-ai"],
    },
    value: {
      correlation_id: "request-application-correlation",
      target_subject_id: "application-subject-1",
      resource_id: "resource-api",
      capability_id: "incident.list",
      justification: "Operations automation requires incident access",
      requested_valid_for_seconds: 28_800,
    },
  })

  assert.ok("CREATED" in result)
  if (!("CREATED" in result)) return
  assert.equal(result.CREATED.requester, "person-org-admin")
  assert.equal(result.CREATED.target_subject, "application-subject-1")
  assert.equal(result.CREATED.request_correlation_id, "request-application-correlation")
  assert.ok(sql.parameters.some((parameters) => parameters.includes("application-subject-1")))
  const requestInsertIndex = sql.calls.findIndex((text) => text.includes("insert into genio_one_access_requests"))
  assert.ok(requestInsertIndex >= 0)
  assert.match(sql.calls[requestInsertIndex]!, /request_correlation_id/)
  assert.equal(sql.parameters[requestInsertIndex]?.at(-1), "request-application-correlation")
})

const pendingRequest: Row = {
  tenant_id: "tenant-acme",
  access_request_id: "request-1",
  requester_subject_id: "person-user",
  target_subject_id: "person-user",
  acting_client_id: "app-user",
  resource_id: "resource-ai",
  capability_id: "model.invoke",
  owner_organization_id: "org-ai",
  justification: "Need access",
  requested_valid_for: 100,
  configuration_revision: "config-1",
  approval_workflow_version: "workflow-1",
  state: "PENDING",
  created_at: 10,
  expires_at: null,
  resolved_at: null,
  resolution_reason: null,
  decided_by_subject_id: null,
  entitlement_id: null,
}

test("Access readback exposes request and decision correlations", async () => {
  const sql = new FakeSql(() => [{
    ...pendingRequest,
    request_correlation_id: "request-correlation",
    decision_correlation_id: "decision-correlation",
  }])
  const store = createPostgresAccessGovernanceStore({ sql, audit })

  const [request] = await store.listMine({
    tenantId: "tenant-acme",
    actor: { subjectId: "person-user", clientId: "self-service-ui", role: "USER", organizationIds: [] },
  })
  assert.equal(request?.request_correlation_id, "request-correlation")
  assert.equal(request?.decision_correlation_id, "decision-correlation")
})

test("self-service catalog reads the canonical Resource-owned Connection table", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_subjects")) {
      return [{ display_name: "Ada Lovelace" }]
    }
    assert.match(text, /from genio_one_resource_connections connection/)
    assert.match(text, /connection\.status = 'READY'/)
    assert.match(text, /connection\.lifecycle = 'ENABLED'/)
    assert.match(text, /connection\.verification_state = 'VERIFIED'/)
    assert.match(text, /connection\.health_state = 'HEALTHY'/)
    assert.doesNotMatch(text, /genio_one_connections/)
    assert.match(text, /join genio_one_organizations owner/)
    return [{
      resource_id: "resource-ai",
      resource_display_name: "Enterprise Chat",
      capability_id: "model.invoke",
      capability_display_name: "Chat with approved models",
      owner_organization_id: "org-ai",
      resource_owner_display_name: "AI Platform",
      connection_status: "READY",
      resource_kind: "MCP",
      visibility: "REQUEST",
      hostname: "enterprise-chat.example.test",
      base_path: "/mcp/enterprise-chat",
      entitlement_id: null,
      access_request_id: null,
      row_revision: 1,
    }]
  })
  const store = createPostgresAccessGovernanceStore({ sql, audit })

  const catalog = await store.catalog({
    tenantId: "tenant-acme",
    actor: {
      subjectId: "person-user",
      clientId: "self-service-ui",
      role: "USER",
      organizationIds: ["org-ai"],
    },
  })
  assert.equal(catalog.tenant_id, "tenant-acme")
  assert.equal(catalog.subject_id, "person-user")
  assert.equal(catalog.subject_display_name, "Ada Lovelace")
  assert.deepEqual(catalog.capabilities, [{
    resource_id: "resource-ai",
    resource_display_name: "Enterprise Chat",
    capability_id: "model.invoke",
    capability_display_name: "Chat with approved models",
    resource_owner_id: "org-ai",
    resource_owner_display_name: "AI Platform",
    connection_status: "READY",
    access: "REQUEST",
    hub_status: "REQUEST_ACCESS",
    restriction_reason: null,
  }])
})

test("a published Extension without a Connection is requestable in Self-service", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_subjects")) return [{ display_name: "Anrita" }]
    assert.match(text, /resource\.kind = 'EXTENSION'/)
    return [{
      resource_id: "resource-access-lifecycle",
      resource_display_name: "UAT Requestable Access",
      resource_kind: "EXTENSION",
      extension_metadata: null,
      capability_id: "access.request",
      capability_display_name: "UAT Access Request",
      owner_organization_id: "org-uat-access",
      resource_owner_display_name: "UAT Access",
      connection_status: "UNAVAILABLE",
      visibility: null,
      hostname: null,
      base_path: null,
      entitlement_id: null,
      access_request_id: null,
      row_revision: 1,
    }]
  })
  const store = createPostgresAccessGovernanceStore({ sql, audit })

  const catalog = await store.catalog({
    tenantId: "tenant-acme",
    actor: {
      subjectId: "person-anrita",
      clientId: "self-service-ui",
      role: "USER",
      organizationIds: [],
    },
  })

  assert.deepEqual(catalog.capabilities, [{
    resource_id: "resource-access-lifecycle",
    resource_display_name: "UAT Requestable Access",
    capability_id: "access.request",
    capability_display_name: "UAT Access Request",
    resource_owner_id: "org-uat-access",
    resource_owner_display_name: "UAT Access",
    connection_status: "UNAVAILABLE",
    access: "REQUEST",
    hub_status: "REQUEST_ACCESS",
    restriction_reason: null,
    resource_kind: "EXTENSION",
    extension_metadata: null,
  }])
})

test("builtin Discovery is connected in the catalog without a publication or entitlement", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_subjects")) return [{ display_name: "Ada Lovelace" }]
    assert.match(text, /resource\.builtin_service = 'DISCOVERY'/)
    assert.match(text, /case when resource\.builtin_service = 'DISCOVERY'/)
    assert.match(text, /connection\.connection_id = resource\.resource_id/)
    assert.match(text, /connection\.status = 'READY'/)
    assert.match(text, /connection\.lifecycle = 'ENABLED'/)
    assert.match(text, /connection\.verification_state = 'VERIFIED'/)
    assert.match(text, /connection\.health_state = 'HEALTHY'/)
    return [{
      resource_id: "genio.discovery",
      resource_display_name: "GenioOne Discovery",
      resource_kind: "MCP",
      builtin_service: "DISCOVERY",
      capability_id: "catalog.search",
      capability_display_name: "Search catalog",
      owner_organization_id: "org-ai",
      resource_owner_display_name: "AI Platform",
      connection_status: "READY",
      visibility: null,
      hostname: null,
      base_path: null,
      entitlement_id: null,
      access_request_id: null,
      row_revision: 1,
    }]
  })
  const store = createPostgresAccessGovernanceStore({ sql })

  const catalog = await store.catalog({
    tenantId: "tenant-acme",
    actor: {
      subjectId: "person-user",
      clientId: "self-service-ui",
      role: "USER",
      organizationIds: [],
    },
  })

  assert.deepEqual(catalog.capabilities, [{
    resource_id: "genio.discovery",
    resource_display_name: "GenioOne Discovery",
    capability_id: "catalog.search",
    capability_display_name: "Search catalog",
    resource_owner_id: "org-ai",
    resource_owner_display_name: "AI Platform",
    connection_status: "READY",
    access: "AUTO_GRANT",
    hub_status: "CONNECTED",
    restriction_reason: null,
    builtin_service: "DISCOVERY",
  }])
})

test("builtin Discovery is excluded from the catalog without a ready enabled verified healthy Connection", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_subjects")) return [{ display_name: "Ada Lovelace" }]
    assert.match(text, /resource\.builtin_service = 'DISCOVERY' and discovery_connection\.ready is not null/)
    assert.match(text, /connection\.connection_id = resource\.resource_id/)
    assert.match(text, /connection\.status = 'READY'/)
    assert.match(text, /connection\.lifecycle = 'ENABLED'/)
    assert.match(text, /connection\.verification_state = 'VERIFIED'/)
    assert.match(text, /connection\.health_state = 'HEALTHY'/)
    return []
  })
  const store = createPostgresAccessGovernanceStore({ sql })

  const catalog = await store.catalog({
    tenantId: "tenant-acme",
    actor: {
      subjectId: "person-user",
      clientId: "self-service-ui",
      role: "USER",
      organizationIds: [],
    },
  })

  assert.deepEqual(catalog.capabilities, [])
})

test("an active entitlement makes a private published MCP capability discoverable", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_subjects")) {
      return [{ display_name: "Ada Lovelace" }]
    }
    if (text.includes("from genio_one_resources resource")) {
      assert.match(text, /publication\.visibility in \('PUBLIC', 'REQUEST'\)/)
      assert.match(text, /publication\.visibility,\s+publication\.hostname,\s+publication\.base_path,\s+entitlement\.entitlement_id/)
      assert.match(text, /entitlement\.entitlement_id is not null/)
      return [{
        resource_id: "resource-servicenow",
        resource_display_name: "ServiceNow CSM Pilot",
        resource_kind: "MCP",
        capability_id: "mcp-tool-read-case",
        capability_display_name: "read_case",
        owner_organization_id: "org-ai",
        resource_owner_display_name: "AI Platform",
        connection_status: "READY",
        visibility: "PRIVATE",
        hostname: "servicenow.example.test",
        base_path: "/mcp/servicenow",
        entitlement_id: "entitlement-servicenow",
        access_request_id: null,
        row_revision: 3,
      }]
    }
    return []
  })
  const store = createPostgresAccessGovernanceStore({ sql, audit })

  const catalog = await store.catalog({
    tenantId: "tenant-acme",
    actor: {
      subjectId: "person-user",
      clientId: "self-service-ui",
      role: "USER",
      organizationIds: [],
    },
  })

  assert.deepEqual(catalog.capabilities, [{
    resource_id: "resource-servicenow",
    resource_display_name: "ServiceNow CSM Pilot",
    capability_id: "mcp-tool-read-case",
    capability_display_name: "read_case",
    resource_owner_id: "org-ai",
    resource_owner_display_name: "AI Platform",
    connection_status: "READY",
    access: "ENTITLED",
    hub_status: "CONNECTED",
    restriction_reason: null,
    publication_endpoint: {
      hostname: "servicenow.example.test",
      base_path: "/mcp/servicenow",
    },
  }])
})

test("access requests read the active Self-service configuration projection", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_tenant_configuration_revisions")) {
      assert.match(text, /genio_one_self_service_configuration_projections/)
      assert.match(text, /projection\.tenant_id = \$1/)
    }
    return []
  })
  const store = createPostgresAccessGovernanceStore({ sql, audit })

  await assert.rejects(
    store.request({
      tenantId: "tenant-acme",
      actor: {
        subjectId: "person-user",
        clientId: "self-service-ui",
        role: "USER",
        organizationIds: ["org-ai"],
      },
      value: {
        correlation_id: "correlation-request",
        resource_id: "resource-ai",
        capability_id: "model.invoke",
        justification: "Need access",
        requested_valid_for_seconds: 28_800,
      },
    }),
    /ACCESS_REQUEST_CONFIGURATION_REQUIRED/,
  )
})

test("access approval publishes the entitlement snapshot for the active Gateway", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_access_requests") && text.includes("for update")) {
      return [pendingRequest]
    }
    if (text.includes("insert into genio_one_model_entitlements")) {
      return [{
        entitlement_id: "entitlement-1",
        subject_id: "person-user",
        resource_id: "resource-ai",
        capability_id: "model.invoke",
        state: "ACTIVE",
        valid_from: 100,
        valid_until: 200,
      }]
    }
    if (text.includes("select gateway_id from genio_one_publications")) {
      return [{ gateway_id: "gateway-ai" }]
    }
    if (text.includes("from genio_one_access_requests")) {
      return [{
        ...pendingRequest,
        state: "APPROVED",
        expires_at: 200,
        resolved_at: 100,
        decided_by_subject_id: "person-admin",
        entitlement_id: "entitlement-1",
      }]
    }
    return []
  })
  const publications: Array<{ tenantId: string; gatewayId: string; issuedAt: number }> = []
  const store = createPostgresAccessGovernanceStore({
    sql,
    audit,
    now: () => 100,
    idFactory: () => "entitlement-1",
    releasePublisher: {
      async reconcileInTransaction({ tenantId, gatewayId, issuedAt }) {
        publications.push({ tenantId, gatewayId, issuedAt })
      },
    },
  })

  const result = await store.decide({
    tenantId: "tenant-acme",
    actor: {
      subjectId: "person-admin",
      clientId: "management-ui",
      role: "TENANT_ADMINISTRATOR",
      organizationIds: [],
    },
    requestId: "request-1",
    value: {
      correlation_id: "correlation-1",
      decision: { APPROVE: { valid_until: 200 } },
    },
  })

  assert.equal(result.request.state, "APPROVED")
  assert.equal(result.entitlement?.entitlement_id, "entitlement-1")
  assert.deepEqual(publications, [{
    tenantId: "tenant-acme",
    gatewayId: "gateway-ai",
    issuedAt: 100,
  }])
  const decisionUpdateIndex = sql.calls.findIndex((text) =>
    text.includes("update genio_one_access_requests") && text.includes("state = 'APPROVED'"),
  )
  assert.ok(decisionUpdateIndex >= 0)
  assert.match(sql.calls[decisionUpdateIndex]!, /decision_correlation_id = \$7/)
  assert.equal(sql.parameters[decisionUpdateIndex]?.at(-1), "correlation-1")
})

test("access denial persists the decision correlation", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_access_requests") && text.includes("for update")) {
      return [pendingRequest]
    }
    if (text.includes("from genio_one_access_requests")) {
      return [{
        ...pendingRequest,
        state: "DENIED",
        resolved_at: 100,
        resolution_reason: "Owner declined",
        decided_by_subject_id: "person-admin",
        decision_correlation_id: "decision-deny-correlation",
      }]
    }
    return []
  })
  const store = createPostgresAccessGovernanceStore({ sql, audit, now: () => 100 })

  const result = await store.decide({
    tenantId: "tenant-acme",
    actor: {
      subjectId: "person-admin",
      clientId: "management-ui",
      role: "TENANT_ADMINISTRATOR",
      organizationIds: [],
    },
    requestId: "request-1",
    value: {
      correlation_id: "decision-deny-correlation",
      decision: { DENY: { reason: "Owner declined" } },
    },
  })

  assert.equal(result.request.state, "DENIED")
  const decisionUpdateIndex = sql.calls.findIndex((text) =>
    text.includes("update genio_one_access_requests") && text.includes("state = 'DENIED'"),
  )
  assert.ok(decisionUpdateIndex >= 0)
  assert.match(sql.calls[decisionUpdateIndex]!, /decision_correlation_id = \$6/)
  assert.equal(sql.parameters[decisionUpdateIndex]?.at(-1), "decision-deny-correlation")
})

test("access cancellation persists its correlation and audit event", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("update genio_one_access_requests")) {
      return [{
        ...pendingRequest,
        state: "CANCELLED",
        resolved_at: 100,
        resolution_reason: "No longer needed",
        decided_by_subject_id: "person-user",
        decision_correlation_id: "cancel-correlation",
      }]
    }
    return []
  })
  const events: AccessGovernanceAuditEvent[] = []
  const store = createPostgresAccessGovernanceStore({
    sql,
    audit: { async record() {}, async recordInTransaction({ event }: { event: AccessGovernanceAuditEvent }) { events.push(event) } },
    now: () => 100,
  })

  const result = await store.cancel({
    tenantId: "tenant-acme",
    actor: { subjectId: "person-user", clientId: "self-service-ui", role: "USER", organizationIds: [] },
    requestId: "request-1",
    value: { correlation_id: "cancel-correlation", reason: "No longer needed" },
  })

  assert.equal(result.state, "CANCELLED")
  assert.equal(result.decision_correlation_id, "cancel-correlation")
  const cancellationUpdateIndex = sql.calls.findIndex((text) =>
    text.includes("update genio_one_access_requests") && text.includes("state = 'CANCELLED'"),
  )
  assert.ok(cancellationUpdateIndex >= 0)
  assert.match(sql.calls[cancellationUpdateIndex]!, /decision_correlation_id = \$6/)
  assert.equal(sql.parameters[cancellationUpdateIndex]?.at(-1), "cancel-correlation")
  assert.equal(events.at(-1)?.operation, "CANCEL")
  assert.equal(events.at(-1)?.correlation_id, "cancel-correlation")
})

test("AUTO_GRANT activation verifies the Subject and published public capability before reconciling and auditing", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_subjects")) {
      assert.match(text, /suspended_at is null/)
      assert.match(text, /for update/)
      return [{ subject_id: "person-user" }]
    }
    if (text.includes("from genio_one_resources resource")) {
      assert.match(text, /resource\.lifecycle = 'PUBLISHED'/)
      assert.match(text, /resource\.kind <> 'EXTENSION'/)
      assert.match(text, /resource\.builtin_service is distinct from 'DISCOVERY'/)
      assert.match(
        text,
        /where publication\.tenant_id = resource\.tenant_id\s+and publication\.resource_id = resource\.resource_id\s+and publication\.publication_state = 'PUBLISHED'\s+and publication\.visibility = 'PUBLIC'\s+order by endpoint_revision desc\s+limit 1/,
      )
      assert.match(text, /jsonb_build_object\('capability_id', \$3::text\)/)
      return [{ gateway_id: "gateway-ai" }]
    }
    if (text.includes("insert into genio_one_model_entitlements")) {
      assert.match(text, /grant_idempotency_key, grant_request_digest/)
      return [{
        entitlement_id: "entitlement-auto-grant-1",
        subject_id: "person-user",
        resource_id: "resource-ai",
        capability_id: "mcp.invoke",
        state: "ACTIVE",
        valid_from: 100,
        valid_until: null,
        revocation_reason: null,
      }]
    }
    if (text.includes("grant_idempotency_key")) return []
    if (text.includes("state = 'ACTIVE'")) {
      assert.match(text, /starts_at <= to_timestamp\(\$5\)/)
      assert.match(text, /expires_at is null or expires_at > to_timestamp\(\$5\)/)
      return []
    }
    return []
  })
  const reconciliations: Array<{ tenantId: string; gatewayId: string; issuedAt: number }> = []
  const audits: Array<Record<string, unknown>> = []
  const store = createPostgresAccessGovernanceStore({
    sql,
    now: () => 100,
    idFactory: () => "entitlement-auto-grant-1",
    releasePublisher: {
      async reconcileInTransaction({ tenantId, gatewayId, issuedAt }) {
        reconciliations.push({ tenantId, gatewayId, issuedAt })
      },
    },
    audit: {
      async record() {},
      async findById() { return null },
      async recordInTransaction({ event }: { event: AutoGrantActivationAuditEvent }) {
        audits.push(event)
      },
    },
  })

  const result = await store.activateAutoGrant({
    tenantId: "tenant-acme",
    actor: {
      subjectId: "person-user",
      clientId: "self-service-ui",
      role: "USER",
      organizationIds: [],
    },
    value: {
      correlation_id: "activate-1",
      resource_id: "resource-ai",
      capability_id: "mcp.invoke",
    },
  })

  assert.equal(result.entitlement_id, "entitlement-auto-grant-1")
  assert.equal(result.valid_until, null)
  assert.deepEqual(reconciliations, [{ tenantId: "tenant-acme", gatewayId: "gateway-ai", issuedAt: 100 }])
  assert.equal(audits[0]?.kind, "AUTO_GRANT_ACTIVATION")
  assert.equal(audits[0]?.correlation_id, "activate-1")
  assert.equal(audits[0]?.entitlement_id, "entitlement-auto-grant-1")
})

test("AUTO_GRANT activation rejects a published builtin Discovery before creating an entitlement", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_subjects")) return [{ subject_id: "person-user" }]
    if (text.includes("from genio_one_resources resource")) {
      assert.match(text, /resource\.builtin_service is distinct from 'DISCOVERY'/)
      return []
    }
    return []
  })
  const reconciliations: Array<{ tenantId: string }> = []
  const audits: Array<Record<string, unknown>> = []
  const store = createPostgresAccessGovernanceStore({
    sql,
    releasePublisher: {
      async reconcileInTransaction({ tenantId }) {
        reconciliations.push({ tenantId })
      },
    },
    audit: {
      async record() {},
      async findById() { return null },
      async recordInTransaction({ event }: { event: AutoGrantActivationAuditEvent }) {
        audits.push(event)
      },
    },
  })

  await assert.rejects(
    store.activateAutoGrant({
      tenantId: "tenant-acme",
      actor: { subjectId: "person-user", clientId: "self-service-ui", role: "USER", organizationIds: [] },
      value: { correlation_id: "activate-discovery", resource_id: "genio-one-discovery", capability_id: "catalog.search" },
    }),
    (error: unknown) => (error as { code?: string }).code === "AUTO_GRANT_NOT_AVAILABLE",
  )

  assert.equal(sql.calls.some((text) => text.includes("insert into genio_one_model_entitlements")), false)
  assert.deepEqual(reconciliations, [])
  assert.deepEqual(audits, [])
})

test("AUTO_GRANT activation replay returns its original effective entitlement without reconciling again", async () => {
  const requestDigest = autoGrantActivationRequestDigest({
    tenantId: "tenant-acme",
    subjectId: "person-user",
    clientId: "self-service-ui",
    resourceId: "resource-ai",
    capabilityId: "mcp.invoke",
  })
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_subjects")) return [{ subject_id: "person-user" }]
    if (text.includes("from genio_one_resources resource")) return [{ gateway_id: "gateway-ai" }]
    if (text.includes("grant_idempotency_key")) {
      return [{
        entitlement_id: "entitlement-auto-grant-1",
        subject_id: "person-user",
        resource_id: "resource-ai",
        capability_id: "mcp.invoke",
        state: "ACTIVE",
        valid_from: 100,
        valid_until: null,
        revocation_reason: null,
        grant_request_digest: requestDigest,
      }]
    }
    return []
  })
  let reconciled = false
  const audits: Array<Record<string, unknown>> = []
  const store = createPostgresAccessGovernanceStore({
    sql,
    now: () => 100,
    releasePublisher: {
      async reconcileInTransaction() {
        reconciled = true
      },
    },
    audit: {
      async record() {},
      async findById() { return null },
      async recordInTransaction({ event }: { event: AutoGrantActivationAuditEvent }) {
        audits.push(event)
      },
    },
  })

  const result = await store.activateAutoGrant({
    tenantId: "tenant-acme",
    actor: {
      subjectId: "person-user",
      clientId: "self-service-ui",
      role: "USER",
      organizationIds: [],
    },
    value: {
      correlation_id: "activate-1",
      resource_id: "resource-ai",
      capability_id: "mcp.invoke",
    },
  })

  assert.equal(result.entitlement_id, "entitlement-auto-grant-1")
  assert.equal(reconciled, false)
  assert.equal(sql.calls.some((text) => text.includes("insert into genio_one_model_entitlements")), false)
  assert.equal(audits[0]?.activation, "GRANTED")
})

test("AUTO_GRANT activation replays preserve the original audit across clock ticks", async () => {
  for (const disposition of ["GRANTED", "ALREADY_ENTITLED"] as const) {
    const audit = createInMemoryGatewayAuthorizationAuditStore()
    const event = autoGrantActivationAuditEvent({
      tenantId: "tenant-acme",
      subjectId: "person-user",
      clientId: "self-service-ui",
      correlationId: "activate-1",
      resourceId: "resource-ai",
      capabilityId: "mcp.invoke",
      entitlementId: "entitlement-auto-grant-1",
      disposition,
      occurredAt: 100,
    })
    await audit.record({ tenantId: "tenant-acme", event })
    const entitlement = {
      entitlement_id: event.entitlement_id,
      subject_id: event.subject.subject_id,
      resource_id: event.resource_id,
      capability_id: event.capability_id,
      state: "ACTIVE",
      valid_from: 100,
      valid_until: null,
      revocation_reason: null,
    }
    const sql = new FakeSql((text) => {
      if (text.includes("from genio_one_subjects")) return [{ subject_id: "person-user" }]
      if (text.includes("from genio_one_resources resource")) return [{ gateway_id: "gateway-ai" }]
      if (text.includes("grant_idempotency_key")) return disposition === "GRANTED"
        ? [{ ...entitlement, grant_request_digest: autoGrantActivationRequestDigest({
          tenantId: "tenant-acme",
          subjectId: "person-user",
          clientId: "self-service-ui",
          resourceId: "resource-ai",
          capabilityId: "mcp.invoke",
        }) }]
        : []
      if (text.includes("from genio_one_model_entitlements")) return disposition === "ALREADY_ENTITLED" ? [entitlement] : []
      return []
    })
    const store = createPostgresAccessGovernanceStore({
      sql,
      now: () => 101,
      audit: {
        record: audit.record,
        findById: audit.findById,
        async recordInTransaction({ tenantId, event }: { tenantId: string; event: AutoGrantActivationAuditEvent }) { return audit.record({ tenantId, event }) },
      },
    })

    const result = await store.activateAutoGrant({
      tenantId: "tenant-acme",
      actor: { subjectId: "person-user", clientId: "self-service-ui", role: "USER", organizationIds: [] },
      value: { correlation_id: "activate-1", resource_id: "resource-ai", capability_id: "mcp.invoke" },
    })

    assert.equal(result.entitlement_id, event.entitlement_id)
    const events = await audit.query({ tenantId: "tenant-acme", correlationId: "activate-1", offset: 0, limit: 10 })
    assert.deepEqual(events.events, [event])
    assert.equal(sql.calls.some((text) => text.includes("insert into genio_one_model_entitlements")), false)
  }
})

test("owner entitlement query qualifies joined columns", async () => {
  const sql = new FakeSql((text) => {
    assert.match(text, /select entitlement\.entitlement_id/)
    assert.match(text, /entitlement\.resource_id/)
    return [{
      entitlement_id: "entitlement-1",
      subject_id: "person-user",
      resource_id: "resource-ai",
      capability_id: "model.invoke",
      state: "ACTIVE",
      valid_from: 100,
      valid_until: 200,
    }]
  })
  const store = createPostgresAccessGovernanceStore({ sql, audit, now: () => 150 })

  const result = await store.entitlementsForOwner({
    tenantId: "tenant-acme",
    actor: {
      subjectId: "person-admin",
      clientId: "management-ui",
      role: "TENANT_ADMINISTRATOR",
      organizationIds: [],
    },
  })

  assert.equal(result[0]?.state, "ACTIVE")
})

test("owner-management lists bind only administrator Organization scope", async () => {
  const sql = new FakeSql(() => [])
  const store = createPostgresAccessGovernanceStore({ sql, audit })
  const actor = {
    subjectId: "person-kevin",
    clientId: "management-ui",
    role: "ORGANIZATION_ADMINISTRATOR" as const,
    organizationIds: ["org-sales", "org-uat-access"],
    administratorOrganizationIds: ["org-uat-access"],
  }

  await store.listManagement({ tenantId: "tenant-acme", actor })
  await store.entitlementsForOwner({ tenantId: "tenant-acme", actor })
  await store.notifications({ tenantId: "tenant-acme", actor })

  const managementIndex = sql.calls.findIndex((text) =>
    text.includes("from genio_one_access_requests") && text.includes("owner_organization_id = any($3::text[])"),
  )
  const entitlementsIndex = sql.calls.findIndex((text) =>
    text.includes("from genio_one_model_entitlements entitlement") && text.includes("owner_organization_id = any($3::text[])"),
  )
  const notificationsIndex = sql.calls.findIndex((text) =>
    text.includes("owner_organization_id = any($4::text[])"),
  )
  assert.deepEqual(sql.parameters[managementIndex], ["tenant-acme", false, ["org-uat-access"]])
  assert.deepEqual(sql.parameters[entitlementsIndex], ["tenant-acme", false, ["org-uat-access"]])
  assert.deepEqual(sql.parameters[notificationsIndex], ["tenant-acme", "person-kevin", false, ["org-uat-access"]])
})

test("governed revocation records the reason and publishes the reduced entitlement snapshot", async () => {
  const sql = new FakeSql((text) => {
    if (text.includes("from genio_one_model_entitlements entitlement") && text.includes("for update")) {
      return [{
        entitlement_id: "entitlement-1",
        state: "ACTIVE",
        resource_id: "resource-ai",
        owner_organization_id: "org-ai",
        gateway_id: "gateway-ai",
      }]
    }
    if (text.includes("update genio_one_model_entitlements")) {
      return [{
        entitlement_id: "entitlement-1",
        subject_id: "person-user",
        resource_id: "resource-ai",
        capability_id: "model.invoke",
        state: "REVOKED",
        valid_from: 100,
        valid_until: 200,
        revocation_reason: "Access no longer required",
      }]
    }
    return []
  })
  const publications: string[] = []
  const store = createPostgresAccessGovernanceStore({
    sql,
    audit,
    now: () => 150,
    releasePublisher: {
      async reconcileInTransaction({ gatewayId }) {
        publications.push(gatewayId)
      },
    },
  })

  const result = await store.revokeEntitlement({
    tenantId: "tenant-acme",
    actor: {
      subjectId: "person-admin",
      clientId: "management-ui",
      role: "TENANT_ADMINISTRATOR",
      organizationIds: [],
    },
    entitlementId: "entitlement-1",
    value: {
      correlation_id: "correlation-revoke-1",
      reason: "Access no longer required",
    },
  })

  assert.equal(result.state, "REVOKED")
  assert.equal(result.revocation_reason, "Access no longer required")
  assert.deepEqual(publications, ["gateway-ai"])
  const revokeUpdateIndex = sql.calls.findIndex((text) => text.includes("update genio_one_model_entitlements"))
  assert.ok(revokeUpdateIndex >= 0)
  assert.match(sql.calls[revokeUpdateIndex]!, /revocation_correlation_id = \$6/)
  assert.equal(sql.parameters[revokeUpdateIndex]?.at(-1), "correlation-revoke-1")
})
