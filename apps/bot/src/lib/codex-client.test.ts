import { expect, test } from "bun:test"
import { CodexClient } from "./codex-client"

test("late events from a closed socket cannot clear or resolve the replacement connection", async () => {
  const originalSocket = globalThis.WebSocket
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location")
  const sockets: FakeSocket[] = []
  class FakeSocket extends EventTarget {
    static OPEN = 1
    readyState = 1
    sent: Array<{ id?: number; method?: string }> = []
    constructor(_url: string) { super(); sockets.push(this) }
    send(line: string) { this.sent.push(JSON.parse(line)) }
    close() { this.readyState = 3 }
    message(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })) }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "http:", host: "localhost" } })
  const client = new CodexClient()
  try {
    const first = client.connect("test")
    sockets[0]!.message({ method: "genio/codexReady" })
    await first
    const interrupted = client.requestRaw("thread/read", {})
    client.close()
    await expect(interrupted).rejects.toThrow("CODEX_CLIENT_CLOSED")
    const second = client.connect("test")
    sockets[1]!.message({ method: "genio/codexReady" })
    await second
    const result = client.requestRaw("thread/read", {})
    const id = sockets[1]!.sent.at(-1)!.id
    sockets[0]!.message({ id, result: "wrong socket" })
    sockets[0]!.dispatchEvent(Object.assign(new Event("close"), { code: 1000, reason: "old socket" }))
    sockets[1]!.message({ id, result: "current socket" })
    expect(await result).toBe("current socket")
  } finally {
    client.close()
    globalThis.WebSocket = originalSocket
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation)
    else Reflect.deleteProperty(globalThis, "location")
  }
})
