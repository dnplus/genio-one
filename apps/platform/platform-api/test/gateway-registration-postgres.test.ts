import assert from "node:assert/strict"
import { createPublicKey, randomUUID } from "node:crypto"
import test from "node:test"

import { createGatewayRegistrationLifecycle } from "../src/capabilities/gateway-registration/module"
import { createPostgresGatewayRegistrationRepository } from "../src/capabilities/gateway-registration/postgres"
import { createPostgresRuntimeControlStore } from "../src/capabilities/runtime-control/postgres"
import { runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL

test("PostgreSQL connections exclude concurrent Gateway provisioning and retirement and release failed claims", { skip: !databaseUrl, timeout: 20_000 }, async () => {
  const firstSql = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 2 } })
  const secondSql = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 2 } })
  const input = { tenantId: `gateway-claim-${randomUUID()}`, runtimeId: "gateway", actorSubjectId: "admin" }
  const firstRepository = createPostgresGatewayRegistrationRepository({ sql: firstSql })
  const secondRepository = createPostgresGatewayRegistrationRepository({ sql: secondSql })
  const runtimeControl = createPostgresRuntimeControlStore({ sql: firstSql })
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const blocked = new Promise<void>((resolve) => { release = resolve })
  let provisions = 0
  let revocations = 0
  let fail = true
  const provisioner = {
    async provision({ clientId }: { clientId: string }) {
      provisions += 1
      if (provisions > 2) throw new Error("unexpected concurrent identity side effect")
      if (fail) throw new Error("identity unavailable")
      entered()
      await blocked
      return { issuer: "https://issuer.example.test", token_endpoint: "https://issuer.example.test/token", audience: "api", scope: "runtime", client_id: clientId, client_secret: `fixture-${provisions}` }
    },
    async revoke() { revocations += 1 },
  }
  const options = {
    provisioner,
    runtimeControl,
    platformOrigin: "https://one.example.test",
    defaultGatewayId: "gateway",
    runtimeCommandVerificationKeys: { schema_version: 1 as const, keys: [] },
    policyReleaseRootKeys: { schema_version: 1 as const, keys: [] },
  }
  const first = createGatewayRegistrationLifecycle({ ...options, repository: firstRepository })
  const second = createGatewayRegistrationLifecycle({ ...options, repository: secondRepository })
  try {
    await runMigrations(firstSql)
    await firstSql.query("insert into genio_one_subjects (tenant_id, subject_id, kind) values ($1, $2, 'PERSON')", [input.tenantId, input.actorSubjectId])
    await assert.rejects(first.register({ ...input, value: { correlation_id: "claim", runtime_id: input.runtimeId, display_name: "Gateway", site_id: "test", region: "test", labels: {} } }), /identity unavailable/)
    assert.equal((await secondRepository.get(input))?.state, "PROVISIONING")
    fail = false
    const pending = first.provision(input)
    await started
    try {
      await assert.rejects(second.provision(input), /GATEWAY_LIFECYCLE_IN_PROGRESS/)
      await assert.rejects(second.retire(input), /GATEWAY_LIFECYCLE_IN_PROGRESS/)
      assert.equal(provisions, 2)
      assert.equal(revocations, 0)
    } finally {
      release()
      await pending
    }
    const bootstrap = await pending
    await assert.rejects(second.provision(input), /GATEWAY_BOOTSTRAP_ALREADY_DELIVERED/)
    const runtime = await runtimeControl.getGatewayRuntime(input)
    assert.equal(runtime?.report_public_key_pem, createPublicKey(bootstrap.report_signing.private_key_pem).export({ type: "spki", format: "pem" }).toString())
    assert.equal(runtime?.status, "ACTIVE")
    assert.equal(provisions, 2)
    assert.equal((await second.retire(input)).state, "RETIRED")
    assert.equal((await runtimeControl.getGatewayRuntime(input))?.status, "REVOKED")
    assert.equal(revocations, 1)
  } finally {
    release()
    await firstSql.query("delete from genio_one_gateway_registrations where tenant_id = $1", [input.tenantId])
    await firstSql.query("delete from genio_one_platform_runtime_registrations where tenant_id = $1", [input.tenantId])
    await firstSql.query("delete from genio_one_subjects where tenant_id = $1", [input.tenantId])
    await Promise.all([firstSql.end(), secondSql.end()])
  }
})

