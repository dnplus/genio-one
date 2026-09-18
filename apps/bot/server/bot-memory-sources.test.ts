import { expect, test } from "bun:test"
import { BotRegistry } from "./bot-registry"
import type { Turn } from "./generated/v2/Turn"

test("memory sources must resolve within the Bot and survive ordinary revision updates", () => {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  try {
    const a = registry.create(principal, { name: "A", description: "Source" })
    const b = registry.create(principal, { name: "B", description: "Other" })
    registry.timeline.putTurn(a.id, "thread-a", { id: "turn", status: "completed", items: [{ id: "source", type: "userMessage", content: [{ type: "text", text: "Please remember this decision", text_elements: [] }] }] } as unknown as Turn)
    const source = registry.timeline.read(a.id, [])[0]!.id
    const entry = registry.memory.save(a.id, { key: "decision", content: "Confirmed decision", kind: "decision", sourceMessageIds: [source] }, "bot")
    expect(entry.sourceMessageIds).toEqual([source])
    const updated = registry.memory.save(a.id, { key: entry.key, content: "Updated decision", kind: "decision", expectedRevision: entry.revision }, "user")
    expect(updated.sourceMessageIds).toEqual([source])
    expect(() => registry.memory.save(b.id, { key: "foreign", content: "Not allowed", kind: "fact", sourceMessageIds: [source] }, "bot")).toThrow("BOT_MEMORY_SOURCE_INVALID")
    expect(() => registry.memory.save(a.id, { key: "missing", content: "Not allowed", kind: "fact", sourceMessageIds: ["missing"] }, "bot")).toThrow("BOT_MEMORY_SOURCE_INVALID")
    expect(registry.memory.recall(a.id).memories[0]?.sourceMessageIds).toEqual([source])
    const cleared = registry.memory.save(a.id, { key: entry.key, content: "New independent decision", kind: "decision", expectedRevision: updated.revision, sourceMessageIds: [] }, "user")
    expect(cleared.sourceMessageIds).toBeUndefined()
  } finally { registry.close() }
})
