import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"

import { createPostgresMcpDiscoveryStore } from "../src/capabilities/mcp-discovery/postgres"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"

const tenantId = "tenant-discovery"
const connectionId = "shared-connection"
const observation = {
  protocol_version: "2025-11-25",
  server_name: "shared-server",
  server_version: null,
  tools: [{ name: "search", title: "Search", description: "Search records" }],
}

test("PostgreSQL MCP discovery migration preserves operations and isolates active Resource transactions", { skip: process.env.GENIO_ONE_DISCOVERY_RESOURCE_PERSISTENCE_TEST !== "1" }, async () => {
  const url = process.env.GENIO_ONE_DATABASE_URL
  assert.ok(url)
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  const schema = `discoveryqa_${crypto.randomUUID().replaceAll("-", "")}`
  const setup = createPostgresSqlAdapter({ url })
  await setup.query(`create schema ${schema}`)
  const sql = createPostgresSqlAdapter({ url, options: { max: 2, connection: { search_path: schema } } })
  try {
    for (const migration of [
      "001_platform_baseline.sql",
      "013_mcp_tool_read_only_reviews.sql",
      "022_mcp_oauth_resource_scope.sql",
    ]) {
      await sql.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"))
    }
    await sql.query("insert into genio_one_organizations (tenant_id, organization_id, display_name, slug) values ('tenant-discovery', 'owner', 'Owner', 'owner')")
    await sql.query(`insert into genio_one_resources (
      tenant_id, resource_id, display_name, kind, owner_organization_id,
      authentication_strategy, environment_id, version, enforcement_point_id
    ) values
      ('tenant-discovery', 'resource-one', 'Resource One', 'MCP', 'owner', 'USER', 'qa', '1', 'gateway-discovery'),
      ('tenant-discovery', 'resource-two', 'Resource Two', 'MCP', 'owner', 'USER', 'qa', '1', 'gateway-discovery')`)
    await sql.query(`insert into genio_one_resource_connections (
      tenant_id, resource_id, connection_id, display_name, endpoint, connection_kind,
      lifecycle, verification_state, health_state
    ) values
      ('tenant-discovery', 'resource-one', 'shared-connection', 'Connection One', 'https://one.test/mcp', 'MCP', 'ENABLED', 'VERIFIED', 'HEALTHY'),
      ('tenant-discovery', 'resource-two', 'shared-connection', 'Connection Two', 'https://two.test/mcp', 'MCP', 'ENABLED', 'VERIFIED', 'HEALTHY')`)
    await sql.query(`insert into genio_one_mcp_discovery_operations (
      tenant_id, operation_id, gateway_id, resource_id, connection_id,
      requested_by_subject_id, correlation_id, endpoint, downstream_identity
    ) values (
      'tenant-discovery', 'legacy-one', 'gateway-discovery', 'resource-one', 'shared-connection',
      'alice', 'same-correlation', 'https://one.test/mcp', '{"mode":"NONE"}'::jsonb
    )`)
    await sql.query(await readFile(new URL("../migrations/023_mcp_discovery_resource_scope.sql", import.meta.url), "utf8"))

    const legacy = await sql.query<{ resource_id: string }>(
      "select resource_id from genio_one_mcp_discovery_operations where tenant_id = $1 and operation_id = 'legacy-one'",
      [tenantId],
    )
    assert.equal(legacy.rows[0]?.resource_id, "resource-one")
    const index = await sql.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = $1 and indexname = 'genio_one_mcp_discovery_active_connection_idx'",
      [schema],
    )
    assert.match(index.rows[0]?.indexdef ?? "", /\(tenant_id, resource_id, connection_id\)/)
    const correlationConstraint = await sql.query<{ definition: string }>(
      `select pg_get_constraintdef(con.oid) as definition
         from pg_constraint con
         join pg_namespace ns on ns.oid = con.connamespace
        where ns.nspname = $1 and con.conname = 'genio_one_mcp_discovery_resource_correlation_key'`,
      [schema],
    )
    assert.match(correlationConstraint.rows[0]?.definition ?? "", /UNIQUE \(tenant_id, resource_id, correlation_id\)/)

    let operationNumber = 0
    const store = createPostgresMcpDiscoveryStore({ sql, idFactory: () => `new-${++operationNumber}` })
    const request = (resourceId: string, correlationId: string) => store.request({
      tenantId,
      resourceId,
      connectionId,
      requestedBySubjectId: "alice",
      correlationId,
    })
    const first = await request("resource-one", "retry-one")
    const second = await request("resource-two", "same-correlation")
    assert.equal(first.operation_id, "legacy-one")
    assert.notEqual(second.operation_id, first.operation_id)
    assert.equal(second.resource_id, "resource-two")
    assert.equal((await request("resource-one", "same-correlation")).operation_id, first.operation_id)
    assert.equal((await request("resource-two", "retry-two")).operation_id, second.operation_id)
    assert.equal((await store.latest({ tenantId, resourceId: "resource-one", connectionId }))?.operation_id, first.operation_id)
    assert.equal((await store.latest({ tenantId, resourceId: "resource-two", connectionId }))?.operation_id, second.operation_id)

    const claims = [
      await store.claimNext({ tenantId, gatewayId: "gateway-discovery", runtimeId: "runtime" }),
      await store.claimNext({ tenantId, gatewayId: "gateway-discovery", runtimeId: "runtime" }),
    ]
    assert.deepEqual(new Set(claims.map((claim) => claim?.operation_id)), new Set([first.operation_id, second.operation_id]))
    const firstCompleted = await store.complete({
      tenantId,
      runtimeId: "runtime",
      operationId: first.operation_id,
      result: { state: "SUCCEEDED", observation },
    })
    const candidate = firstCompleted.candidates[0]!
    await store.decideCandidate({
      tenantId,
      resourceId: "resource-one",
      connectionId,
      candidateId: candidate.candidate_id,
      expectedRevisionDigest: candidate.revision_digest,
      state: "IGNORED",
    })
    assert.equal((await request("resource-two", "still-active")).operation_id, second.operation_id)
    assert.notEqual((await request("resource-one", "next-one")).operation_id, first.operation_id)
    const secondCompleted = await store.complete({
      tenantId,
      runtimeId: "runtime",
      operationId: second.operation_id,
      result: { state: "SUCCEEDED", observation },
    })
    assert.equal(secondCompleted.candidates[0]?.state, "NEW")
  } finally {
    await sql.end({ timeout: 1 })
    await setup.query(`drop schema ${schema} cascade`)
    await setup.end({ timeout: 1 })
  }
})
