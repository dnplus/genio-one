import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotMemoryStore } from "./bot-memory"

test("memory survives reopen, stays Bot-scoped, rejects lost updates and supports forget/restore", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-memory-"))
  const path = join(dir, "memory.sqlite")
  let db = new Database(path)
  try {
    let store = new BotMemoryStore(db)
    const record = store.save("a", { key: "回答偏好", content: "繁體中文", kind: "preference" }, "user")
    expect(store.recall("b").memories).toHaveLength(0)
    db.close(); db = new Database(path); store = new BotMemoryStore(db)
    expect(store.recall("a").memories[0]).toMatchObject({ id: record.id, origin: "user", content: "繁體中文" })
    const updated = store.save("a", { key: record.key, content: "簡短的繁體中文", kind: "preference", expectedRevision: record.revision }, "bot")
    expect(() => store.save("a", { key: record.key, content: "過期修改", kind: "preference", expectedRevision: record.revision }, "user")).toThrow("BOT_MEMORY_CONFLICT")
    expect(() => store.setForgotten("b", updated.id, true, updated.revision)).toThrow("BOT_MEMORY_CONFLICT")
    const forgotten = store.setForgotten("a", updated.id, true, updated.revision)
    expect(store.recall("a").memories).toHaveLength(0)
    expect(store.list("a", true)).toHaveLength(1)
    store.setForgotten("a", forgotten.id, false, forgotten.revision)
    expect(store.recall("a", "簡短").memories).toHaveLength(1)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("retrieval has a bounded payload while keeping the full managed memory store", () => {
  const db = new Database(":memory:")
  try {
    const store = new BotMemoryStore(db)
    for (let i = 0; i < 30; i++) store.save("a", { key: `fact-${i}`, content: "資料".repeat(900), kind: "fact" }, "user")
    expect(store.list("a")).toHaveLength(30)
    expect(JSON.stringify(store.recall("a").memories).length).toBeLessThan(8100)
    expect(store.recall("a", "fact-25").memories[0]?.key).toBe("fact-25")
  } finally { db.close() }
})

test("confirmed decisions retain revision and forgetting semantics in bounded recall", () => {
  const db = new Database(":memory:")
  const memory = new BotMemoryStore(db)
  try {
    const decision = memory.save("bot", { key: "deployment", kind: "decision", content: "Deploy after review" }, "user")
    memory.save("bot", { key: "work", kind: "working_context", content: "Prepare review" }, "user")
    for (let i = 0; i < 20; i++) memory.save("bot", { key: `fact-${i}`, kind: "fact", content: "x".repeat(1900) }, "user")
    const selected = memory.recall("bot").memories
    expect(selected[0]?.kind).toBe("working_context")
    expect(selected.some((entry) => entry.id === decision.id)).toBe(true)
    const revision = memory.save("bot", { key: "deployment", kind: "decision", content: "Wait for approval", expectedRevision: decision.revision }, "user")
    expect(() => memory.save("bot", { key: "deployment", kind: "decision", content: "Outdated", expectedRevision: decision.revision }, "bot")).toThrow("BOT_MEMORY_CONFLICT")
    memory.setForgotten("bot", revision.id, true, revision.revision)
    expect(memory.recall("bot", "deployment").memories).toEqual([])
    expect(memory.recall("other-bot").memories).toEqual([])
  } finally { db.close() }
})
