import { expect, test } from "bun:test"
import { BotRegistry } from "./bot-registry"

const owner = { tenant_id: "source-test", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }

test("handoff retry preserves one source and invocation and rejects changed payload atomically", () => {
  const registry = new BotRegistry(":memory:")
  try {
    const from = registry.create(owner, { name: "來源" })
    const to = registry.create(owner, { name: "接收" })
    const input = { fromBotId: from.id, toBotId: to.id, fact: "查詢狀態", originalMessage: "@接收 查詢狀態", clientRequestId: "retry-1", sourceAuthor: "user" as const }
    const first = registry.createHandoff(owner, input)
    expect(registry.createHandoff(owner, input)).toEqual(first)
    expect(registry.listInvocations(owner)).toHaveLength(1)
    const messages = registry.readTimeline(owner, from.id)
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1)
    expect(messages.find((message) => message.id === `handoff:${first.handoffId}`)?.replyToMessageId).toBe("handoff-source:retry-1")
    expect(messages.find((message) => message.id === "handoff-source:retry-1")?.text).toBe(input.originalMessage)
    expect(() => registry.createHandoff(owner, { ...input, fact: "改成刪除" })).toThrow("HANDOFF_REQUEST_CONFLICT")
    expect(() => registry.createHandoff({ ...owner, subject_id: "stranger" }, input)).toThrow("BOT_NOT_FOUND")
    expect(registry.listInvocations(owner)).toHaveLength(1)
    expect(() => registry.createHandoffs(owner, { ...input, clientRequestId: "atomic", toBotId: undefined, toBotIds: [to.id, "absent"], fanOutExplicit: true })).toThrow("BOT_NOT_FOUND")
    expect(registry.listInvocations(owner)).toHaveLength(1)
  } finally { registry.close() }
})

test("silent FYI remains in recipient history without granting access to source timeline", () => {
  const registry = new BotRegistry(":memory:")
  try {
    const from = registry.create(owner, { name: "來源" })
    const to = registry.create(owner, { name: "接收" })
    const ack = registry.createHandoff(owner, { fromBotId: from.id, toBotId: to.id, fact: "FYI", kind: "fyi", clientRequestId: "fyi-1", sourceAuthor: "bot" })
    const message = registry.readTimeline(owner, to.id).find((item) => item.handoffId === ack.handoffId)
    expect(message?.visibility).toBe("silent")
    expect(message?.handoffThread?.fromBotId).toBe(from.id)
    expect(message?.handoffThread?.sourceMessageId).toBe("handoff-source:fyi-1")
    expect(() => registry.readTimeline({ ...owner, subject_id: "stranger" }, from.id)).toThrow("BOT_NOT_FOUND")
  } finally { registry.close() }
})

test("FYI completion records read on both sides without caller continuation", () => {
  const registry = new BotRegistry(":memory:")
  try {
    const from = registry.create(owner, { name: "來源" })
    const to = registry.create(owner, { name: "接收" })
    const ack = registry.createHandoff(owner, { fromBotId: from.id, toBotId: to.id, fact: "FYI", kind: "fyi", clientRequestId: "read-1" })
    registry.beginInvocation(ack.invocationId)
    registry.completeInvocation(ack.invocationId, "已讀取")
    expect(registry.continuations.pending()).toHaveLength(0)
    for (const botId of [from.id, to.id]) {
      expect(registry.readTimeline(owner, botId).find((message) => message.handoffId === ack.handoffId)?.handoffEventType).toBe("handoff.read")
    }
    registry.completeInvocation(ack.invocationId, "已讀取")
    expect(registry.continuations.pending()).toHaveLength(0)
    expect(registry.listHandoffEvents(owner, to.id, { includeSilent: true }).filter((event) => event.type === "handoff.read")).toHaveLength(1)
  } finally { registry.close() }
})

test("quiet FYI native completion updates work state without creating unread attention", () => {
  const registry = new BotRegistry(":memory:")
  try {
    const from = registry.create(owner, { name: "來源" })
    const to = registry.create(owner, { name: "接收" })
    registry.saveSession({ botId: to.id, appServerThreadId: "quiet-thread" })
    const ack = registry.createHandoff(owner, { fromBotId: from.id, toBotId: to.id, fact: "FYI", kind: "fyi" })
    registry.beginInvocation(ack.invocationId)
    registry.applySessionEvent(to.id, "viewed")
    registry.recordRuntimeEvent(owner, JSON.stringify({ method: "turn/started", params: { threadId: "quiet-thread", turn: { id: "quiet-turn", status: "inProgress", items: [] } } }))
    registry.recordRuntimeEvent(owner, JSON.stringify({ method: "turn/completed", params: { threadId: "quiet-thread", turn: { id: "quiet-turn", status: "completed", items: [{ type: "userMessage", id: "input", clientId: `handoff-task:${ack.invocationId}`, content: [{ type: "text", text: "FYI" }] }] } } }))
    expect(registry.getSession(to.id)?.workState).toBe("idle")
    expect(registry.getSession(to.id)?.unread).toBe(false)
  } finally { registry.close() }
})
