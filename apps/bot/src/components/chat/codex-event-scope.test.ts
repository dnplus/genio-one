import { expect, test } from "bun:test"
import { belongsToThread } from "./codex-event-scope"

test("rejects another Bot's deltas, completion, and pending questions", () => {
  for (const method of ["item/agentMessage/delta", "turn/completed", "item/tool/requestUserInput", "mcpServer/elicitation/request"]) {
    expect(belongsToThread({ method, params: { threadId: "bot-b" } }, "bot-a")).toBe(false)
    expect(belongsToThread({ method, params: { threadId: "bot-a" } }, "bot-a")).toBe(true)
    expect(belongsToThread({ method, params: {} }, "bot-a")).toBe(false)
  }
  expect(belongsToThread({ method: "turn/started", params: { threadId: "bot-a" } }, null)).toBe(false)
  expect(belongsToThread({ method: "genio/codexReady", params: {} }, null)).toBe(true)
  expect(belongsToThread({ method: "account/login/completed", params: { success: true } }, null)).toBe(true)
})
