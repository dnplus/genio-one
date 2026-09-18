import { expect, test } from "bun:test"
import { isMissingCodexThread } from "./codex-session-recovery"

test("only an explicit missing rollout permits a replacement execution segment", () => {
  expect(isMissingCodexThread(new Error(JSON.stringify({ code: -32600, message: "no rollout found for thread id 01a07a49-376e-7b30-b7e2-229525ecfe31" })))).toBe(true)
  for (const message of ["CODEX_CONNECTION_CLOSED", "CODEX_HANDSHAKE_TIMEOUT", "Unauthorized", "thread history temporarily unavailable"]) {
    expect(isMissingCodexThread(new Error(message))).toBe(false)
  }
  expect(isMissingCodexThread(new Error(JSON.stringify({ code: -32603, message: "no rollout found for thread id old-thread" })))).toBe(false)
})
