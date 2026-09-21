import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"
import { createPostgresPasswordCredentialStore } from "../src/capabilities/personal-credentials/module"
import { createMcpOAuthSecretCodec } from "../src/capabilities/mcp-oauth/crypto"
import { createPostgresMcpOAuthStore } from "../src/capabilities/mcp-oauth/postgres"

test("personal credential baseline persists sealed values and accepts configured OAuth", { skip: process.env.GENIO_ONE_PASSWORD_PERSISTENCE_TEST !== "1" }, async () => {
  const url = process.env.GENIO_ONE_DATABASE_URL
  assert.ok(url)
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  const schema = `credentialqa_${crypto.randomUUID().replaceAll("-", "")}`
  const setup = createPostgresSqlAdapter({ url })
  await setup.query(`create schema ${schema}`)
  const sql = createPostgresSqlAdapter({ url, options: { max: 1, connection: { search_path: schema } } })
  try {
    await sql.query(await readFile(new URL("../migrations/001_platform_baseline.sql", import.meta.url), "utf8"))
    await sql.query("insert into genio_one_organizations (tenant_id, organization_id, display_name, slug) values ('tenant', 'owner', 'Owner', 'owner')")
    await sql.query(`insert into genio_one_resources (
      tenant_id, resource_id, display_name, kind, owner_organization_id,
      authentication_strategy, environment_id, version, enforcement_point_id
    ) values
      ('tenant', 'mail2000', 'Mail2000', 'MCP', 'owner', 'USER', 'qa', '1', 'gateway'),
      ('tenant', 'servicenow', 'ServiceNow', 'MCP', 'owner', 'USER', 'qa', '1', 'gateway')`)
    await sql.query(`insert into genio_one_resource_connections (
      tenant_id, resource_id, connection_id, display_name, endpoint, connection_kind,
      downstream_identity, lifecycle, verification_state, health_state
    ) values
      ('tenant','mail2000','mail','Mail','https://mail.test','MCP','{"mode":"USER_PASSWORD"}'::jsonb,'ENABLED','VERIFIED','HEALTHY'),
      ('tenant','servicenow','sn','ServiceNow','https://servicenow.test','MCP','{"mode":"USER_OAUTH","oauth_client":{"client_id":"client"}}'::jsonb,'ENABLED','VERIFIED','HEALTHY')`)
    const owner = { tenantId: "tenant", resourceId: "mail2000", connectionId: "mail", subjectId: "alice" }
    const codec = createMcpOAuthSecretCodec(Buffer.alloc(32, 7))
    const store = createPostgresPasswordCredentialStore(sql)
    await store.put(owner, codec.seal({ ...owner, username: "alice", password: "only-in-ciphertext" }))
    const reloaded = createPostgresPasswordCredentialStore(sql)
    const sealed = await reloaded.get(owner)
    assert.ok(sealed)
    assert.ok(!sealed.includes("only-in-ciphertext"))
    assert.equal(codec.open<{ password: string }>(sealed).password, "only-in-ciphertext")
    assert.equal(await reloaded.get({ ...owner, subjectId: "bob" }), null)
    await store.remove(owner)
    assert.equal(await reloaded.get(owner), null)
    const oauth = createPostgresMcpOAuthStore({ sql })
    const binding = { tenant_id: "tenant", resource_id: "servicenow", connection_id: "sn", subject_id: "alice", issuer: "https://sn.test", resource_url: "https://mcp.test", sealed_state: codec.seal({ token: "old" }), updated_at: 1 }
    await oauth.putBinding(binding)
    await oauth.deleteBinding({ tenantId: "tenant", connectionId: "sn", subjectId: "alice" })
    assert.equal(await oauth.updateBindingIfCurrent(binding, { ...binding, sealed_state: codec.seal({ token: "new" }), updated_at: 2 }), false)
    assert.equal(await oauth.getBinding({ tenantId: "tenant", connectionId: "sn", subjectId: "alice" }), null)
    await oauth.putBinding(binding)
    assert.equal(await oauth.updateBindingIfCurrent(binding, { ...binding, sealed_state: codec.seal({ token: "new" }), updated_at: 2 }), true)
    assert.equal(await oauth.updateBindingIfCurrent(binding, { ...binding, sealed_state: codec.seal({ token: "stale" }), updated_at: 3 }), false)
  } finally {
    await sql.end({ timeout: 1 })
    await setup.query(`drop schema ${schema} cascade`)
    await setup.end({ timeout: 1 })
  }
})
