import { expect, test } from "bun:test"
import { PendingInteractions } from "./pending-interactions"

const question = { id: 7, method: "item/tool/requestUserInput", params: { threadId: "thread-a", turnId: "turn-a", questions: [{ id: "choice", question: "選擇下一步" }] } }

test("pending requests keep stable tokens, scope replies and reject duplicate or old-runtime responses", async () => {
  const store = new PendingInteractions()
  store.observe(question)
  const entry = store.list("thread-a")[0]!
  store.observe(question)
  expect(store.list("thread-a")[0]?.genioRequestToken).toBe(entry.genioRequestToken)
  expect(store.list("thread-b")).toEqual([])
  const sent: string[] = []
  const send = async (line: string) => { sent.push(line) }
  await expect(store.respond("thread-b", entry.genioRequestToken, {}, send)).rejects.toThrow("BOT_INTERACTION_EXPIRED")
  await expect(new PendingInteractions().respond("thread-a", entry.genioRequestToken, {}, send)).rejects.toThrow("BOT_INTERACTION_EXPIRED")
  await store.respond("thread-a", entry.genioRequestToken, { answers: {} }, send)
  expect(JSON.parse(sent[0]!)).toEqual({ id: 7, result: { answers: {} } })
  await expect(store.respond("thread-a", entry.genioRequestToken, {}, send)).rejects.toThrow("BOT_INTERACTION_EXPIRED")
  expect(sent).toHaveLength(1)
})

test("failed writes remain recoverable and native resolution or completion removes requests", async () => {
  const store = new PendingInteractions()
  store.observe(question)
  await expect(store.respond("thread-a", store.list("thread-a")[0]!.genioRequestToken, {}, async () => { throw new Error("disconnected") })).rejects.toThrow("disconnected")
  expect(store.list("thread-a")).toHaveLength(1)
  store.observe({ method: "serverRequest/resolved", params: { threadId: "thread-a", requestId: 7 } })
  expect(store.list("thread-a")).toEqual([])
  store.observe(question)
  store.observe({ method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-a" } } })
  expect(store.list("thread-a")).toEqual([])
})
