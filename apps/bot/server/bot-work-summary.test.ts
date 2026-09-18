import { expect, test } from "bun:test"
import { BotRegistry } from "./bot-registry"
import { botTurnContext } from "./bot-context"
import type { Turn } from "./generated/v2/Turn"
import { BOT_MEMORY_GUIDANCE } from "../shared/bot-memory"
import { BOT_WORK_SUMMARY_STATUS_GUIDANCE } from "../shared/bot-work-summary"

const summary = { goal: "比較兩個草稿", status: "active", decisions: ["保留原版架構"], progress: ["已讀取第一份草稿"], nextSteps: ["讀取第二份草稿"], blockers: [], sourceMessageIds: ["old:request"], expectedRevision: 0 }

test("work-summary guidance preserves unresolved work with a valid status", () => {
  expect(BOT_MEMORY_GUIDANCE).toContain(BOT_WORK_SUMMARY_STATUS_GUIDANCE)
})

test("rolling work survives recent-turn eviction and stale writers cannot overwrite a newer summary", () => {
  const registry = new BotRegistry(":memory:")
  try {
    registry.timeline.putTurn("bot", "old", { id: "first", status: "completed", startedAt: 0, items: [{ type: "userMessage", id: "request", content: [{ type: "text", text: "比較草稿，保留原版架構", text_elements: [] }] }] } as unknown as Turn)
    const first = registry.memory.updateWorkSummary("bot", summary)
    for (let i = 1; i <= 8; i++) registry.timeline.putTurn("bot", "old", { id: `later-${i}`, status: "completed", startedAt: i, items: [] } as unknown as Turn)
    const context = botTurnContext(registry, "bot", "new")
    expect(JSON.parse(context["genio_bot/prior_work"]!.value).turns.some((turn: { turnId: string }) => turn.turnId === "first")).toBe(false)
    expect(JSON.parse(context["genio_bot/work_summary"]!.value).entry.workSummary.decisions).toEqual(summary.decisions)
    expect(JSON.parse(botTurnContext(registry, "other", "new")["genio_bot/work_summary"]!.value).entry).toBeNull()
    registry.timeline.putTurn("bot", "old", { id: "second", status: "completed", items: [{ type: "userMessage", id: "new-source", content: [{ type: "text", text: "現在比較差異", text_elements: [] }] }] } as unknown as Turn)
    const second = registry.memory.updateWorkSummary("bot", { ...summary, sourceMessageIds: ["old:new-source"], expectedRevision: first.revision, progress: ["已讀取兩份草稿"], nextSteps: ["比較差異"] })
    expect(second.revision).toBe(2)
    expect(second.sourceMessageIds).toEqual(["old:request", "old:new-source"])
    expect(() => registry.memory.updateWorkSummary("bot", { ...summary, expectedRevision: first.revision })).toThrow("BOT_MEMORY_CONFLICT")
    expect(() => registry.memory.updateWorkSummary("other", summary)).toThrow("BOT_MEMORY_SOURCE_INVALID")
    expect(() => registry.memory.updateWorkSummary("bot", { ...summary, expectedRevision: 2, sourceMessageIds: [] })).toThrow("BOT_MEMORY_SOURCE_INVALID")
    expect(() => registry.memory.updateWorkSummary("bot", { ...summary, expectedRevision: 2, status: "completed" })).toThrow("BOT_WORK_SUMMARY_STATUS_INVALID")
    expect(registry.memory.workSummary("bot").entry?.revision).toBe(2)
    registry.memory.save("bot", { key: second.key, content: "使用者修正：先等我確認", kind: "working_context", expectedRevision: second.revision }, "user")
    expect(() => registry.memory.updateWorkSummary("bot", { ...summary, expectedRevision: 3 })).toThrow("BOT_WORK_SUMMARY_USER_MANAGED")
    expect(registry.memory.workSummary("bot").entry?.workSummary).toBeUndefined()
    registry.memory.setForgotten("bot", second.id, true, 3)
    expect(registry.memory.workSummary("bot")).toMatchObject({ entry: null, writable: false, reason: "forgotten" })
    expect(botTurnContext(registry, "bot", "new")["genio_bot/work_summary"]!.value).not.toContain("使用者修正")
  } finally { registry.close() }
})

test("caller and target replies resolve to the same durable handoff, never to a spoofed client ID", () => {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  try {
    const caller = registry.create(principal, { name: "Caller" })
    const target = registry.create(principal, { name: "Target" })
    const handoff = registry.handoffs.createHandoff(principal, { fromBotId: caller.id, toBotId: target.id, fact: "比較草稿" })
    registry.handoffs.processHandoff(principal, handoff.handoffId)
    const turn = (prefix: string) => ({ id: "turn", status: "completed", items: [
      { type: "userMessage", id: "input", clientId: `${prefix}:${handoff.invocationId}`, content: [{ type: "text", text: "peer input", text_elements: [] }] },
      { type: "agentMessage", id: "answer", phase: "final_answer", text: "Comparison" },
    ] } as unknown as Turn)
    registry.timeline.putTurn(target.id, "target-thread", turn("handoff-task"))
    registry.timeline.putTurn(caller.id, "caller-thread", turn("handoff-result"))
    for (const bot of [caller, target]) {
      const messages = registry.readTimeline(principal, bot.id)
      expect(messages.find((entry) => entry.messageType === "bot_reply")?.replyToMessageId).toBe(`handoff:${handoff.handoffId}`)
      expect(messages.some((entry) => entry.id === `handoff:${handoff.handoffId}`)).toBe(true)
    }
    registry.timeline.putTurn("unrelated", "other-thread", turn("handoff-task"))
    expect(registry.timeline.read("unrelated", []).at(-1)?.replyToMessageId).toBe("other-thread:input")
  } finally { registry.close() }
})

test("native messages keep reply relationships and progress phase through live deltas and restoration", () => {
  const registry = new BotRegistry(":memory:")
  try {
    registry.timeline.putTurn("bot", "thread", { id: "turn", status: "inProgress", items: [
      { type: "userMessage", id: "user", content: [{ type: "text", text: "請比較", text_elements: [] }] },
      { type: "agentMessage", id: "update", phase: "commentary", text: "開始" },
    ] } as unknown as Turn)
    registry.timeline.record("bot", { method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: "update", delta: "比較" } })
    expect(registry.timeline.read("bot", [])[1]).toMatchObject({ messageType: "bot_update", replyToMessageId: "thread:user", text: "開始比較" })
    registry.timeline.putTurn("bot", "thread", { id: "turn", status: "completed", items: [{ type: "agentMessage", id: "answer", phase: "final_answer", text: "比較結果" }] } as unknown as Turn)
    expect(registry.timeline.read("bot", []).at(-1)).toMatchObject({ messageType: "bot_reply", replyToMessageId: "thread:user" })
    expect(registry.timeline.readTurn("bot", "thread", "turn").at(-1)?.replyToMessageId).toBe("thread:user")
    expect(registry.timeline.read("other", [])).toEqual([])
  } finally { registry.close() }
})
