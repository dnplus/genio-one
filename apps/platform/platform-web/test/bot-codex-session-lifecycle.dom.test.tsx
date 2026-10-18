import { afterEach, expect, spyOn, test } from "bun:test"
import { act, StrictMode, useCallback, useState } from "react"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { CodexClient } from "../../../bot/src/lib/codex-client"
import type { ArtifactRef } from "../../../bot/src/lib/bot-api"
import type { BotInstance, ChatMessage } from "../../../bot/src/bots-storage"
import { useCodexSession } from "../../../bot/src/components/chat/useCodexSession"

const originalSocket = globalThis.WebSocket
const sockets: FakeSocket[] = []
let restoreRequestRaw: (() => void) | null = null
const idle = () => {}
const bot = {
  id: "codex-session-lifecycle-fixture",
  name: "Session fixture",
  role: "Session fixture",
  description: "Session fixture",
  title: "Session fixture",
  workspacePath: "/isolated/session-fixture",
  modelRoute: "codex-subscription",
  skills: [],
  bindings: [],
} as unknown as BotInstance

class FakeSocket extends EventTarget {
  static OPEN = 1
  readyState = 1
  sent: Array<{ id?: number; method?: string }> = []
  hold: string | null = null

  constructor(_url: string) {
    super()
    sockets.push(this)
    queueMicrotask(() => {
      if (this.readyState === 1) this.dispatchEvent(new Event("open"))
    })
  }

  send(line: string) {
    const message = JSON.parse(line) as { id?: number; method?: string }
    this.sent.push(message)
    if (message.id === undefined || message.method === this.hold) return
    const result = message.method === "genio/runtime/status" ? { active: null, tiers: {} }
      : message.method === "genio/bot/select" ? { modelDirectory: "codex-subscription", managedMcpServerNames: [] }
      : message.method === "skills/list" ? { data: [] }
      : message.method === "account/read" ? { account: null }
      : message.method === "account/login/start" ? { verificationUrl: "https://example.test/device", userCode: "fixture-code" }
      : {}
    queueMicrotask(() => this.message({ id: message.id, result }))
  }

  close() { this.readyState = 3 }
  message(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })) }
  ready() { this.message({ method: "genio/codexReady", params: { modelDirectory: "codex-subscription" } }) }
}

afterEach(() => {
  cleanup()
  restoreRequestRaw?.()
  restoreRequestRaw = null
  globalThis.WebSocket = originalSocket
  sockets.length = 0
})

function sessionHarness() {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  return renderHook(({ connectionKey }) => {
    const [, setMessages] = useState<ChatMessage[]>([])
    const [, setArtifacts] = useState<ArtifactRef[]>([])
    const focusInput = useCallback(() => {}, [connectionKey])
    return useCodexSession({
      activeBot: bot,
      activeThreadId: "thread-session-fixture",
      token: "isolated-test-session",
      demo: false,
      onSignOut: idle,
      setMessages,
      setArtifacts,
      focusInput,
      scrollToBottom: idle,
    })
  }, { initialProps: { connectionKey: 0 }, wrapper: StrictMode })
}

test("StrictMode teardown cannot present a closed old client as the current Bot startup failure", async () => {
  const { result } = sessionHarness()
  await act(async () => {})
  expect(sockets).toHaveLength(2)
  expect(sockets[0]!.readyState).toBe(3)
  expect(result.current.runtimeState).not.toContain("CODEX_CLIENT_CLOSED")
  expect(result.current.agentState).toBe("idle")
  await act(async () => sockets[1]!.ready())
  await waitFor(() => expect(result.current.codexLogin?.userCode).toBe("fixture-code"))
  expect(result.current.isCodexAuthenticated).toBe(false)
  expect(result.current.runtimeState).toBe("等待 Codex OAuth 登入")
})

test("a disposed session preparation cannot import an old runtime or continue on the replacement client", async () => {
  const { result, rerender } = sessionHarness()
  const oldSocket = sockets[1]!
  const oldClient = result.current.clientRef.current
  const requestRaw = CodexClient.prototype.requestRaw
  let requested = false
  let completeRuntime!: (value: unknown) => void
  const runtimeStatus = new Promise((resolve) => { completeRuntime = resolve })
  const request = spyOn(CodexClient.prototype, "requestRaw").mockImplementation(function (method, params, botId) {
    if (this === oldClient && method === "genio/runtime/status") {
      requested = true
      return runtimeStatus
    }
    return requestRaw.call(this, method, params, botId)
  })
  restoreRequestRaw = () => request.mockRestore()
  await act(async () => oldSocket.ready())
  await waitFor(() => expect(requested).toBe(true))
  await act(async () => rerender({ connectionKey: 1 }))
  expect(oldSocket.readyState).toBe(3)
  await act(async () => completeRuntime({ active: { kind: "local", tier: "none", cwd: "/old-runtime", environmentId: "old-session-runtime", execReady: false } }))
  expect(result.current.runtime).toBeNull()
  expect(result.current.runtimeState).not.toContain("CODEX")
  expect(oldSocket.sent.some((entry) => entry.method === "skills/list")).toBe(false)
  await act(async () => sockets.at(-1)!.ready())
  await waitFor(() => expect(result.current.codexLogin?.userCode).toBe("fixture-code"))
  expect(result.current.runtime).toBeNull()
})

test("disposed initialization errors are ignored while the same error from the current client remains visible", async () => {
  const { result, rerender } = sessionHarness()
  const oldSocket = sockets[1]!
  oldSocket.hold = "initialize"
  await act(async () => oldSocket.ready())
  await waitFor(() => expect(oldSocket.sent.some((request) => request.method === "initialize")).toBe(true))
  await act(async () => rerender({ connectionKey: 1 }))
  expect(oldSocket.readyState).toBe(3)
  expect(result.current.runtimeState).not.toContain("CODEX_CLIENT_CLOSED")
  expect(result.current.agentState).toBe("idle")
  const currentSocket = sockets.at(-1)!
  currentSocket.hold = "initialize"
  await act(async () => currentSocket.ready())
  await waitFor(() => expect(currentSocket.sent.some((request) => request.method === "initialize")).toBe(true))
  const request = currentSocket.sent.find((entry) => entry.method === "initialize")!
  await act(async () => currentSocket.message({ id: request.id, error: { message: "CODEX_CLIENT_CLOSED" } }))
  expect(result.current.runtimeState).toBe("CODEX_CLIENT_CLOSED")
  expect(result.current.agentState).toBe("exclaim")
})
