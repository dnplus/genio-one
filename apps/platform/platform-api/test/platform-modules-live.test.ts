import assert from "node:assert/strict"
import test from "node:test"

import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"
import { PlatformApiError } from "../src/capabilities/errors"
import {
  createPlatformModuleGraph,
  type PlatformModuleGraph,
} from "../src/capabilities/platform-modules-live"
import type { DurableEd25519Signer } from "../src/capabilities/gateway-projection/signer"
import type { ValkeySessionLeaseClient } from "../src/capabilities/model-routing/valkey"

type Row = Record<string, unknown>

const tenantId = "tenant-acme"

const modelRow: Row = {
  tenant_id: tenantId,
  model_id: "model-gpt",
  model_name: "corporate-gpt",
  display_name: "Corporate GPT",
  resource_id: "resource-ai",
  visibility: "PUBLIC",
  lifecycle: "PUBLISHED",
  capabilities: ["CHAT", "STREAMING"],
  created_at: 100,
}

const mappingRow: Row = {
  tenant_id: tenantId,
  mapping_id: "mapping-gpt-openai",
  public_model_id: "model-gpt",
  resource_id: "resource-ai",
  connection_id: "connection-openai",
  provider_model: "gpt-4.1",
  mapping_revision: 1,
  created_at: 100,
}

class FakeSqlAdapter implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []

  constructor(readonly handler: (text: string, parameters: readonly unknown[]) => Row[] = () => []) {}

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    const rows = this.handler(text, parameters) as Result[]
    return { rows, rowCount: rows.length }
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

class FakeValkey implements ValkeySessionLeaseClient {
  readonly values = new Map<string, string>()
  readonly setCalls: Array<{ key: string; value: string; options: { NX: true; EX: number } }> = []

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async set(
    key: string,
    value: string,
    options: { NX: true; EX: number },
  ): Promise<"OK" | null> {
    this.setCalls.push({ key, value, options })
    if (this.values.has(key)) return null
    this.values.set(key, value)
    return "OK"
  }

  async eval(): Promise<unknown> {
    throw new Error("unused")
  }
}

function durableSigner(keyId: string): DurableEd25519Signer {
  return {
    algorithm: "Ed25519",
    keyId,
    publicKeyPem: `public-key-${keyId}`,
    sign: () => "A".repeat(86),
  }
}

const signingRoles = {
  projection: durableSigner("projection-v1"),
  runtimeCommand: durableSigner("runtime-command-v1"),
  policyArtifact: durableSigner("policy-artifact-v1"),
  releaseRoot: durableSigner("release-root-v1"),
}

const mcpOAuthOptions = {
  mcpOAuthEncryptionKey: Buffer.alloc(32),
  mcpOAuthPublicOrigin: "http://127.0.0.1:58082",
  managementUiOrigin: "http://127.0.0.1:5173",
}

const gatewayRegistrationOptions = {
  platformOrigin: "http://127.0.0.1:58082",
  defaultGatewayId: "genio-ai-mcp-gateway",
  gatewayIdentityProvisioner: {
    async provision({ clientId }: { clientId: string }) {
      return {
        issuer: "https://issuer.example.test",
        token_endpoint: "https://issuer.example.test/token",
        audience: "genio-one-product-api",
        scope: "genioone-gateway-runtime",
        client_id: clientId,
        client_secret: "gateway-secret",
      }
    },
    async revoke() {},
  },
  applicationTokenBroker: {
    async mint() {
      throw new Error("not used")
    },
  },
  workloadAssertionVerifier: {
    async verify() {
      throw new Error("not used")
    },
  },
}

function graph(
  sql = new FakeSqlAdapter(),
  valkey = new FakeValkey(),
): { graph: PlatformModuleGraph; sql: FakeSqlAdapter; valkey: FakeValkey } {
  return {
    graph: createPlatformModuleGraph({
      sql,
      valkey,
      signingRoles,
      gatewayReleaseTtlSeconds: 600,
      ...mcpOAuthOptions,
      ...gatewayRegistrationOptions,
      now: () => 100,
      renderer: { namespace: "genio-test" },
    }),
    sql,
    valkey,
  }
}

