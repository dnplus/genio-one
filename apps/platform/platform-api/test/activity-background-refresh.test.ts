import assert from "node:assert/strict"
import test from "node:test"

import {
  createSingleFlightGatewayActivityMaterializer,
  startGatewayActivityBackgroundRefresh,
} from "../src/capabilities/activities/background-refresh"

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

test("Activity materializer shares concurrent refreshes for one tenant", async () => {
  const started = deferred<void>()
  const completed = deferred<void>()
  let calls = 0
  const materializer = createSingleFlightGatewayActivityMaterializer({
    async refresh() {
      calls += 1
      started.resolve()
      await completed.promise
    },
  })

  const first = materializer.refresh({ tenantId: "tenant-acme" })
  const second = materializer.refresh({ tenantId: "tenant-acme" })
  await started.promise

  assert.strictEqual(second, first)
  assert.equal(calls, 1)

  completed.resolve()
  await Promise.all([first, second])
})

test("background Activity refresh materializes enabled tenants despite another tenant failure", async () => {
  const bothStarted = deferred<void>()
  const completed = deferred<void>()
  const failureReported = deferred<void>()
  const calls: string[] = []
  const failures: Array<string | undefined> = []
  const materializer = createSingleFlightGatewayActivityMaterializer({
    async refresh({ tenantId }) {
      calls.push(tenantId)
      if (calls.length === 2) bothStarted.resolve()
      await completed.promise
      if (tenantId === "tenant-failed") throw new Error("ClickHouse unavailable")
    },
  })
  const refresh = startGatewayActivityBackgroundRefresh({
    materializer,
    integrations: {
      async listEnabledTenantIds() {
        return ["tenant-failed", "tenant-healthy"]
      },
    },
    reportFailure({ tenantId }) {
      failures.push(tenantId)
      failureReported.resolve()
    },
  })

  try {
    await bothStarted.promise
    assert.deepEqual(calls, ["tenant-failed", "tenant-healthy"])

    completed.resolve()
    await failureReported.promise

    assert.deepEqual(failures, ["tenant-failed"])
  } finally {
    refresh.stop()
  }
})
