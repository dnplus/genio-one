import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import { createPostgresModelEntitlementCatalog } from "../src/capabilities/entitlements/postgres"
import { runMigrations } from "../src/persistence/migration-runner"
import {
  createPostgresSqlAdapter,
  type SqlAdapter,
  type SqlQueryResult,
  type SqlTransaction,
} from "../src/persistence/sql-adapter"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL

function barrier(count: number) {
  let arrived = 0
  let release: (() => void) | undefined
  const ready = new Promise<void>((resolve) => { release = resolve })
  return async () => {
    arrived += 1
    if (arrived === count) release?.()
    await ready
  }
}

function gateInitialIdempotencyLookup(sql: SqlAdapter, wait: () => Promise<void>): SqlAdapter {
  let pending = true
  return {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      parameters?: readonly unknown[],
    ): Promise<SqlQueryResult<Row>> {
      return sql.query<Row>(text, parameters)
    },
    async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
      return sql.transaction(async (transaction) => {
        const gated: SqlTransaction = {
          async query<Row extends Record<string, unknown> = Record<string, unknown>>(
            text: string,
            parameters?: readonly unknown[],
          ): Promise<SqlQueryResult<Row>> {
            const result = await transaction.query<Row>(text, parameters)
            if (
              pending &&
              text.includes("from genio_one_model_entitlements") &&
              text.includes("grant_idempotency_key") &&
              text.includes("limit 1")
            ) {
              pending = false
              await wait()
            }
            return result
          },
        }
        return work(gated)
      })
    },
  }
}

test(
  "PostgreSQL entitlement retry identity is concurrent, payload-bound, and window-safe",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    assert.ok(databaseUrl)
    const schema = `entitlement_grant_test_${randomUUID().replaceAll("-", "")}`
    const tenantId = `tenant-entitlement-${randomUUID().replaceAll("-", "")}`
    const admin = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 1, onnotice: () => {} } })
    const primary = createPostgresSqlAdapter({
      url: databaseUrl,
      options: { max: 1, connection: { search_path: schema }, onnotice: () => {} },
    })
    const secondary = createPostgresSqlAdapter({
      url: databaseUrl,
      options: { max: 1, connection: { search_path: schema }, onnotice: () => {} },
    })
    let schemaCreated = false
    let now = 100

    try {
      await admin.query(`create schema ${schema}`)
      schemaCreated = true
      await runMigrations(primary, { advisoryLockKey: schema })
      await primary.query(
        `insert into genio_one_organizations
           (tenant_id, organization_id, display_name, slug)
         values ($1, $2, $3, $4)`,
        [tenantId, "organization-test", "Entitlement Test", "entitlement-test"],
      )
      await primary.query(
        `insert into genio_one_resources
           (tenant_id, resource_id, display_name, kind, owner_organization_id,
            authentication_strategy, environment_id, version, capabilities, enforcement_point_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10)`,
        [
          tenantId,
          "resource-test",
          "Entitlement Test Resource",
          "MCP",
          "organization-test",
          "NONE",
          "test",
          "1.0.0",
          JSON.stringify([{ capability_id: "ticket.create", display_name: "Create ticket" }]),
          "gateway-test",
        ],
      )

      const wait = barrier(2)
      const first = createPostgresModelEntitlementCatalog({
        sql: gateInitialIdempotencyLookup(primary, wait),
        now: () => now,
      })
      const second = createPostgresModelEntitlementCatalog({
        sql: gateInitialIdempotencyLookup(secondary, wait),
        now: () => now,
      })
      const request = {
        subject_id: "subject-test",
        resource_id: "resource-test",
        capability_id: "ticket.create",
        expires_at: 200,
      }

      const [left, right] = await Promise.all([
        first.grant({ tenantId, value: request, idempotencyKey: "retry-concurrent" }),
        second.grant({ tenantId, value: request, idempotencyKey: "retry-concurrent" }),
      ])

      assert.equal(left.entitlement_id, right.entitlement_id)
      const grantCount = async () => {
        const result = await primary.query<{ count: string | number }>(
          `select count(*) as count
             from genio_one_model_entitlements
            where tenant_id = $1 and grant_idempotency_key = $2`,
          [tenantId, "retry-concurrent"],
        )
        return Number(result.rows[0]?.count)
      }
      assert.equal(await grantCount(), 1)

      await assert.rejects(
        first.grant({
          tenantId,
          value: { ...request, client_id: "client-test" },
          idempotencyKey: "retry-concurrent",
        }),
        (error: unknown) =>
          error instanceof PlatformApiError && error.code === "ENTITLEMENT_IDEMPOTENCY_KEY_REUSED",
      )

      now = 201
      const replayed = await first.grant({
        tenantId,
        value: request,
        idempotencyKey: "retry-concurrent",
      })
      assert.equal(replayed.entitlement_id, left.entitlement_id)
      assert.equal(await grantCount(), 1)
    } finally {
      try {
        await primary.end()
      } finally {
        try {
          await secondary.end()
        } finally {
          try {
            if (schemaCreated) await admin.query(`drop schema if exists ${schema} cascade`)
          } finally {
            await admin.end()
          }
        }
      }
    }
  },
)
