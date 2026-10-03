import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { createPostgresResourceConnectionRegistry } from "../src/capabilities/connections/postgres"
import { PlatformApiError } from "../src/capabilities/errors"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL

test("PostgreSQL Connection health enforces the reporting Gateway assignment atomically", {
  skip: databaseUrl ? false : "GENIO_ONE_TEST_DATABASE_URL is required",
  timeout: 15_000,
}, async () => {
  assert.ok(databaseUrl)
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname))
  const schema = `connectionhealthqa_${randomUUID().replaceAll("-", "")}`
  const setup = createPostgresSqlAdapter({ url: databaseUrl })
  let schemaCreated = false
  let sql: ReturnType<typeof createPostgresSqlAdapter> | undefined

  try {
    await setup.query(`create schema ${schema}`)
    schemaCreated = true
    sql = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 2, connection: { search_path: schema } } })
    await sql.query(`
      create table genio_one_resources (
        tenant_id text not null,
        resource_id text not null,
        owner_organization_id text,
        kind text not null default 'MCP',
        lifecycle text not null default 'PUBLISHED',
        row_revision bigint not null default 1,
        installation_owned boolean not null default false,
        service_kind text,
        primary key (tenant_id, resource_id)
      );
      create table genio_one_resource_connections (
        tenant_id text not null,
        resource_id text not null,
        connection_id text not null,
        display_name text not null default 'Health target',
        connection_kind text not null default 'MCP',
        provider_type text,
        provider_profile_id text,
        endpoint text not null default 'https://backend.example.test',
        mcp_tool_namespace text,
        mcp_selected_tools text[] not null default '{}',
        mcp_tool_selection_operation_id text,
        mcp_tool_reviews jsonb not null default '[]',
        credential_ref text,
        provider_credential_profile_id text,
        provider_credential_profile_revision bigint,
        provider_credential_strategy_digest text,
        downstream_identity jsonb not null default '{"mode":"NONE"}',
        connector_configuration jsonb,
        request_mapping jsonb,
        certificate_mode text not null default 'SYSTEM_CA',
        certificate_pem text,
        certificate_fingerprint_sha256 text,
        certificate_subject text,
        certificate_issuer text,
        certificate_is_self_signed boolean not null default false,
        certificate_not_before timestamptz,
        certificate_not_after timestamptz,
        status text not null default 'READY',
        configuration_revision bigint not null default 1,
        lifecycle text not null default 'ENABLED',
        revoke_requested_after_release_revision bigint,
        verification_state text not null default 'VERIFIED',
        health_state text not null default 'UNKNOWN',
        health_observed_at timestamptz,
        health_source_revision bigint not null default 1,
        routing_priority integer not null default 0,
        region text,
        supported_obligations text[] not null default '{}',
        row_revision bigint not null default 1,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (tenant_id, resource_id, connection_id)
      );
      create table genio_one_publications (
        tenant_id text not null,
        resource_id text not null,
        gateway_id text not null,
        publication_state text not null
      )
    `)
    const tenantId = "tenant-health-qa"
    await sql.query(
      `insert into genio_one_resources (tenant_id, resource_id) values ($1, 'resource-a'), ($1, 'resource-z-b')`,
      [tenantId],
    )
    await sql.query(
      `insert into genio_one_resource_connections (tenant_id, resource_id, connection_id)
       values ($1, 'resource-a', 'connection-a'), ($1, 'resource-z-b', 'connection-b')`,
      [tenantId],
    )
    await sql.query(
      `insert into genio_one_publications (tenant_id, resource_id, gateway_id, publication_state)
       values ($1, 'resource-a', 'gateway-a', 'PUBLISHED'),
              ($1, 'resource-z-b', 'gateway-b', 'DEPRECATED')`,
      [tenantId],
    )
    const reconciles: string[] = []
    const connections = createPostgresResourceConnectionRegistry({
      sql,
      providers: {} as never,
      now: () => 100,
      releasePublisher: {
        async reconcileInTransaction(input) {
          reconciles.push(input.gatewayId)
        },
      },
    })
    const observation = { correlation_id: "health-qa", source_revision: 2, state: "HEALTHY" as const, observed_at: 100 }
    await assert.rejects(
      connections.observeHealth({
        tenantId,
        gatewayId: "gateway-a",
        resourceId: "resource-z-b",
        connectionId: "connection-b",
        value: observation,
      }),
      (error: unknown) => error instanceof PlatformApiError && error.code === "CONNECTION_HEALTH_TARGET_UNASSIGNED" && error.statusCode === 403,
    )
    await assert.rejects(
      connections.observeHealthBatch({
        tenantId,
        gatewayId: "gateway-a",
        value: {
          correlation_id: "health-mixed-qa",
          observations: [
            { resource_id: "resource-a", connection_id: "connection-a", source_revision: 2, state: "HEALTHY", observed_at: 100 },
            { resource_id: "resource-z-b", connection_id: "connection-b", source_revision: 2, state: "HEALTHY", observed_at: 100 },
          ],
        },
      }),
      (error: unknown) => error instanceof PlatformApiError && error.code === "CONNECTION_HEALTH_TARGET_UNASSIGNED" && error.statusCode === 403,
    )
    const rejectedState = await sql.query<{ resource_id: string; health_state: string; health_source_revision: string }>(
      `select resource_id, health_state, health_source_revision
         from genio_one_resource_connections where tenant_id = $1 order by resource_id`,
      [tenantId],
    )
    assert.deepEqual(rejectedState.rows.map((row) => [row.resource_id, row.health_state, Number(row.health_source_revision)]), [
      ["resource-a", "UNKNOWN", 1],
      ["resource-z-b", "UNKNOWN", 1],
    ])
    assert.deepEqual(reconciles, [])

    const valid = await connections.observeHealth({
      tenantId,
      gatewayId: "gateway-a",
      resourceId: "resource-a",
      connectionId: "connection-a",
      value: observation,
    })
    assert.equal(valid.health_state, "HEALTHY")
    assert.equal(valid.health_source_revision, 2)
    assert.deepEqual(reconciles, ["gateway-a"])
  } finally {
    await sql?.end({ timeout: 1 })
    if (schemaCreated) await setup.query(`drop schema ${schema} cascade`)
    await setup.end({ timeout: 1 })
  }
})
