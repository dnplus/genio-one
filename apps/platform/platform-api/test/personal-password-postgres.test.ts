import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"
import { createPostgresPasswordCredentialStore } from "../src/capabilities/personal-credentials/module"
import { createMcpOAuthSecretCodec } from "../src/capabilities/mcp-oauth/crypto"
import { createPostgresMcpOAuthStore } from "../src/capabilities/mcp-oauth/postgres"

test("personal credential migration persists sealed values and accepts configured OAuth", { skip: process.env.GENIO_ONE_PASSWORD_PERSISTENCE_TEST !== "1" }, async () => {
  const url = process.env.GENIO_ONE_DATABASE_URL
  assert.ok(url)
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  const schema = `credentialqa_${crypto.randomUUID().replaceAll("-", "")}`
  const setup = createPostgresSqlAdapter({ url })
  await setup.query(`create schema ${schema}`)
  const sql = createPostgresSqlAdapter({ url, options: { max: 1, connection: { search_path: schema } } })
  try {
    await sql.query(`create table genio_one_resource_connections (
      tenant_id text, resource_id text, connection_id text, connection_kind text,
      downstream_identity jsonb, credential_ref text,
      provider_credential_profile_id text, provider_credential_profile_revision integer,
      provider_credential_strategy_digest text,
      primary key (tenant_id, resource_id, connection_id)
    )`)
    const migration = await readFile(new URL("../migrations/089_personal_password_credentials.sql", import.meta.url), "utf8")
    await sql.query(migration)
    await sql.query(migration)
    await sql.query(`insert into genio_one_resource_connections (tenant_id, resource_id, connection_id, connection_kind, downstream_identity) values
      ('tenant','mail2000','mail','MCP','{"mode":"USER_PASSWORD"}'::jsonb),
      ('tenant','servicenow','sn','MCP','{"mode":"USER_OAUTH","oauth_client":{"client_id":"client"}}'::jsonb)`)
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
    const oauthSchema = await readFile(new URL("../migrations/043_mcp_user_oauth.sql", import.meta.url), "utf8")
    await sql.query(oauthSchema.slice(oauthSchema.indexOf("create table if not exists genio_one_mcp_oauth_bindings"), oauthSchema.indexOf("create index if not exists genio_one_mcp_oauth_sessions_expiry_idx")))
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
