import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotContinuations } from "./bot-continuations"
import type { BotInvocationRequest } from "./bot-invocation-store"
import type { Turn } from "./generated/v2/Turn"

test("unsuccessful terminal outcomes are durable and deduplicated without being labeled successful", () => {
  const db = new Database(":memory:")
  const store = new BotContinuations(db)
  try {
    for (const state of ["FAILED", "DENIED", "EXPIRED"] as const) {
      const invocation = { requestId: state, callerBotId: "caller", tenantId: "tenant", callerSubjectId: "owner", targetBotId: "peer", task: "Original", resultSummary: null, decisionReason: "Not completed", state } as BotInvocationRequest
      store.enqueue(invocation)
      store.enqueue(invocation)
      expect(store.pending().find((entry) => entry.invocation_id === state)?.outcome).toBe(state)
    }
    expect(store.pending()).toHaveLength(3)
    expect(store.pending().every((entry) => entry.result === "Not completed")).toBe(true)
  } finally { db.close() }
})

test("uncertain continuation survives database reopen and reconciles the accepted native client ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-continuation-"))
  const path = join(dir, "state.sqlite")
  let db = new Database(path)
  try {
    let store = new BotContinuations(db)
    const invocation = { requestId: "invocation", callerBotId: "caller", tenantId: "tenant", callerSubjectId: "owner", targetBotId: "peer", task: "Original task", resultSummary: "Result", state: "COMPLETED" } as BotInvocationRequest
    store.enqueue(invocation)
    store.enqueue(invocation)
    expect(store.claim("invocation", "thread")).toBe(true)
    expect(store.claim("invocation", "thread")).toBe(false)
    db.close()
    db = new Database(path)
    store = new BotContinuations(db)
    const entry = store.pending()[0]!
    expect(entry.state).toBe("starting")
    expect(store.reconcile(entry, [{ id: "turn", status: "completed", itemsView: "full", error: null, startedAt: 1, completedAt: 2, durationMs: 1000, items: [{ type: "userMessage", id: "user", clientId: entry.client_id, content: [] }] } as Turn])).toBe(true)
    expect(store.pending()).toHaveLength(0)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
