import assert from "node:assert/strict"
import test from "node:test"

import { createPostgresAccessGovernanceStore } from "../src/capabilities/access/postgres"
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
      }]
    }
    return []
  })
  const store = createPostgresAccessGovernanceStore({
    sql,
    idFactory: () => "request-application-1",
  })

  const result = await store.request({
    tenantId: "tenant-acme",
    actor: {
      subjectId: "person-org-admin",
      clientId: "management-ui",
      role: "ORGANIZATION_ADMINISTRATOR",
      organizationIds: ["org-ai"],
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
  assert.ok(sql.parameters.some((parameters) => parameters.includes("application-subject-1")))
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
  const store = createPostgresAccessGovernanceStore({ sql })

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
  const store = createPostgresAccessGovernanceStore({ sql })

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
  const store = createPostgresAccessGovernanceStore({ sql, now: () => 150 })

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
})
