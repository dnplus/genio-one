import { expect, test } from "bun:test"
import { botViewKey, parseBotView, captureReadingPosition } from "./bot-view-state"

test("view state is scoped by identity and Bot and preserves draft text exactly", () => {
  expect(botViewKey("tenant", "owner", "a")).not.toBe(botViewKey("tenant", "owner", "b"))
  expect(botViewKey("tenant", "owner", "a")).not.toBe(botViewKey("tenant", "other", "a"))
  expect(botViewKey("a:b", "c", "d")).not.toBe(botViewKey("a", "b:c", "d"))
  const draft = " 尚未送出\n第二行 "
  expect(parseBotView(JSON.stringify({ draft })).draft).toBe(draft)
  expect(parseBotView("invalid").draft).toBe("")
  expect(parseBotView(JSON.stringify({ draft, position: { scrollTop: "bad" } })).position).toBeUndefined()
})

test("reading position keeps the partially visible message and its offset", () => {
  const container = {
    scrollTop: 250, scrollHeight: 1000, clientHeight: 300,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => [
      { dataset: { messageId: "past" }, getBoundingClientRect: () => ({ top: -20, bottom: 80 }) },
      { dataset: { messageId: "current" }, getBoundingClientRect: () => ({ top: 90, bottom: 190 }) },
      { dataset: { messageId: "next" }, getBoundingClientRect: () => ({ top: 200, bottom: 300 }) },
    ],
  } as unknown as HTMLElement
  expect(captureReadingPosition(container)).toEqual({ anchorId: "current", offset: -10, scrollTop: 250, atBottom: false })
})
