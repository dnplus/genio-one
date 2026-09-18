import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotRegistry } from "./bot-registry"

test("runtime loss leaves durable expiry evidence without reviving request authority", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-interactions-"))
  const path = join(dir, "registry.sqlite")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  let registry = new BotRegistry(path)
  try {
    const bot = registry.create(principal, { name: "A", description: "Recovery" })
    registry.rememberThread(bot.id, "thread")
    const question = JSON.stringify({ id: 7, method: "item/tool/requestUserInput", params: { threadId: "thread", turnId: "turn", questions: [{ question: "A or B?" }] } })
    registry.recordRuntimeEvent({ ...principal, subject_id: "other" }, question, "foreign")
    registry.recordRuntimeEvent(principal, question, "old")
    registry.recordRuntimeEvent(principal, question, "old")
    expect(registry.readTimeline(principal, bot.id, (id) => id === "old")).toEqual([])
    registry.close()
    registry = new BotRegistry(path)
    const expired = registry.readTimeline(principal, bot.id, (id) => id === "new")
    expect(expired).toHaveLength(1)
    expect(expired[0]?.text).toContain("已因執行環境結束而失效")
    expect(expired[0]).not.toHaveProperty("genioRequestToken")
    expect(() => registry.readTimeline({ ...principal, subject_id: "other" }, bot.id)).toThrow("BOT_NOT_FOUND")
    registry.recordRuntimeEvent(principal, question, "new")
    registry.recordRuntimeEvent(principal, JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: 7 } }), "new")
    expect(registry.readTimeline(principal, bot.id)).toEqual(expired)
  } finally {
    registry.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
