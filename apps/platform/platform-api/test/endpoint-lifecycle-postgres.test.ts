import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"
import { loadMigrations, runMigrations } from "../src/persistence/migration-runner"
import { createPostgresEndpointRuntimeStore } from "../src/capabilities/endpoint-runtime/postgres"

const url = process.env.GENIO_ONE_TEST_DATABASE_URL

test("Endpoint PostgreSQL revocation survives reconstruction, serializes retries, and rolls back when audit persistence fails", { skip: !url }, async () => {
  const schema = `endpoint_test_${randomUUID().replaceAll("-", "")}`
  const admin = createPostgresSqlAdapter({ url, options: { max: 1, onnotice: () => {} } })
  const sql = createPostgresSqlAdapter({ url, options: { max: 3, connection: { search_path: schema }, onnotice: () => {} } })
  let now = 100
  const options = { sql, now: () => now }
  const subject = { subject_id: "employee", evidence_level: "VERIFIED" as const }
  const binding = { tenantId: "tenant-1", deviceId: "device-1", subjectId: "employee" }
  try {
    await admin.query(`create schema ${schema}`)
    const priorMigrations = (await loadMigrations()).filter((migration) => migration.id < 24)
    await runMigrations(sql, { advisoryLockKey: schema, migrations: priorMigrations })
    const store = createPostgresEndpointRuntimeStore(options)
    const bootstrap = await store.bootstrap({ ...binding, correlationId: "bootstrap-1" })
    binding.deviceId = bootstrap.device_id
    const credential = await store.authenticateCredential({ tenantId: binding.tenantId, token: bootstrap.credential.token })
    const enrollment = await store.enroll({ ...binding, credentialId: credential.credentialId, value: { correlation_id: "enroll-1", device_id: binding.deviceId, endpoint_version: "0.1.0", at: 100,
      identity: { subject, acting_client: { acting_client_id: null, evidence_level: "UNKNOWN" }, device_id: null } } })
    const applied = await runMigrations(sql, { advisoryLockKey: schema })
    assert.deepEqual(applied.applied, [24])
    assert.deepEqual((await store.lifecycleEvents(binding)).map((event) => event.kind), ["ENROLLED"])
    const runtimeToken = enrollment.runtime_credential!.token
    await assert.rejects(store.authenticateCredential({ tenantId: binding.tenantId, token: bootstrap.credential.token }), /ENDPOINT_CREDENTIAL_REJECTED/)
    const identity = await store.authenticateCredential({ tenantId: binding.tenantId, token: runtimeToken })
    const rotation = { ...binding, credentialId: identity.credentialId, correlationId: "rotate-1" }
    await sql.query("alter table genio_one_endpoint_lifecycle_events add constraint reject_rotation_test check (kind <> 'ROTATED')")
    await assert.rejects(store.rotateCredential(rotation))
    await store.authenticateCredential({ tenantId: binding.tenantId, token: runtimeToken })
    assert.deepEqual((await store.lifecycleEvents(binding)).map((event) => event.kind), ["ENROLLED"])
    assert.equal((await sql.query("select credential_id from genio_one_endpoint_credentials")).rows.length, 2)
    await sql.query("alter table genio_one_endpoint_lifecycle_events drop constraint reject_rotation_test")
    const rotated = await store.rotateCredential(rotation)
    await assert.rejects(store.authenticateCredential({ tenantId: binding.tenantId, token: runtimeToken }), /ENDPOINT_CREDENTIAL_REJECTED/)
    const rotatedIdentity = await store.authenticateCredential({ tenantId: binding.tenantId, token: rotated.token })
    const events = await store.lifecycleEvents(binding)
    assert.deepEqual(events.map((event) => event.kind), ["ENROLLED", "ROTATED"])
    assert.deepEqual(events[1], {
      tenant_id: binding.tenantId, device_id: binding.deviceId, subject_id: binding.subjectId,
      correlation_id: "rotate-1", kind: "ROTATED", reason: null, at: now,
      old_credential_id: identity.credentialId, new_credential_id: rotatedIdentity.credentialId,
    })
    await assert.rejects(store.rotateCredential(rotation), /ENDPOINT_CREDENTIAL_REJECTED/)
    assert.equal((await store.lifecycleEvents(binding)).length, 2)
    const persisted = await sql.query("select * from genio_one_endpoint_credentials")
    assert.ok(!JSON.stringify(persisted.rows).includes(rotated.token))
    assert.ok(!JSON.stringify(persisted.rows).includes(bootstrap.credential.token))
    assert.ok(!JSON.stringify((await sql.query("select * from genio_one_endpoint_lifecycle_events")).rows).includes(rotated.token))
    const assertion = { ...binding, appliedStateRevision: "endpoint-direct-v1", appliedPolicyVersion: "endpoint-direct-policy-v1" }
    await assert.rejects(store.assertApplied(assertion), /ENDPOINT_DESIRED_STATE_NOT_APPLIED/)
    await store.heartbeat({ ...binding, value: { correlation_id: "ack-1", subject, evidence_level: "VERIFIED", endpoint_version: "0.1.0",
      applied_state_revision: assertion.appliedStateRevision, applied_policy_version: assertion.appliedPolicyVersion, health: "HEALTHY", at: 100 } })
    const restarted = createPostgresEndpointRuntimeStore(options)
    await restarted.authenticateCredential({ tenantId: binding.tenantId, token: rotated.token })
    await restarted.assertApplied(assertion)
    const nextRotation = { ...binding, credentialId: rotatedIdentity.credentialId, correlationId: "rotate-2" }
    const twiceRotated = await restarted.rotateCredential(nextRotation)
    await assert.rejects(restarted.authenticateCredential({ tenantId: binding.tenantId, token: rotated.token }), /ENDPOINT_CREDENTIAL_REJECTED/)
    const nextIdentity = await restarted.authenticateCredential({ tenantId: binding.tenantId, token: twiceRotated.token })
    const repeatedEvents = await restarted.lifecycleEvents(binding)
    assert.deepEqual(repeatedEvents.map((event) => event.kind), ["ENROLLED", "ROTATED", "ROTATED"])
    assert.deepEqual(repeatedEvents[2], {
      tenant_id: binding.tenantId, device_id: binding.deviceId, subject_id: binding.subjectId,
      correlation_id: "rotate-2", kind: "ROTATED", reason: null, at: now,
      old_credential_id: rotatedIdentity.credentialId, new_credential_id: nextIdentity.credentialId,
    })
    await assert.rejects(restarted.rotateCredential(nextRotation), /ENDPOINT_CREDENTIAL_REJECTED/)
    assert.equal((await restarted.lifecycleEvents(binding)).length, 3)
    now = 190
    await assert.rejects(restarted.assertApplied(assertion), /ENDPOINT_HEARTBEAT_STALE/)
    await sql.query("alter table genio_one_endpoint_lifecycle_events add constraint reject_revocation_test check (kind <> 'REVOKED')")
    const revoke = { ...binding, subjectId: "admin", correlationId: "revoke-1", reason: "Device lost" }
    await assert.rejects(restarted.revoke(revoke))
    assert.equal((await restarted.get(binding)).lifecycle_state, "ACTIVE")
    assert.equal((await restarted.lifecycleEvents(binding)).length, 3)
    await sql.query("alter table genio_one_endpoint_lifecycle_events drop constraint reject_revocation_test")
    const revoked = await Promise.all([restarted.revoke(revoke), restarted.revoke({ ...revoke, correlationId: "retry" })])
    assert.ok(revoked.every((device) => device.lifecycle_state === "REVOKED"))
    const final = createPostgresEndpointRuntimeStore(options)
    await assert.rejects(final.assertApplied(assertion), /DEVICE_REVOKED/)
    await assert.rejects(final.authenticateCredential({ tenantId: binding.tenantId, token: twiceRotated.token }), /ENDPOINT_CREDENTIAL_REJECTED/)
    assert.equal((await final.list({ tenantId: "tenant-2" })).length, 0)
    assert.deepEqual((await final.lifecycleEvents(binding)).map((event) => event.kind), ["ENROLLED", "ROTATED", "ROTATED", "REVOKED"])
  } finally {
    await sql.end()
    await admin.query(`drop schema if exists ${schema} cascade`)
    await admin.end()
  }
})
