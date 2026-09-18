import { expect, test } from "bun:test"
import { CodexRpcChannels } from "./codex-rpc-channels"

test("routes overlapping client request IDs only to their originating connection", async () => {
  const channels = new CodexRpcChannels()
  const sent: any[] = []
  const a: any[] = []
  const b: any[] = []
  const runtime = { send: async (line: string) => { sent.push(JSON.parse(line)) }, close: async () => {} }
  const first = channels.channel(runtime, { onMessage: (line) => a.push(JSON.parse(line)), onExit() {} })
  const second = channels.channel(runtime, { onMessage: (line) => b.push(JSON.parse(line)), onExit() {} })
  await first.send(JSON.stringify({ id: 1, method: "thread/read", params: { threadId: "a" } }))
  await second.send(JSON.stringify({ id: 1, method: "thread/read", params: { threadId: "b" } }))
  expect(sent[0].id).not.toBe(sent[1].id)
  channels.receive({ id: sent[1].id, result: { thread: { id: "b" } } }, () => {})
  channels.receive({ id: sent[0].id, result: { thread: { id: "a" } } }, () => {})
  expect(a).toEqual([{ id: 1, result: { thread: { id: "a" } } }])
  expect(b).toEqual([{ id: 1, result: { thread: { id: "b" } } }])
})

test("discards late responses after detach and preserves server request IDs", async () => {
  const channels = new CodexRpcChannels()
  const sent: any[] = []
  const received: string[] = []
  const runtime = { send: async (line: string) => { sent.push(JSON.parse(line)) }, close: async () => {} }
  const owner = { onMessage: (line: string) => received.push(line), onExit() {} }
  const channel = channels.channel(runtime, owner)
  await channel.send(JSON.stringify({ id: 3, method: "thread/read" }))
  channels.detach(owner)
  expect(channels.receive({ id: sent[0].id, result: {} }, () => {})).toBe(true)
  expect(received).toEqual([])
  await channel.send(JSON.stringify({ id: 77, result: { answers: {} } }))
  expect(sent[1].id).toBe(77)
  expect(channels.receive({ id: 77, method: "item/tool/requestUserInput" }, () => {})).toBe(false)
})

test("records initialization independently of the client sequence", async () => {
  const channels = new CodexRpcChannels()
  let sent: any
  let initialized: unknown
  const channel = channels.channel({ send: async (line) => { sent = JSON.parse(line) }, close: async () => {} }, { onMessage() {}, onExit() {} })
  await channel.send(JSON.stringify({ id: 14, method: "initialize" }))
  channels.receive({ id: sent.id, result: { version: "native" } }, (result) => { initialized = result })
  expect(initialized).toEqual({ version: "native" })
})

test("simultaneous initialization shares one native request and survives the first client detaching", async () => {
  const channels = new CodexRpcChannels()
  const sent: any[] = []
  const received: any[] = []
  const runtime = { send: async (line: string) => { sent.push(JSON.parse(line)) }, close: async () => {} }
  const first = channels.channel(runtime, { onMessage() { throw new Error("detached client") }, onExit() {} })
  const second = channels.channel(runtime, { onMessage: (line) => { received.push(JSON.parse(line)) }, onExit() {} })
  await Promise.all([first.send(JSON.stringify({ id: 1, method: "initialize" })), second.send(JSON.stringify({ id: 2, method: "initialize" }))])
  expect(sent).toHaveLength(1)
  await first.close()
  channels.receive({ id: sent[0].id, result: { version: "native" } }, () => {})
  expect(received).toEqual([{ id: 2, result: { version: "native" } }])
  await second.send(JSON.stringify({ id: 3, method: "initialize" }))
  expect(received[1]).toEqual({ id: 3, result: { version: "native" } })
  expect(sent).toHaveLength(1)
  await Promise.all([second.send(JSON.stringify({ method: "initialized" })), second.send(JSON.stringify({ method: "initialized" }))])
  expect(sent.filter((message) => message.method === "initialized")).toHaveLength(1)
})

test("failed initialization notifies every waiter and permits a fresh attempt", async () => {
  const channels = new CodexRpcChannels()
  const sent: any[] = []
  const received: any[] = []
  const runtime = { send: async (line: string) => { sent.push(JSON.parse(line)) }, close: async () => {} }
  const callback = { onMessage: (line: string) => { received.push(JSON.parse(line)) }, onExit() {} }
  const a = channels.channel(runtime, callback)
  const b = channels.channel(runtime, callback)
  await a.send(JSON.stringify({ id: 1, method: "initialize" }))
  await b.send(JSON.stringify({ id: 2, method: "initialize" }))
  channels.receive({ id: sent[0].id, error: { code: -32600 } } as any, () => { throw new Error("must not mark initialized") })
  expect(received.map((message) => message.id)).toEqual([1, 2])
  expect(received.every((message) => message.error.code === -32600)).toBe(true)
  await b.send(JSON.stringify({ id: 3, method: "initialize" }))
  expect(sent).toHaveLength(2)
})
