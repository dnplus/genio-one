import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { BotRegistry } from "./bot-registry"
import type { Turn } from "./generated/v2/Turn"
import type { BotHandoffEvent } from "./bot-handoff"

const principal = { tenant_id: "timeline-tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
let registry: BotRegistry | undefined
afterEach(() => registry?.close())

test.each(["completed", "interrupted"] as const)("restored %s history repairs stale working state without repeated unread", (status) => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "Restore state" })
  registry.rememberThread(bot.id, "thread")
  registry.recordRuntimeEvent(principal, JSON.stringify({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn", startedAt: 10, status: "inProgress", items: [] } } }))
  const revision = registry.timeline.revision()
  const restored = { id: "turn", startedAt: 10, status, items: [] } as unknown as Turn
  registry.importRuntimeHistory(bot.id, "thread", [restored], revision)
  expect(registry.getSession(bot.id)?.workState).toBe(status === "completed" ? "idle" : "stopped")
  expect(registry.getSession(bot.id)?.unread).toBe(true)
  registry.applySessionEvent(bot.id, "viewed")
  registry.importRuntimeHistory(bot.id, "thread", [restored], revision)
  expect(registry.getSession(bot.id)?.unread).toBe(false)
})

test("late restore cannot hide a newer live turn or resurrect its completed state", () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "Concurrent restore" })
  registry.rememberThread(bot.id, "thread")
  registry.saveSession({ botId: bot.id, appServerThreadId: "thread" })
  const revision = registry.timeline.revision()
  registry.recordRuntimeEvent(principal, JSON.stringify({ method: "turn/started", params: { threadId: "thread", turn: { id: "new", startedAt: 20, status: "inProgress", items: [] } } }))
  registry.importRuntimeHistory(bot.id, "thread", [{ id: "old", startedAt: 10, status: "completed", items: [] } as unknown as Turn], revision)
  expect(registry.getSession(bot.id)?.workState).toBe("working")
  registry.recordRuntimeEvent(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "new", status: "completed", items: [] } } }))
  registry.applySessionEvent(bot.id, "viewed")
  registry.importRuntimeHistory(bot.id, "thread", [{ id: "new", startedAt: 20, status: "inProgress", items: [] } as unknown as Turn], revision)
  expect(registry.getSession(bot.id)?.workState).toBe("idle")
  expect(registry.getSession(bot.id)?.unread).toBe(false)
})

test("one completed or stopped turn cannot hide another running Bot turn", () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "Concurrent work" })
  registry.rememberThread(bot.id, "a")
  registry.rememberThread(bot.id, "b")
  const event = (threadId: string, method: string, status: string) => registry!.recordRuntimeEvent(principal, JSON.stringify({ method, params: { threadId, turn: { id: `turn-${threadId}`, status, items: [] } } }))
  event("a", "turn/started", "inProgress")
  event("b", "turn/started", "inProgress")
  event("a", "turn/completed", "interrupted")
  expect(registry.getSession(bot.id)?.workState).toBe("working")
  registry.applySessionEvent(bot.id, "viewed")
  event("a", "turn/completed", "interrupted")
  expect(registry.getSession(bot.id)?.unread).toBe(false)
  expect(registry.getSession(bot.id)?.workState).toBe("working")
  registry.applySessionEvent(bot.id, "turn_completed")
  expect(registry.getSession(bot.id)?.workState).toBe("working")
  event("b", "turn/completed", "completed")
  expect(registry.getSession(bot.id)?.workState).toBe("idle")
  expect(registry.getSession(bot.id)?.unread).toBe(true)
  event("a", "turn/started", "inProgress")
  expect(registry.getSession(bot.id)?.workState).toBe("idle")
})

test("roster preview follows latest original history rather than import or viewed time", () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "Fallback" })
  const turn = (id: string, startedAt: number, text: string) => ({ id, startedAt, status: "completed", items: [{ id, type: "agentMessage", text }] } as Turn)
  registry.timeline.putTurn(bot.id, "new", turn("latest", 200, "Latest reply"))
  registry.timeline.putTurn(bot.id, "old", turn("backfill", 100, "Imported later"))
  const summary = registry.listRoster(principal)[0]!.summary
  expect(summary).toEqual({ preview: "Latest reply", timestamp: 200_000 })
  registry.applySessionEvent(bot.id, "viewed")
  expect(registry.listRoster(principal)[0]!.summary).toEqual(summary)
  expect(registry.listRoster({ ...principal, subject_id: "other" })).toHaveLength(0)
  registry.timeline.putTurn(bot.id, "new", { ...turn("latest", 200, "Latest reply"), completedAt: 205 })
  expect(registry.timeline.sidebarSummary(bot.id, [{ visibility: "visible", createdAt: 203_000, fact: "Task delivered" } as BotHandoffEvent]))
    .toEqual({ preview: "Latest reply", timestamp: 205_000 })
})

