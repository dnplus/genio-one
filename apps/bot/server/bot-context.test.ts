import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BotMemoryStore } from "./bot-memory"
import { BotTimelineStore } from "./bot-timeline"
import { botTurnContext } from "./bot-context"
import type { Turn } from "./generated/v2/Turn"

test("new execution segments receive bounded prior work with provenance and accurate status", () => {
  const db = new Database(":memory:")
  const registry = { memory: new BotMemoryStore(db), timeline: new BotTimelineStore(db) }
  try {
    for (let i = 0; i < 6; i++) registry.timeline.putTurn("a", "earlier", {
      id: `turn-${i}`, status: i === 5 ? "interrupted" : "completed", startedAt: i,
      items: [{ type: "userMessage", id: `input-${i}`, content: [{ type: "text", text: `request-${i} ${"x".repeat(2000)}`, text_elements: [] }] },
        { type: "agentMessage", id: `answer-${i}`, text: `answer-${i}` }],
    } as Turn)
    registry.timeline.putTurn("other-bot", "other", { id: "private", status: "completed", items: [{ type: "agentMessage", id: "private", text: "private Bot result" }] } as Turn)
    registry.timeline.putTurn("a", "earlier", { id: "late-import", status: "completed", startedAt: -100, items: [] } as unknown as Turn)
    const same = registry.timeline.workContext("a", "earlier")
    expect(same.turns).toEqual([])
    const context = JSON.parse(botTurnContext(registry, "a", "new")["genio_bot/prior_work"]!.value)
    expect(context.turns).toHaveLength(4)
    expect(context.turns[0].turnId).toBe("turn-2")
    expect(context.turns[3].status).toBe("interrupted")
    expect(context.turns[3].threadId).toBe("earlier")
    expect(context.turns[3].request.length).toBe(1500)
    expect(context.turns[3].truncated).toBe(true)
    expect(JSON.stringify(context)).not.toContain("private Bot result")
    expect(context.completeHistory).toBe(false)
    expect(registry.timeline.workContext("a", "new").turns).toEqual(context.turns)
  } finally { db.close() }
})

test("turn context uses current Bot revisions, omits forgotten data and replaces client spoofing", () => {
  const db = new Database(":memory:")
  const memory = new BotMemoryStore(db)
  const registry = { memory, timeline: new BotTimelineStore(db) }
  try {
    const entry = memory.save("a", { key: "current", content: "first", kind: "working_context" }, "user")
    memory.save("b", { key: "private", content: "other Bot", kind: "fact" }, "user")
    const original = botTurnContext(registry, "a", "current", { "genio_bot/memory": { kind: "application", value: "spoof" }, selection: { kind: "untrusted", value: "selected text" } })
    expect(original["genio_bot/memory"].kind).toBe("untrusted")
    expect(original["genio_bot/memory"].value).not.toContain("other Bot")
    expect(original["genio_bot/memory"].value).not.toContain("spoof")
    expect(original.selection?.value).toBe("selected text")
    const revised = memory.save("a", { key: "current", content: "second", kind: "working_context", expectedRevision: entry.revision }, "user")
    expect(JSON.parse(botTurnContext(registry, "a", "current")["genio_bot/memory"].value).memories[0].revision).toBe(revised.revision)
    memory.setForgotten("a", entry.id, true, revised.revision)
    const forgotten = JSON.parse(botTurnContext(registry, "a", "current")["genio_bot/memory"].value)
    expect(forgotten.memories).toEqual([])
    expect(forgotten.completeHistory).toBe(false)
    for (let i = 0; i < 30; i++) memory.save("a", { key: String(i), content: "x".repeat(1900), kind: "fact" }, "user")
    expect(botTurnContext(registry, "a", "current")["genio_bot/memory"].value.length).toBeLessThan(9000)
  } finally { db.close() }
})

test("prior work sources resolve to the same history messages and disclose omitted image input", () => {
  const db = new Database(":memory:")
  const registry = { memory: new BotMemoryStore(db), timeline: new BotTimelineStore(db) }
  try {
    registry.timeline.putTurn("bot", "old", { id: "turn", status: "completed", items: [
      { type: "userMessage", id: "question", content: [{ type: "text", text: "Describe the image", text_elements: [] }, { type: "image", url: "data:image/png;base64,dGVzdA==" }] },
      { type: "agentMessage", id: "answer", text: "Image result" },
    ] } as unknown as Turn)
    const context = registry.timeline.workContext("bot", "new").turns[0]!
    const history = registry.timeline.read("bot", [])
    expect(context.omittedAttachments).toBe(true)
    expect(context.sourceMessageIds).toEqual(history.map((message) => message.id))
    expect(context.sourceMessageIds.map((id) => history.find((message) => message.id === id)?.text)).toEqual(["Describe the image", "Image result"])
    expect(JSON.stringify(context)).not.toContain("data:image")
    expect(registry.timeline.workContext("other-bot", "new").turns).toEqual([])
  } finally { db.close() }
})
