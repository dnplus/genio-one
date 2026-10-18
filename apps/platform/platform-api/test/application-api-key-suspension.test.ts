import assert from "node:assert/strict"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import { createPostgresIdentityDirectory } from "../src/capabilities/identity/postgres"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

type Row = Record<string, unknown>

class SubjectSql implements SqlAdapter {
  subject: Row = { subject_id: "application-subject-1", kind: "APPLICATION", display_name: "Integration", suspended_at: null, suspended_by: null, suspension_reason: null }
  readonly queries: Array<{ text: string; parameters: readonly unknown[] }> = []
  readonly gateways = ["gateway-a", "gateway-a", "gateway-b"]
  activeTransaction: SqlTransaction | null = null

  async query<Result extends Row = Row>(text: string, parameters: readonly unknown[] = []): Promise<SqlQueryResult<Result>> {
    this.queries.push({ text, parameters })
    if (text.includes("update genio_one_subjects")) {
      if (text.includes("coalesce(suspended_at")) this.subject = { ...this.subject, suspended_at: this.subject.suspended_at ?? new Date(1_000_000), suspended_by: this.subject.suspended_by ?? parameters[2], suspension_reason: this.subject.suspension_reason ?? parameters[3] }
      else this.subject = { ...this.subject, suspended_at: null, suspended_by: null, suspension_reason: null }
      return { rows: [structuredClone(this.subject)] as Result[], rowCount: 1 }
    }
    if (text.includes("select publication.gateway_id")) {
      return { rows: this.gateways.map(gateway_id => ({ gateway_id })) as unknown as Result[], rowCount: this.gateways.length }
    }
    throw new Error("Unexpected Subject SQL")
  }

  async transaction<Result>(work: (transaction: SqlTransaction) => Promise<Result>): Promise<Result> {
    const before = structuredClone(this.subject)
    const transaction: SqlTransaction = { query: (text, parameters) => this.query(text, parameters) }
    this.activeTransaction = transaction
    try { return await work(transaction) }
    catch (error) { this.subject = before; throw error }
    finally { this.activeTransaction = null }
  }
}

test("Application suspension and restoration reconcile each affected API key Gateway inside their owning transaction", async () => {
  const sql = new SubjectSql()
  const releases: Array<{ gatewayId: string; suspended: boolean }> = []
  const directory = createPostgresIdentityDirectory({ sql, now: () => 1_000, releasePublisher: {
    async reconcileInTransaction({ transaction, tenantId, gatewayId, issuedAt }) {
      assert.equal(transaction, sql.activeTransaction)
      assert.equal(tenantId, "tenant-acme")
      assert.equal(issuedAt, 1_000)
      releases.push({ gatewayId, suspended: sql.subject.suspended_at !== null })
    },
  } })
  const first = await directory.suspend({ tenantId: "tenant-acme", subjectId: "application-subject-1", suspendedBy: "person-admin", value: { reason: "Suspended integration" } })
  assert.equal(first.suspended, true)
  assert.deepEqual(releases, [{ gatewayId: "gateway-a", suspended: true }, { gatewayId: "gateway-b", suspended: true }])
  const repeated = await directory.suspend({ tenantId: "tenant-acme", subjectId: "application-subject-1", suspendedBy: "person-other", value: { reason: "Repeat" } })
  assert.equal(repeated.suspended_at, first.suspended_at)
  assert.equal(repeated.suspended_by, "person-admin")
  assert.equal(releases.length, 4)
  const restored = await directory.restore({ tenantId: "tenant-acme", subjectId: "application-subject-1" })
  assert.equal(restored.suspended, false)
  assert.deepEqual(releases.slice(-2), [{ gatewayId: "gateway-a", suspended: false }, { gatewayId: "gateway-b", suspended: false }])
  const scope = sql.queries.find(query => query.text.includes("select publication.gateway_id"))!
  assert.match(scope.text, /application.subject_id = credential.application_subject_id/)
  assert.match(scope.text, /credential.state = 'ACTIVE'/)
  assert.match(scope.text, /credential.state = 'RETIRED' and credential.valid_until > now\(\)/)
  assert.match(scope.text, /credential.expires_at > now\(\)/)
  assert.deepEqual(scope.parameters, ["tenant-acme", "application-subject-1"])
})

test("a failed or unavailable API key Gateway publisher rolls back the Subject state", async () => {
  const sql = new SubjectSql()
  const failing = createPostgresIdentityDirectory({ sql, releasePublisher: { async reconcileInTransaction() { throw new Error("failed release") } } })
  await assert.rejects(failing.suspend({ tenantId: "tenant-acme", subjectId: "application-subject-1", suspendedBy: "person-admin", value: {} }), /failed release/)
  assert.equal(sql.subject.suspended_at, null)
  const absent = createPostgresIdentityDirectory({ sql })
  await assert.rejects(absent.suspend({ tenantId: "tenant-acme", subjectId: "application-subject-1", suspendedBy: "person-admin", value: {} }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "GATEWAY_RELEASE_PUBLISHER_REQUIRED")
  assert.equal(sql.subject.suspended_at, null)
  sql.gateways.length = 0
  assert.equal((await absent.suspend({ tenantId: "tenant-acme", subjectId: "application-subject-1", suspendedBy: "person-admin", value: {} })).suspended, true)
})
