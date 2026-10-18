import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import type { AccessAuditWriter } from "../src/capabilities/access/module"
import { autoGrantActivationRequestDigest } from "../src/capabilities/access/audit"
import { createPostgresAccessGovernanceStore } from "../src/capabilities/access/postgres"
import { createPostgresGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/postgres"
import { runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL

test("PostgreSQL Access canonical grants preserve atomic release/audit rollback and retry identity", {
  skip: !databaseUrl,
  timeout: 30_000,
}, async () => {
  assert.ok(databaseUrl)
  const schema = `access_grant_test_${randomUUID().replaceAll("-", "")}`
  const admin = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 1, onnotice: () => {} } })
  const sql = createPostgresSqlAdapter({
    url: databaseUrl,
    options: { max: 2, connection: { search_path: schema }, onnotice: () => {} },
  })
  const tenantId = "tenant-test"
  const actor = { subjectId: "subject-test", clientId: "client-test", role: "TENANT_ADMINISTRATOR" as const, organizationIds: [] }
  let at = 100
  let failAudit = true
  let failRelease = false
  let releaseCalls = 0
  let schemaCreated = false
  try {
    await admin.query(`create schema ${schema}`)
    schemaCreated = true
    await runMigrations(sql, { advisoryLockKey: schema })
    await sql.query(`create table test_release_snapshots (gateway_id text, entitlement_ids jsonb)`)
    await sql.query(`insert into genio_one_organizations (tenant_id, organization_id, display_name, slug)
      values ($1, 'org-test', 'Test', 'test')`, [tenantId])
    await sql.query(`insert into genio_one_subjects (tenant_id, subject_id, kind)
      values ($1, $2, 'PERSON')`, [tenantId, actor.subjectId])
    for (const resourceId of ["resource-auto", "resource-approval"]) {
      await sql.query(`insert into genio_one_resources
        (tenant_id, resource_id, display_name, kind, owner_organization_id, authentication_strategy,
         environment_id, version, capabilities, enforcement_point_id, lifecycle)
        values ($1, $2, 'Test', 'MCP', 'org-test', 'NONE', 'test', '1.0.0', $3::text::jsonb, 'gateway-test', 'PUBLISHED')`,
      [tenantId, resourceId, JSON.stringify([{ capability_id: "ticket.create", display_name: "Create" }, { capability_id: "ticket.read", display_name: "Read" }])])
      await sql.query(`insert into genio_one_publications
        (tenant_id, publication_id, resource_id, endpoint_revision, resource_revision, resource_digest,
         policy_revision, gateway_id, hostname, visibility, publication_state)
        values ($1, $2, $3, 1, 1, 'digest', 1, 'gateway-test', 'test.example.com', 'PUBLIC', 'PUBLISHED')`,
      [tenantId, `publication-${resourceId}`, resourceId])
    }
    const audit = createPostgresGatewayAuthorizationAuditStore({ sql })
    const store = createPostgresAccessGovernanceStore({
      sql,
      now: () => at,
      audit: {
        record: audit.record,
        findById: audit.findById,
        async recordInTransaction(input: Parameters<NonNullable<AccessAuditWriter["recordInTransaction"]>>[0]) {
          await audit.recordInTransaction!(input)
          if (failAudit) throw new Error("AUDIT_FAILURE")
        },
      },
      releasePublisher: {
        async reconcileInTransaction({ transaction, gatewayId, tenantId: releaseTenant }) {
          releaseCalls += 1
          await transaction.query(`insert into test_release_snapshots
            select $1, coalesce(jsonb_agg(entitlement_id), '[]'::jsonb)
              from genio_one_model_entitlements where tenant_id = $2 and state = 'ACTIVE'`,
          [gatewayId, releaseTenant])
          if (failRelease) throw new Error("RELEASE_FAILURE")
        },
      },
    })
    const counts = async () => {
      const result = await sql.query<{ grants: number; releases: number; audits: number }>(`select
        (select count(*)::int from genio_one_model_entitlements) as grants,
        (select count(*)::int from test_release_snapshots) as releases,
        (select count(*)::int from genio_one_gateway_authorization_audit_events) as audits`)
      return result.rows[0]
    }
    const activation = { tenantId, actor, value: { correlation_id: "activate-test", resource_id: "resource-auto", capability_id: "ticket.create" } }
    await assert.rejects(store.activateAutoGrant(activation), /AUDIT_FAILURE/)
    assert.equal(releaseCalls, 1)
    assert.deepEqual(await counts(), { grants: 0, releases: 0, audits: 0 })
    failAudit = false
    failRelease = true
    await assert.rejects(store.activateAutoGrant(activation), /RELEASE_FAILURE/)
    assert.deepEqual(await counts(), { grants: 0, releases: 0, audits: 0 })
    failRelease = false
    const [created, concurrentReplay] = await Promise.all([
      store.activateAutoGrant(activation),
      store.activateAutoGrant(activation),
    ])
    assert.equal(concurrentReplay.entitlement_id, created.entitlement_id)
    assert.deepEqual(await counts(), { grants: 1, releases: 1, audits: 1 })
    const release = await sql.query<{ entitlement_ids: string[] }>(`select entitlement_ids from test_release_snapshots`)
    assert.deepEqual(release.rows[0]?.entitlement_ids, [created.entitlement_id])
    const persisted = await sql.query<{ grant_request_digest: string }>(`select grant_request_digest from genio_one_model_entitlements where entitlement_id = $1`, [created.entitlement_id])
    assert.equal(persisted.rows[0]?.grant_request_digest, autoGrantActivationRequestDigest({
      tenantId, subjectId: actor.subjectId, clientId: actor.clientId, resourceId: "resource-auto", capabilityId: "ticket.create",
    }))
    at = 101
    assert.equal((await store.activateAutoGrant(activation)).entitlement_id, created.entitlement_id)
    assert.deepEqual(await counts(), { grants: 1, releases: 1, audits: 1 })
    await assert.rejects(store.activateAutoGrant({ ...activation, value: { ...activation.value, capability_id: "ticket.read" } }), /AUTO_GRANT_CORRELATION_REUSED/)
    await sql.query(`update genio_one_model_entitlements set expires_at = to_timestamp(102) where entitlement_id = $1`, [created.entitlement_id])
    at = 102
    await assert.rejects(store.activateAutoGrant(activation), /AUTO_GRANT_RETRY_NOT_EFFECTIVE/)
    await sql.query(`update genio_one_model_entitlements set state = 'REVOKED' where entitlement_id = $1`, [created.entitlement_id])
    await assert.rejects(store.activateAutoGrant(activation), /AUTO_GRANT_RETRY_NOT_EFFECTIVE/)
    assert.deepEqual(await counts(), { grants: 1, releases: 1, audits: 1 })

    await sql.query(`insert into genio_one_access_requests
      (tenant_id, access_request_id, requester_subject_id, target_subject_id, acting_client_id,
       resource_id, capability_id, owner_organization_id, justification, requested_valid_for)
      values ($1, 'request-test', $2, $2, $3, 'resource-approval', 'ticket.create', 'org-test', 'Need access', 100)`,
    [tenantId, actor.subjectId, actor.clientId])
    const approval = { tenantId, actor, requestId: "request-test", value: { correlation_id: "approve-test", decision: { APPROVE: { valid_until: 200 } } } }
    failAudit = true
    await assert.rejects(store.decide(approval), /AUDIT_FAILURE/)
    const pending = await sql.query<{ state: string; entitlement_id: string | null }>(`select state, entitlement_id from genio_one_access_requests`)
    assert.deepEqual(pending.rows[0], { state: "PENDING", entitlement_id: null })
    assert.deepEqual(await counts(), { grants: 1, releases: 1, audits: 1 })
    failAudit = false
    const approved = await store.decide(approval)
    assert.equal(approved.request.state, "APPROVED")
    assert.equal(approved.entitlement?.valid_until, 200)
    assert.deepEqual(await counts(), { grants: 2, releases: 2, audits: 2 })
    await assert.rejects(store.decide(approval), /ACCESS_DECISION_DENIED/)
    assert.deepEqual(await counts(), { grants: 2, releases: 2, audits: 2 })
  } finally {
    await sql.end()
    try {
      if (schemaCreated) await admin.query(`drop schema if exists ${schema} cascade`)
    } finally {
      await admin.end()
    }
  }
})
