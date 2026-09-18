import assert from "node:assert/strict"
import test from "node:test"

import type { GatewayPublicationReleaseCoordinator } from "../src/capabilities/gateway-policy-release/publication-commit"
import { createGatewayPolicyReleaseRenewal } from "../src/capabilities/gateway-policy-release/renewal"
import type {
  SqlAdapter,
  SqlQueryResult,
  SqlTransaction,
} from "../src/persistence/sql-adapter"

type Row = Record<string, unknown>

class RenewalSql implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []
  private selected = false

  async query<Result extends Row = Row>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    if (!text.includes("from genio_one_gateway_policy_release_heads")) {
      return { rows: [], rowCount: 0 }
    }
    if (this.selected) return { rows: [], rowCount: 0 }
    this.selected = true
    const rows = [{ tenant_id: "tenant-active", gateway_id: "gateway-active" }]
    return { rows: rows as unknown as Result[], rowCount: rows.length }
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

test("renewal selects only due releases with an active aggregate Gateway Runtime", async () => {
  const sql = new RenewalSql()
  const reconciled: Array<{ tenantId: string; gatewayId: string; issuedAt: number }> = []
  const coordinator: GatewayPublicationReleaseCoordinator = {
    async commitInTransaction() {
      throw new Error("unexpected publication commit")
    },
    async reconcileInTransaction(input) {
      reconciled.push({
        tenantId: input.tenantId,
        gatewayId: input.gatewayId,
        issuedAt: input.issuedAt,
      })
      return { release_id: "release-active", deliveries: [] }
    },
  }
  const renewal = createGatewayPolicyReleaseRenewal({
    sql,
    coordinator,
    now: () => 1_800_000_000,
    releaseTtlSeconds: 600,
    renewBeforeSeconds: 120,
  })

  assert.equal(await renewal.renewDue(), 1)
  assert.deepEqual(reconciled, [{
    tenantId: "tenant-active",
    gatewayId: "gateway-active",
    issuedAt: 1_800_000_000,
  }])
  const selection = sql.calls.find((call) =>
    call.text.includes("from genio_one_gateway_policy_release_heads"),
  )
  assert.ok(selection)
  assert.match(selection.text, /runtime_registration\.status = 'ACTIVE'/)
  assert.match(selection.text, /runtime_capability\.delivery_mode = 'AGGREGATE_RELEASE'/)
  assert.deepEqual(selection.parameters, [1_800_000_120])
})
