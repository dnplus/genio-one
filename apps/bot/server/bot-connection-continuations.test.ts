import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BotConnectionContinuations } from "./bot-connection-continuations"
import type { Turn } from "./generated/v2/Turn"

test("reopens an uncertain continuation and reconciles the accepted native client ID before any retry", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-connection-continuation-"))
  const path = join(directory, "state.sqlite")
  let db = new Database(path)
  try {
    let store = new BotConnectionContinuations(db)
    store.enqueue({
      requestToken: "connection-request",
      botId: "bot",
      tenantId: "tenant",
      ownerSubjectId: "owner",
      sourceThreadId: "thread",
      sourceTurnId: "source-turn",
      resourceId: "notion",
      resourceName: "Notion",
      capabilityId: "notion.search",
    })
    store.markMcpReloaded("connection-request", ["genio_mcp_notion"])
    expect(store.claim("connection-request")).toBe(true)
    const clientId = store.get("connection-request").clientId
    db.close()
    db = new Database(path)
    store = new BotConnectionContinuations(db)
    const recovered = store.pending()[0]!
    expect(recovered).toMatchObject({ state: "starting", clientId })
    expect(store.reconcile(recovered, [{
      id: "continued-turn",
      status: "completed",
      itemsView: "full",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      items: [{ type: "userMessage", id: "continued-input", clientId, content: [] }],
    } as Turn])).toBe(true)
    expect(store.pending()).toHaveLength(0)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