test("live graph composes every stateful capability over one PostgreSQL adapter", async () => {
  const sql = new FakeSqlAdapter((text) => {
    // Connection.list first verifies that its Resource exists before reading
    // owned Connections. Return only that narrow probe row; every collection
    // query remains empty.
    if (text.includes("select resource_id") && text.includes("from genio_one_resources")) {
      return [{ resource_id: "resource-ai" }]
    }
    return []
  })
  const { graph: modules } = graph(sql)

  assert.equal(modules.sql, sql)
  assert.notEqual(modules.organizations, modules.resources)
  assert.notEqual(modules.resources, modules.connections)
  assert.notEqual(modules.connections, modules.models)
  assert.ok(modules.enforcementCompiler)
  assert.ok(modules.gatewayProjector)

  await Promise.all([
    modules.organizations.list({ tenantId }),
    modules.resources.listResources({ tenantId }),
    modules.connections.list({ tenantId, resourceId: "resource-ai" }),
    modules.providers.list({ tenantId }),
    modules.models.list({ tenantId }),
  ])

  // All five reads above went through the supplied SQL seam. A memory graph
  // would return without recording any database calls. Provider.list also
  // seeds built-ins transactionally, which is why the exact count is not a
  // contract; the table-specific reads are.
  for (const table of [
    "genio_one_organizations",
    "genio_one_resources",
    "genio_one_resource_connections",
    "genio_one_provider_profiles",
    "genio_one_public_models",
  ]) {
    assert.ok(sql.calls.some((call) => call.text.includes(table)), table)
  }
  assert.ok(sql.calls.length >= 5)
})

test("live model routing resolves through Valkey and the PostgreSQL model catalog", async () => {
  const sql = new FakeSqlAdapter((text) => {
    if (text.includes("genio_one_public_models")) return [modelRow]
    if (text.includes("genio_one_connection_model_mappings")) return [mappingRow]
    return []
  })
  const { graph: modules, valkey } = graph(sql)

  const result = await modules.modelRouter.resolve({
    tenantId,
    value: {
      subject_id: "subject-1",
      client_id: "client-1",
      public_model_id: "public-chat",
      session_id: "session-1",
      entitled_public_model_ids: ["model-gpt"],
    },
  })

  assert.equal(result.selected_public_model_id, "model-gpt")
  assert.equal(result.mapping_id, "mapping-gpt-openai")
  assert.equal(result.provider_model, "gpt-4.1")
  assert.equal(result.route_mode, "SESSION_LEASE")
  assert.equal(result.reused, false)
  assert.equal(valkey.setCalls.length, 1)
  assert.equal(sql.calls.length, 2)
})

test("live graph refuses to fall back to an ephemeral projection signer", () => {
  assert.throws(
    () =>
      createPlatformModuleGraph({
        sql: new FakeSqlAdapter(),
        valkey: new FakeValkey(),
        signingRoles: undefined as never,
        gatewayReleaseTtlSeconds: 600,
        ...mcpOAuthOptions,
        ...gatewayRegistrationOptions,
      }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "GATEWAY_PROJECTION_SIGNER_REQUIRED" &&
      error.statusCode === 500,
  )
})

test("live graph requires independent signing roles", () => {
  const shared = durableSigner("shared-role-a")
  assert.throws(
    () =>
      createPlatformModuleGraph({
        sql: new FakeSqlAdapter(),
        valkey: new FakeValkey(),
        signingRoles: {
          projection: shared,
          runtimeCommand: { ...shared, keyId: "shared-role-b" },
          policyArtifact: durableSigner("policy-artifact-v1"),
          releaseRoot: durableSigner("release-root-v1"),
        },
        gatewayReleaseTtlSeconds: 600,
        ...mcpOAuthOptions,
        ...gatewayRegistrationOptions,
      }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "PLATFORM_SIGNING_ROLE_CONFLICT" &&
      error.statusCode === 500,
  )
})
