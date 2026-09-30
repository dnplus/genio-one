import assert from "node:assert/strict"
import test from "node:test"

import type { AccessGovernanceAuditEvent, AccessGovernanceAuditWriter } from "../src/capabilities/access/audit"
import type { RequestAccessOutcome } from "../src/capabilities/access/contract"
import { createInMemoryAccessGovernanceStore } from "../src/capabilities/access/memory"
import { createPostgresAccessGovernanceStore } from "../src/capabilities/access/postgres"
import { createInMemoryGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/memory"
import { createInMemoryModelEntitlementCatalog } from "../src/capabilities/entitlements/memory"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

type Row = Record<string, unknown>

const tenantId = "tenant-access-audit"
const requester = {
  subjectId: "person-anrita",
  clientId: "self-service-ui",
  role: "USER" as const,
  organizationIds: [],
}
const approver = {
  subjectId: "person-kevin",
  clientId: "management-ui",
  role: "TENANT_ADMINISTRATOR" as const,
  organizationIds: [],
}
const resource = {
  tenant_id: tenantId,
  resource_id: "resource-uat-access",
  display_name: "UAT Requestable Access",
  owner_organization_id: "org-uat-access",
  kind: "MCP",
  lifecycle: "PUBLISHED",
  operational_state: "HEALTHY",
  publication_endpoint: {
    visibility: "REQUEST",
    hostname: "access.example.test",
    base_path: "/mcp/access",
  },
  capabilities: [{ capability_id: "access.request", display_name: "Request access" }],
}

function created(outcome: RequestAccessOutcome) {
  assert.ok("CREATED" in outcome)
  if (!("CREATED" in outcome)) throw new Error("ACCESS_REQUEST_NOT_CREATED")
  return outcome.CREATED
}

function memoryAccess(audit: AccessGovernanceAuditWriter) {
  const entitlements = createInMemoryModelEntitlementCatalog({
    now: () => 100,
    idFactory: (sequence) => `entitlement-${sequence}`,
  })
  const access = createInMemoryAccessGovernanceStore({
    resources: {
      async listResources() {
        return [resource]
      },
      async getResource() {
        return resource
      },
    },
    entitlements,
    configuration: {
      async published() {
        return {
          revision: "configuration-1",
          settings: {
            request_form: { enabled: true },
            ttl_options_seconds: [100],
            approval_workflow_version: "owner-review-v1",
          },
        }
      },
    },
    identity: { async inventory() { return { subjects: [] } } },
    organizations: { async list() { return [] } },
    audit,
    now: () => 100,
    idFactory: (() => {
      let sequence = 0
      return () => `${++sequence}`
    })(),
  } as unknown as Parameters<typeof createInMemoryAccessGovernanceStore>[0])
  return { access, entitlements }
}

async function governanceEvent(
  audit: ReturnType<typeof createInMemoryGatewayAuthorizationAuditStore>,
  correlationId: string,
) {
  const result = await audit.query({ tenantId, correlationId, offset: 0, limit: 10 })
  assert.equal(result.events.length, 1)
  const event = result.events[0]
  if (!event || event.kind !== "ACCESS_GOVERNANCE_CHANGE") throw new Error("ACCESS_AUDIT_EVENT_NOT_FOUND")
  return event
}

test("in-memory Access mutations record the full governed lifecycle in the unified audit store", async () => {
  const audit = createInMemoryGatewayAuthorizationAuditStore()
  const { access } = memoryAccess(audit)

  const deniedRequest = created(await access.request({
    tenantId,
    actor: requester,
    value: {
      correlation_id: "access-created-deny",
      resource_id: resource.resource_id,
      capability_id: "access.request",
      justification: "Need service access",
      requested_valid_for_seconds: 100,
    },
  }))
  await access.decide({
    tenantId,
    actor: approver,
    requestId: deniedRequest.access_request_id,
    value: { correlation_id: "access-deny", decision: { DENY: { reason: "Not approved" } } },
  })

  const approvedRequest = created(await access.request({
    tenantId,
    actor: requester,
    value: {
      correlation_id: "access-created-approve",
      resource_id: resource.resource_id,
      capability_id: "access.request",
      justification: "Need service access after review",
      requested_valid_for_seconds: 100,
    },
  }))
  const approved = await access.decide({
    tenantId,
    actor: approver,
    requestId: approvedRequest.access_request_id,
    value: { correlation_id: "access-approve", decision: { APPROVE: { valid_until: 200 } } },
  })
  assert.ok(approved.entitlement)
  await access.revokeEntitlement({
    tenantId,
    actor: approver,
    entitlementId: approved.entitlement.entitlement_id,
    value: { correlation_id: "access-revoke", reason: "No longer required" },
  })

  const createdEvent = await governanceEvent(audit, "access-created-deny")
  assert.deepEqual({
    operation: createdEvent.operation,
    subject: createdEvent.subject.subject_id,
    actor: createdEvent.actor_subject.subject_id,
    client: createdEvent.acting_client.acting_client_id,
    request: createdEvent.access_request_id,
    entitlement: createdEvent.entitlement_id,
    resource: createdEvent.resource_id,
    capability: createdEvent.capability_id,
    outcome: createdEvent.outcome,
  }, {
    operation: "CREATED",
    subject: "person-anrita",
    actor: "person-anrita",
    client: "self-service-ui",
    request: deniedRequest.access_request_id,
    entitlement: null,
    resource: resource.resource_id,
    capability: "access.request",
    outcome: "SUCCESS",
  })

  const deniedEvent = await governanceEvent(audit, "access-deny")
  assert.deepEqual([deniedEvent.operation, deniedEvent.subject.subject_id, deniedEvent.actor_subject.subject_id, deniedEvent.access_request_id, deniedEvent.entitlement_id], [
    "DENY", "person-anrita", "person-kevin", deniedRequest.access_request_id, null,
  ])

  const approvedEvent = await governanceEvent(audit, "access-approve")
  assert.deepEqual([approvedEvent.operation, approvedEvent.subject.subject_id, approvedEvent.actor_subject.subject_id, approvedEvent.access_request_id, approvedEvent.entitlement_id], [
    "APPROVE", "person-anrita", "person-kevin", approvedRequest.access_request_id, approved.entitlement.entitlement_id,
  ])

  const revokedEvent = await governanceEvent(audit, "access-revoke")
  assert.deepEqual([revokedEvent.operation, revokedEvent.subject.subject_id, revokedEvent.actor_subject.subject_id, revokedEvent.access_request_id, revokedEvent.entitlement_id], [
    "REVOKE", "person-anrita", "person-kevin", null, approved.entitlement.entitlement_id,
  ])
})

test("in-memory Access mutations leave no successful request or active grant after audit failures", async () => {
  let failingOperation: AccessGovernanceAuditEvent["operation"] | null = "CREATED"
  const recorded: AccessGovernanceAuditEvent[] = []
  const audit: AccessGovernanceAuditWriter = {
    async record({ event }) {
      if (event.operation === failingOperation) {
        failingOperation = null
        throw new Error(`AUDIT_${event.operation}_UNAVAILABLE`)
      }
      recorded.push(structuredClone(event))
    },
  }
  const { access, entitlements } = memoryAccess(audit)
  const requestValue = {
    resource_id: resource.resource_id,
    capability_id: "access.request",
    justification: "Need governed access",
    requested_valid_for_seconds: 100,
  }

  await assert.rejects(access.request({
    tenantId,
    actor: requester,
    value: { ...requestValue, correlation_id: "retry-created" },
  }), /AUDIT_CREATED_UNAVAILABLE/)
  assert.deepEqual(await access.listMine({ tenantId, actor: requester }), [])

  const deniedRequest = created(await access.request({
    tenantId,
    actor: requester,
    value: { ...requestValue, correlation_id: "retry-created" },
  }))
  failingOperation = "DENY"
  await assert.rejects(access.decide({
    tenantId,
    actor: approver,
    requestId: deniedRequest.access_request_id,
    value: { correlation_id: "retry-deny", decision: { DENY: { reason: "Declined" } } },
  }), /AUDIT_DENY_UNAVAILABLE/)
  assert.equal((await access.listMine({ tenantId, actor: requester }))[0]?.state, "PENDING")
  const denied = await access.decide({
    tenantId,
    actor: approver,
    requestId: deniedRequest.access_request_id,
    value: { correlation_id: "retry-deny", decision: { DENY: { reason: "Declined" } } },
  })
  assert.equal(denied.request.request_correlation_id, "retry-created")
  assert.equal(denied.request.decision_correlation_id, "retry-deny")

  const approvedRequest = created(await access.request({
    tenantId,
    actor: requester,
    value: { ...requestValue, correlation_id: "retry-created-approve" },
  }))
  failingOperation = "APPROVE"
  await assert.rejects(access.decide({
    tenantId,
    actor: approver,
    requestId: approvedRequest.access_request_id,
    value: { correlation_id: "retry-approve", decision: { APPROVE: { valid_until: 200 } } },
  }), /AUDIT_APPROVE_UNAVAILABLE/)
  assert.equal((await access.listMine({ tenantId, actor: requester }).then((requests) =>
    requests.find((request) => request.access_request_id === approvedRequest.access_request_id)?.state)), "PENDING")
  assert.equal((await entitlements.list({ tenantId })).filter((entitlement) => entitlement.state === "ACTIVE").length, 0)
  const approved = await access.decide({
    tenantId,
    actor: approver,
    requestId: approvedRequest.access_request_id,
    value: { correlation_id: "retry-approve", decision: { APPROVE: { valid_until: 200 } } },
  })
  assert.ok(approved.entitlement)
  assert.equal(approved.request.request_correlation_id, "retry-created-approve")
  assert.equal(approved.request.decision_correlation_id, "retry-approve")
  assert.equal((await entitlements.list({ tenantId })).filter((entitlement) => entitlement.state === "ACTIVE").length, 1)

  failingOperation = "REVOKE"
  await assert.rejects(access.revokeEntitlement({
    tenantId,
    actor: approver,
    entitlementId: approved.entitlement.entitlement_id,
    value: { correlation_id: "retry-revoke", reason: "No longer needed" },
  }), /AUDIT_REVOKE_UNAVAILABLE/)
  assert.equal((await entitlements.list({ tenantId })).find((entitlement) => entitlement.entitlement_id === approved.entitlement?.entitlement_id)?.state, "ACTIVE")
  await access.revokeEntitlement({
    tenantId,
    actor: approver,
    entitlementId: approved.entitlement.entitlement_id,
    value: { correlation_id: "retry-revoke", reason: "No longer needed" },
  })
  assert.equal((await entitlements.list({ tenantId })).find((entitlement) => entitlement.entitlement_id === approved.entitlement?.entitlement_id)?.state, "REVOKED")
  assert.deepEqual(recorded.map((event) => event.operation), ["CREATED", "DENY", "CREATED", "APPROVE", "REVOKE"])
})

class LifecycleSql implements SqlAdapter, SqlTransaction {
  readonly calls: string[] = []

  async query<Result extends Row = Row>(text: string, parameters: readonly unknown[] = []): Promise<SqlQueryResult<Result>> {
    this.calls.push(text)
    const rows = lifecycleRows(text, parameters) as Result[]
    return { rows, rowCount: rows.length }
  }

  async transaction<Result>(work: (transaction: SqlTransaction) => Promise<Result>): Promise<Result> {
    return work(this)
  }
}

class TrackingTransactionSql implements SqlAdapter {
  readonly attempted: string[] = []
  readonly committed: string[] = []
  transactionHandle: SqlTransaction | null = null

  async query<Result extends Row = Row>(): Promise<SqlQueryResult<Result>> {
    throw new Error("OUTSIDE_TRANSACTION_QUERY")
  }

  async transaction<Result>(work: (transaction: SqlTransaction) => Promise<Result>): Promise<Result> {
    const staged: string[] = []
    const transaction: SqlTransaction = {
      query: async <Result extends Row = Row>(text: string, parameters: readonly unknown[] = []) => {
        this.attempted.push(text)
        staged.push(text)
        const rows = lifecycleRows(text, parameters) as Result[]
        return { rows, rowCount: rows.length }
      },
    }
    this.transactionHandle = transaction
    const result = await work(transaction)
    this.committed.push(...staged)
    return result
  }
}

function requestRow(accessRequestId: string): Row {
  return {
    tenant_id: tenantId,
    access_request_id: accessRequestId,
    requester_subject_id: "person-anrita",
    target_subject_id: "person-anrita",
    acting_client_id: "self-service-ui",
    resource_id: resource.resource_id,
    capability_id: "access.request",
    owner_organization_id: "org-uat-access",
    justification: "Need governed access",
    requested_valid_for: 100,
    configuration_revision: "configuration-1",
    approval_workflow_version: "owner-review-v1",
    state: "PENDING",
    created_at: 100,
    expires_at: null,
    resolved_at: null,
    resolution_reason: null,
    decided_by_subject_id: null,
    entitlement_id: null,
  }
}

function lifecycleRows(text: string, parameters: readonly unknown[]): Row[] {
  if (text.includes("from genio_one_tenant_configuration_revisions")) {
    return [{
      revision: "configuration-1",
      settings: {
        request_form: { enabled: true },
        ttl_options_seconds: [100],
        approval_workflow_version: "owner-review-v1",
      },
    }]
  }
  if (text.includes("from genio_one_resources resource") && !text.includes("from genio_one_model_entitlements entitlement")) {
    return [{ owner_organization_id: "org-uat-access" }]
  }
  if (text.includes("select entitlement_id from genio_one_model_entitlements")) return []
  if (text.includes("state = 'PENDING' limit 1")) return []
  if (text.includes("insert into genio_one_access_requests")) return [requestRow("request-created")]
  if (text.includes("from genio_one_access_requests") && text.includes("for update")) {
    return [requestRow(String(parameters[1]))]
  }
  if (text.includes("insert into genio_one_model_entitlements")) {
    return [{
      entitlement_id: "entitlement-approved",
      subject_id: "person-anrita",
      resource_id: resource.resource_id,
      capability_id: "access.request",
      state: "ACTIVE",
      valid_from: 100,
      valid_until: 200,
      revocation_reason: null,
    }]
  }
  if (text.includes("from genio_one_model_entitlements entitlement") && text.includes("for update")) {
    return [{
      entitlement_id: "entitlement-approved",
      subject_id: "person-anrita",
      capability_id: "access.request",
      state: "ACTIVE",
      resource_id: resource.resource_id,
      owner_organization_id: "org-uat-access",
      gateway_id: null,
    }]
  }
  if (text.includes("select gateway_id from genio_one_publications")) return []
  if (text.includes("update genio_one_model_entitlements")) {
    return [{
      entitlement_id: "entitlement-approved",
      subject_id: "person-anrita",
      resource_id: resource.resource_id,
      capability_id: "access.request",
      state: "REVOKED",
      valid_from: 100,
      valid_until: 200,
      revocation_reason: "No longer needed",
    }]
  }
  if (text.includes("from genio_one_access_requests")) {
    const requestId = String(parameters[1])
    if (requestId === "request-denied") {
      return [{
        ...requestRow(requestId),
        state: "DENIED",
        resolved_at: 100,
        resolution_reason: "Declined",
        decided_by_subject_id: "person-kevin",
      }]
    }
    if (requestId === "request-approved") {
      return [{
        ...requestRow(requestId),
        state: "APPROVED",
        expires_at: 200,
        resolved_at: 100,
        decided_by_subject_id: "person-kevin",
        entitlement_id: "entitlement-approved",
      }]
    }
  }
  return []
}

function requestInput(correlationId: string) {
  return {
    tenantId,
    actor: requester,
    value: {
      correlation_id: correlationId,
      resource_id: resource.resource_id,
      capability_id: "access.request",
      justification: "Need governed access",
      requested_valid_for_seconds: 100,
    },
  }
}

test("Postgres Access mutations record each lifecycle event through the active transaction", async () => {
  const sql = new LifecycleSql()
  const events: AccessGovernanceAuditEvent[] = []
  const audit: AccessGovernanceAuditWriter = {
    async record() {
      throw new Error("POOL_AUDIT_FALLBACK")
    },
    async recordInTransaction({ transaction, event }) {
      assert.equal(transaction, sql)
      events.push(structuredClone(event))
    },
  }
  const store = createPostgresAccessGovernanceStore({
    sql,
    audit,
    now: () => 100,
    idFactory: (prefix) => prefix === "access-request" ? "request-created" : "entitlement-approved",
  })

  await store.request(requestInput("postgres-created"))
  await store.decide({
    tenantId,
    actor: approver,
    requestId: "request-denied",
    value: { correlation_id: "postgres-deny", decision: { DENY: { reason: "Declined" } } },
  })
  await store.decide({
    tenantId,
    actor: approver,
    requestId: "request-approved",
    value: { correlation_id: "postgres-approve", decision: { APPROVE: { valid_until: 200 } } },
  })
  await store.revokeEntitlement({
    tenantId,
    actor: approver,
    entitlementId: "entitlement-approved",
    value: { correlation_id: "postgres-revoke", reason: "No longer needed" },
  })

  assert.deepEqual(events.map((event) => [
    event.operation,
    event.subject.subject_id,
    event.actor_subject.subject_id,
    event.acting_client.acting_client_id,
    event.access_request_id,
    event.entitlement_id,
    event.outcome,
  ]), [
    ["CREATED", "person-anrita", "person-anrita", "self-service-ui", "request-created", null, "SUCCESS"],
    ["DENY", "person-anrita", "person-kevin", "management-ui", "request-denied", null, "SUCCESS"],
    ["APPROVE", "person-anrita", "person-kevin", "management-ui", "request-approved", "entitlement-approved", "SUCCESS"],
    ["REVOKE", "person-anrita", "person-kevin", "management-ui", null, "entitlement-approved", "SUCCESS"],
  ])
})

test("Postgres Access rolls back staged writes when the transaction audit write fails", async () => {
  const sql = new TrackingTransactionSql()
  const audit: AccessGovernanceAuditWriter = {
    async record() {
      throw new Error("POOL_AUDIT_FALLBACK")
    },
    async recordInTransaction({ transaction }) {
      assert.equal(transaction, sql.transactionHandle)
      throw new Error("ACCESS_AUDIT_WRITE_FAILED")
    },
  }
  const store = createPostgresAccessGovernanceStore({
    sql,
    audit,
    now: () => 100,
    idFactory: () => "request-created",
  })

  await assert.rejects(store.request(requestInput("postgres-audit-failure")), /ACCESS_AUDIT_WRITE_FAILED/)
  assert.ok(sql.attempted.some((text) => text.includes("insert into genio_one_access_requests")))
  assert.deepEqual(sql.committed, [])
})

test("Postgres Access refuses a mutation when no transaction audit writer is available", async () => {
  const sql = new LifecycleSql()
  const audit: AccessGovernanceAuditWriter = {
    async record() {},
  }
  const store = createPostgresAccessGovernanceStore({
    sql,
    audit,
    now: () => 100,
    idFactory: () => "request-created",
  })

  await assert.rejects(store.request(requestInput("postgres-audit-unavailable")), { code: "ACCESS_AUDIT_TRANSACTION_REQUIRED" })
  assert.equal(sql.calls.some((text) => text.includes("insert into genio_one_access_requests")), false)
})
