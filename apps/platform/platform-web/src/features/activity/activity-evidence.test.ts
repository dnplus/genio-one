import assert from "node:assert/strict"
import test from "node:test"

import {
  loadActivityEvidence,
  type ActivityEvidenceLoaders,
} from "@/features/activity/activity-evidence"
import { ProductApiError } from "@/lib/product-api"
import { createMockOverview } from "@/mocks/overview"

test("Activity Evidence owns correlation fan-out, fallback, errors, and labels", async () => {
  const data = createMockOverview()
  const event = { ...data.apiActivity.events[0]!, session_id: "session-1" }
  const calls: string[] = []
  const reject = (source: string) => {
    calls.push(source)
    return Promise.reject(new Error(`${source} unavailable`))
  }
  const loaders = {
    detail: () => reject("detail"),
    outcomes: () => reject("outcomes"),
    session: () => reject("session"),
    routing: () => reject("routing"),
    accounting: () => reject("accounting"),
  } as unknown as ActivityEvidenceLoaders

  const evidence = await loadActivityEvidence({
    tenantId: event.tenant_id,
    event,
    data,
    loaders,
  })

  assert.deepEqual(new Set(calls), new Set(["detail", "outcomes", "session", "routing", "accounting"]))
  assert.equal(evidence.detail.correlation_id, event.correlation_id)
  assert.equal(evidence.reconstruction, null)
  assert.equal(evidence.sessionTimeline, null)
  assert.deepEqual(evidence.accounting, [])
  assert.deepEqual(evidence.outcomeAttributions, [])
  assert.deepEqual(Object.keys(evidence.errors).sort(), ["accounting", "detail", "outcomes", "routing", "session"])
  assert.equal(evidence.display.resource(event.resource_id).resolved, true)
})

test("Missing or expired transaction detail uses the immutable activity fallback", async () => {
  const data = createMockOverview()
  const event = {
    ...data.apiActivity.events[0]!,
    detail_availability: "AVAILABLE" as const,
    detail_expires_at: Math.floor(Date.now() / 1_000) + 60,
    session_id: null,
  }
  let detailCalls = 0
  let sessionCalls = 0
  const loaders = {
    detail: async () => {
      detailCalls += 1
      throw new ProductApiError("NOT_FOUND", 404)
    },
    outcomes: async () => [],
    session: async () => {
      sessionCalls += 1
      throw new Error("unexpected session load")
    },
    routing: async () => null,
    accounting: async () => [],
  } as unknown as ActivityEvidenceLoaders

  const evidence = await loadActivityEvidence({
    tenantId: event.tenant_id,
    event,
    data,
    loaders,
  })

  assert.equal(detailCalls, 1)
  assert.equal(sessionCalls, 0)
  assert.equal(evidence.detail.availability, "AVAILABLE")
  assert.equal(evidence.detail.request, null)
  assert.equal(evidence.errors.detail, undefined)
})
