import assert from "node:assert/strict"
import test from "node:test"

import type { SqlTransaction } from "../src/persistence/sql-adapter"
import { createInMemoryGatewayDiagnosticSettingsStore } from "../src/capabilities/gateway-settings/memory"
import { createPostgresGatewayDiagnosticSettingsSource } from "../src/capabilities/gateway-settings/postgres"

const tenantId = "tenant-acme"
const gatewayId = "gateway-a"

test("in-memory diagnostic settings default to content capture disabled and preserve explicit opt-in", async () => {
  const store = createInMemoryGatewayDiagnosticSettingsStore({ now: () => 1_800_000_000 })
  const input = { tenantId, gatewayId }
  const transaction: SqlTransaction = {
    async query() {
      throw new Error("in-memory settings must not query SQL")
    },
  }
  assert.equal((await store.get(input)).capture_message_content, false)
  assert.equal((await store.getInTransaction({ ...input, transaction })).capture_message_content, false)

  const enabled = await store.update({
    ...input,
    updatedBy: "admin",
    value: { capture_message_content: true },
  })
  assert.equal(enabled.capture_message_content, true)
  assert.equal((await store.get(input)).capture_message_content, true)
  assert.equal((await store.getInTransaction({ ...input, transaction })).capture_message_content, true)
})

test("Postgres diagnostic settings source defaults a missing row to content capture disabled", async () => {
  const transaction: SqlTransaction = {
    async query(_text, parameters) {
      assert.deepEqual(parameters, [tenantId, gatewayId])
      return { rows: [], rowCount: 0 }
    },
  }
  const settings = await createPostgresGatewayDiagnosticSettingsSource().getInTransaction({
    transaction,
    tenantId,
    gatewayId,
  })
  assert.deepEqual(settings, {
    tenant_id: tenantId,
    gateway_id: gatewayId,
    capture_message_content: false,
    row_revision: 1,
    updated_at: 0,
  })
})