test("failed handoffs remain failed and cannot be overwritten by a late completion", () => {
  registry = new BotRegistry(":memory:")
  const caller = registry.create(principal, { name: "A", description: "Caller" })
  const target = registry.create(principal, { name: "B", description: "Target" })
  const handoff = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "測試工作" })[0]!
  registry.processHandoff(principal, handoff.handoffId)
  registry.beginInvocation(handoff.invocationId)
  registry.failInvocation(handoff.invocationId, "TIMEOUT", "對方執行逾時。")
  registry.completeInvocation(handoff.invocationId, "遲到的成功")
  expect(registry.getInvocationForService(handoff.invocationId)?.state).toBe("FAILED")
  const events = registry.listHandoffEvents(principal, caller.id)
  expect(events.filter((event) => event.type === "handoff.failed")).toHaveLength(1)
  expect(events.some((event) => event.type === "handoff.replied")).toBe(false)
  expect(registry.readTimeline(principal, caller.id)[0]?.handoffEventType).toBe("handoff.failed")
})

test("history requested before live completion cannot rewind content and late deltas cannot extend completed items", () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "Concurrent recovery" })
  registry.rememberThread(bot.id, "thread")
  const event = (method: string, params: Record<string, unknown>) => registry!.recordRuntimeEvent(principal, JSON.stringify({ method, params: { threadId: "thread", turnId: "turn", ...params } }))
  event("turn/started", { turn: { id: "turn", status: "inProgress", startedAt: 1000, items: [] } })
  const beforeRead = registry.timeline.revision()
  event("item/completed", { item: { type: "agentMessage", id: "answer", text: "已完成" } })
  const completed = registry.readTimeline(principal, bot.id)[0]!
  event("item/agentMessage/delta", { itemId: "answer", delta: "遲到內容" })
  registry.timeline.importSnapshot(bot.id, "thread", { id: "turn", status: "inProgress", startedAt: 1000, items: [{ type: "agentMessage", id: "answer", text: "已" }] } as Turn, beforeRead)
  expect(registry.readTimeline(principal, bot.id)[0]).toEqual(completed)
  event("turn/completed", { turn: { id: "turn", status: "completed", items: [] } })
  const terminal = registry.readTimeline(principal, bot.id)[0]!
  expect(terminal.timelineRevision).toBeGreaterThan(completed.timelineRevision!)
  event("turn/started", { turn: { id: "turn", status: "inProgress", items: [] } })
  event("item/agentMessage/delta", { itemId: "answer", delta: "重播" })
  expect(registry.readTimeline(principal, bot.id)[0]).toEqual(terminal)
})

test("legacy import is repeatable and cannot masquerade as native history", () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "Legacy owner" })
  const entries = [0, 1].map((position) => ({ sourceKey: `genio.bot.messages.${bot.id}.old`, position, message: { role: "user", text: "相同內容", id: "old", runtimeThreadId: "forged", createdAt: 1000 } }))
  registry.timeline.importLegacy(bot.id, entries)
  registry.timeline.importLegacy(bot.id, entries)
  const messages = registry.readTimeline(principal, bot.id)
  expect(messages).toHaveLength(2)
  expect(messages[0]?.id).not.toBe(messages[1]?.id)
  expect(messages[0]?.runtimeThreadId).toBeUndefined()
  expect(messages[0]?.createdAt).toBe(1000)
  expect(registry.ownsThread(principal, bot.id, "forged")).toBe(false)
  expect(() => registry!.timeline.importLegacy(bot.id, [...entries, { sourceKey: "other", position: 0, message: {} }])).toThrow()
  expect(registry.readTimeline(principal, bot.id)).toHaveLength(2)
  registry.rememberThread(bot.id, "native")
  registry.recordRuntimeEvent(principal, JSON.stringify({ method: "item/completed", params: { threadId: "native", turnId: "turn", item: { type: "userMessage", id: "user", content: [{ type: "text", text: "相同內容" }] } } }))
  registry.timeline.importLegacy(bot.id, [{ ...entries[0], position: 2, message: { role: "user", text: "相同內容", id: "user", runtimeThreadId: "native" } }])
  const afterNative = registry.readTimeline(principal, bot.id)
  expect(afterNative).toHaveLength(3)
  expect(afterNative.filter((message) => message.kind === "legacy")).toHaveLength(2)
})

