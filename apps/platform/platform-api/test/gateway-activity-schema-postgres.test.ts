import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"

const url = process.env.GENIO_ONE_TEST_DATABASE_URL

test(
  "Gateway Activity migrations accept USER_PASSWORD and reject unknown identity modes after replay",
  { skip: !url },
  async () => {
    assert.ok(url)
    const schema = `gateway_activity_schema_${randomUUID().replaceAll("-", "")}`
    const admin = createPostgresSqlAdapter({ url, options: { max: 1, onnotice: () => {} } })
    const sql = createPostgresSqlAdapter({
      url,
      options: { max: 2, connection: { search_path: schema }, onnotice: () => {} },
    })

    try {
      await admin.query(`create schema ${schema}`)
      const first = await runMigrations(sql, { advisoryLockKey: schema })
      assert.equal(first.applied.at(-1), 16)
      assert.deepEqual(first.skipped, [])

      const second = await runMigrations(sql, { advisoryLockKey: schema })
      assert.deepEqual(second.applied, [])
      assert.equal(second.skipped.at(-1), 16)

      await sql.query(`
        create table gateway_activity_mode_probe (
          like genio_one_gateway_activities including defaults including constraints
        )
      `)
      const foreignKeys = await sql.query<{ count: string }>(`
        select count(*)::text as count
        from pg_constraint
        where conrelid = 'gateway_activity_mode_probe'::regclass
          and contype = 'f'
      `)
      assert.equal(Number(foreignKeys.rows[0]?.count), 0)

      const activityConstraint = await sql.query<{ definition: string }>(`
        select pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conrelid = 'genio_one_gateway_activities'::regclass
          and conname = 'genio_one_gateway_activities_downstream_identity_mode_check'
      `)
      assert.equal(activityConstraint.rows.length, 1)
      assert.match(activityConstraint.rows[0].definition, /USER_PASSWORD/)

      await sql.query(`
        insert into gateway_activity_mode_probe (
          tenant_id,
          correlation_id,
          resource_id,
          enforcement_point_id,
          route,
          method,
          path,
          status_code,
          outcome,
          upstream_attempted,
          detail_availability,
          occurred_at,
          downstream_identity_mode
        ) values ($1, $2, $3, $4, 'MANAGED', 'POST', '/mcp', 200, 'COMPLETED', true, 'AVAILABLE', 1, 'USER_PASSWORD')
      `, ["tenant-1", "correlation-valid", "resource-1", "enforcement-1"])

      await assert.rejects(
        () => sql.query(`
          insert into gateway_activity_mode_probe (
            tenant_id,
            correlation_id,
            resource_id,
            enforcement_point_id,
            route,
            method,
            path,
            status_code,
            outcome,
            upstream_attempted,
            detail_availability,
            occurred_at,
            downstream_identity_mode
          ) values ($1, $2, $3, $4, 'MANAGED', 'POST', '/mcp', 200, 'COMPLETED', true, 'AVAILABLE', 1, 'USER_CERTIFICATE')
        `, ["tenant-1", "correlation-invalid", "resource-1", "enforcement-1"]),
        /downstream_identity_mode_check/,
      )
    } finally {
      await sql.end()
      await admin.query(`drop schema if exists ${schema} cascade`)
      await admin.end()
    }
  },
)
