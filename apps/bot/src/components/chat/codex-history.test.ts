import { expect, test } from "bun:test"
import type { Turn } from "../../../server/generated/v2/Turn"
import type { CodexClient } from "../../lib/codex-client"
import { readEarlierCodexTurns, readCodexTurns, reconstructTurnMessages } from "./codex-history"

function turn(id: string, status: Turn["status"] = "completed"): Turn {
  return { id, status, startedAt: 1788700000, completedAt: null, durationMs: null, error: null, itemsView: "full", items: [
    { type: "userMessage", id: `${id}-user`, clientId: null, content: [{ type: "text", text: "保留原文", text_elements: [] }] },
    { type: "plan", id: `${id}-plan`, text: "確認來源後回答" },
    { type: "contextCompaction", id: `${id}-compact` },
  ] }
}

test("history keeps native ordering, timestamps, and tool data across repeated reconstruction", () => {
  const source = turn("turn-a")
  const restored = reconstructTurnMessages([source], new Set(), "thread-a")
  expect(restored).toEqual(reconstructTurnMessages([source], new Set(), "thread-a"))
  expect(restored.map((message) => [message.id, message.role])).toEqual([["thread-a:turn-a-user", "user"], ["thread-a:turn-a-plan", "system"], ["thread-a:turn-a-compact", "system"]])
  expect(restored.every((message) => message.createdAt === 1788700000000)).toBe(true)
  expect(restored[1]?.runtimeItem).toEqual(source.items[1])
  expect(restored[0]?.runtimeThreadId).toBe("thread-a")
})

test("a live turn does not become completed while hydrating and unknown time stays unknown", () => {
  const source = turn("live", "inProgress")
  source.startedAt = null
  const completed = new Set<string>()
  const restored = reconstructTurnMessages([source], completed, "thread-a")
  expect(completed.size).toBe(0)
  expect(restored[0]?.createdAt).toBeUndefined()
})

test("reads every history page and merges repeated turn anchors", async () => {
  const calls: unknown[] = []
  const client = { request: async (_method: string, params: unknown) => {
    calls.push(params)
    return calls.length === 1
      ? { data: [turn("one")], nextCursor: "older-page" }
      : { data: [turn("one"), turn("two")], nextCursor: null }
  } } as Pick<CodexClient, "request">
  expect((await readCodexTurns(client, "thread-a")).map((entry) => entry.id)).toEqual(["one", "two"])
  expect(calls).toHaveLength(2)
})


test("earlier history loads its native segment before paging without starting work", async () => {
  const methods: string[] = []
  const client = { request: async (method: string, params: any, botId: string) => {
    methods.push(method)
    expect(botId).toBe("bot-a")
    expect(params.threadId).toBe("old-thread")
    if (method === "thread/resume") { expect(params.excludeTurns).toBe(true); return { thread: { id: "old-thread" } } }
    return { data: [turn("old-turn")], nextCursor: null }
  } } as Pick<CodexClient, "request">
  expect((await readEarlierCodexTurns(client, "old-thread", "bot-a"))[0]?.id).toBe("old-turn")
  expect(methods).toEqual(["thread/resume", "thread/turns/list"])
})

test("missing earlier rollout is not paged or replaced", async () => {
  const methods: string[] = []
  const error = new Error(JSON.stringify({ code: -32600, message: "no rollout found for thread id old-thread" }))
  const client = { request: async (method: string) => { methods.push(method); throw error } } as Pick<CodexClient, "request">
  await expect(readEarlierCodexTurns(client, "old-thread", "bot-a")).rejects.toThrow(error.message)
  expect(methods).toEqual(["thread/resume"])
})