test("server timeline retains a background reply and merges snapshots by native identity", () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "Timeline owner" })
  registry.rememberThread(bot.id, "thread-a")
  const event = (method: string, params: Record<string, unknown>) => registry!.recordRuntimeEvent(principal, JSON.stringify({ method, params: { threadId: "thread-a", turnId: "turn-a", ...params } }))
  event("turn/started", { turn: { id: "turn-a", status: "inProgress", startedAt: 1788700000, items: [] } })
  event("item/agentMessage/delta", { itemId: "answer", delta: "保留" })
  event("item/agentMessage/delta", { itemId: "answer", delta: "結果" })
  event("item/completed", { item: { type: "agentMessage", id: "answer", text: "保留結果" } })
  event("turn/completed", { turn: { id: "turn-a", status: "completed", items: [] } })
  const timeline = registry.readTimeline(principal, bot.id)
  expect(timeline).toHaveLength(1)
  expect(timeline[0]).toMatchObject({ id: "thread-a:answer", text: "保留結果", role: "assistant", createdAt: 1788700000000 })
  event("item/completed", { item: { type: "agentMessage", id: "answer", text: "保留結果" } })
  expect(registry.readTimeline(principal, bot.id)).toEqual(timeline)
})

test("MCP HTML artifacts are verified, retained in durable timeline, and excluded from tool text", () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "A", description: "Architecture review" })
  const text = "<!doctype html><title>CE architecture</title><main>diagram</main>"
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex")
  const valid = { name: "ce-architecture.html", mimeType: "text/html", text, sha256 }
  const invalid = { name: "../unsafe.html", mimeType: "text/html", text, sha256 }
  registry.timeline.putTurn(bot.id, "thread", {
    id: "turn",
    status: "completed",
    itemsView: "full",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    error: null,
    items: [{
      type: "mcpToolCall",
      id: "archify",
      server: "archify",
      tool: "render",
      status: "completed",
      arguments: {},
      appContext: null,
      mcpAppResourceUri: undefined,
      pluginId: null,
      readOnlyHint: true,
      result: { content: [{ type: "text", text: "架構圖已產生" }], structuredContent: { diagram: "ce" }, _meta: { "genio/artifacts": [valid, invalid] } },
      error: null,
      durationMs: 10,
    }],
  })
  const item = registry.readTimeline(principal, bot.id)[0]?.runtimeItem
  expect(item?.type).toBe("mcpToolCall")
  if (item?.type !== "mcpToolCall") throw new Error("MCP artifact missing")
  expect(item.result?._meta).toEqual({ "genio/artifacts": [valid] })
  expect(registry.readTimeline(principal, bot.id)[0]?.text).toBe("工具執行")
})

test("Bot ownership gates history and handoff replies do not become user messages", () => {
  registry = new BotRegistry(":memory:")
  const from = registry.create(principal, { name: "A", description: "Caller" })
  const to = registry.create(principal, { name: "B", description: "Receiver" })
  registry.rememberThread(from.id, "thread-a")
  expect(registry.ownsThread(principal, to.id, "thread-a")).toBe(false)
  expect(() => registry!.readTimeline({ ...principal, subject_id: "other" }, from.id)).toThrow("BOT_NOT_FOUND")
  const handoff = registry.handoffs.createHandoff(principal, { fromBotId: from.id, toBotId: to.id, fact: "確認結果" })
  registry.handoffs.processHandoff(principal, handoff.handoffId)
  registry.handoffs.recordCallerReply(principal, handoff.handoffId, "已確認")
  const timeline = registry.readTimeline(principal, from.id)
  expect(timeline).toHaveLength(1)
  expect(timeline[0]).toMatchObject({ role: "system", handoffEventType: "handoff.replied", handoffThread: { outbound: "確認結果", inbound: "已確認" } })
  expect(registry.readTimeline(principal, to.id)).toHaveLength(1)
})