for (const max of [1, 2]) {
  test(`PostgreSQL shared pool max=${max} completes concurrent Gateway lifecycle operations`, { skip: !databaseUrl, timeout: 15_000 }, async () => {
    const sql = createPostgresSqlAdapter({ url: databaseUrl, options: { max } })
    const cleanupSql = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 1 } })
    const tenantId = `gateway-pool-${randomUUID()}`
    const actorSubjectId = "admin"
    const inputs = ["first", "second"].map((runtimeId) => ({ tenantId, runtimeId, actorSubjectId }))
    const repository = createPostgresGatewayRegistrationRepository({ sql })
    const runtimeControl = createPostgresRuntimeControlStore({ sql })
    let provisions = 0
    let revocations = 0
    let releaseProvision!: () => void
    let releaseRevoke!: () => void
    const provisionBarrier = new Promise<void>((resolve) => { releaseProvision = resolve })
    const revokeBarrier = new Promise<void>((resolve) => { releaseRevoke = resolve })
    const lifecycle = createGatewayRegistrationLifecycle({
      repository,
      runtimeControl,
      provisioner: {
        async provision({ clientId }) {
          provisions += 1
          if (max === 2) {
            if (provisions === inputs.length) releaseProvision()
            await provisionBarrier
          }
          return { issuer: "https://issuer.example.test", token_endpoint: "https://issuer.example.test/token", audience: "api", scope: "runtime", client_id: clientId, client_secret: "fixture" }
        },
        async revoke(input) {
          assert.equal(input.tenantId, tenantId)
          assert.equal(input.clientId, input.runtimeId)
          revocations += 1
          if (max === 2) {
            if (revocations === inputs.length) releaseRevoke()
            await revokeBarrier
          }
        },
      },
      platformOrigin: "https://one.example.test",
      defaultGatewayId: "gateway",
      runtimeCommandVerificationKeys: { schema_version: 1, keys: [] },
      policyReleaseRootKeys: { schema_version: 1, keys: [] },
    })
    async function bounded<T>(operation: Promise<T>): Promise<T> {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`shared pool max=${max} lifecycle exceeded 3 seconds`)), 3_000) }),
        ])
      } finally {
        clearTimeout(timeout)
      }
    }
    try {
      await runMigrations(sql)
      await sql.query("insert into genio_one_subjects (tenant_id, subject_id, kind) values ($1, $2, 'PERSON')", [tenantId, actorSubjectId])
      for (const input of inputs) {
        await repository.create({ ...input, gatewayId: "gateway", value: { correlation_id: "pool", runtime_id: input.runtimeId, display_name: input.runtimeId, site_id: "test", region: "test", labels: {} } })
      }
      const bootstraps = await bounded(Promise.all(inputs.map((input) => lifecycle.provision(input))))
      assert.equal(provisions, inputs.length)
      for (const bootstrap of bootstraps) {
        const key = { tenantId, runtimeId: bootstrap.runtime_id }
        const runtime = await runtimeControl.getGatewayRuntime(key)
        assert.equal((await repository.get(key))?.state, "ACTIVE")
        assert.equal(runtime?.status, "ACTIVE")
        assert.equal(runtime?.report_public_key_pem, createPublicKey(bootstrap.report_signing.private_key_pem).export({ type: "spki", format: "pem" }).toString())
      }
      const retired = await bounded(Promise.all(inputs.map((input) => lifecycle.retire(input))))
      assert.equal(revocations, inputs.length)
      assert.deepEqual(retired.map((registration) => registration.state), ["RETIRED", "RETIRED"])
      for (const input of inputs) {
        assert.equal((await runtimeControl.getGatewayRuntime(input))?.status, "REVOKED")
      }
    } finally {
      releaseProvision()
      releaseRevoke()
      await sql.end({ timeout: 1 })
      await cleanupSql.query("delete from genio_one_gateway_registrations where tenant_id = $1", [tenantId])
      await cleanupSql.query("delete from genio_one_platform_runtime_registrations where tenant_id = $1", [tenantId])
      await cleanupSql.query("delete from genio_one_subjects where tenant_id = $1", [tenantId])
      await cleanupSql.end({ timeout: 1 })
    }
  })
}
