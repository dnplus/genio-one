import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import test from "node:test"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"
import { runMigrations } from "../src/persistence/migration-runner"
import { createPostgresProviderCredentialProfileStore } from "../src/capabilities/provider-credentials/postgres"
import { createMcpOAuthSecretCodec } from "../src/capabilities/mcp-oauth/crypto"

const url = process.env.GENIO_ONE_TEST_DATABASE_URL

test("PostgreSQL stores encrypted revision material and survives store reconstruction", { skip: !url }, async () => {
  const schema = `credential_test_${randomUUID().replaceAll("-", "")}`
  const admin = createPostgresSqlAdapter({ url, options: { max: 1, onnotice: () => {} } })
  const sql = createPostgresSqlAdapter({ url, options: { max: 1, connection: { search_path: schema }, onnotice: () => {} } })
  const codec = createMcpOAuthSecretCodec(randomBytes(32))
  try {
    await admin.query(`create schema ${schema}`)
    await runMigrations(sql, { advisoryLockKey: schema })
    await sql.query("insert into genio_one_organizations (tenant_id, organization_id, display_name, slug) values ('tenant-test', 'org-test', 'Test', 'test')")
    const material = JSON.stringify({ type: "authorized_user", client_id: "test-client", client_secret: "secret-sql-must-not-contain", refresh_token: "test-refresh" })
    const store = createPostgresProviderCredentialProfileStore({ sql, codec })
    const value = await store.create({ tenantId: "tenant-test", createdBySubjectId: "admin", value: { profile_id: "adc", owner_organization_id: "org-test", display_name: "Test ADC", credential_material: material, strategy: { kind: "RUNTIME_IDENTITY", adapter: "GCP_APPLICATION_DEFAULT", parameters: { project_name: "project", region: "us-central1" } } } })
    assert.equal(value.credential_configured, true)
    const persisted = await sql.query("select * from genio_one_provider_credential_profile_revisions")
    assert.doesNotMatch(JSON.stringify(persisted.rows), /secret-sql-must-not-contain|test-refresh/)
    assert.match(String(persisted.rows[0]!.credential_ciphertext), /^v1\./)
    const restarted = createPostgresProviderCredentialProfileStore({ sql, codec })
    assert.equal(await restarted.readMaterial!({ tenantId: "tenant-test", profileId: "adc", revision: 1 }), material)
    await restarted.revise({ tenantId: "tenant-test", profileId: "adc", createdBySubjectId: "admin", value: { expected_revision: 1, display_name: "Updated", strategy: value.strategy, state: "ACTIVE" } })
    assert.equal(await restarted.readMaterial!({ tenantId: "tenant-test", profileId: "adc", revision: 2 }), material)
    await sql.query("update genio_one_provider_credential_profile_revisions set credential_ciphertext = (select credential_ciphertext from genio_one_provider_credential_profile_revisions where revision = 1) where revision = 2")
    await assert.rejects(restarted.readMaterial!({ tenantId: "tenant-test", profileId: "adc", revision: 2 }), /PROVIDER_CREDENTIAL_STORAGE_INVALID/)
  } finally {
    await sql.end()
    await admin.query(`drop schema if exists ${schema} cascade`)
    await admin.end()
  }
})
