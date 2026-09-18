import { describe, expect, test } from "bun:test"
import { groupMessagesToChat, isGroupPassText } from "./group-ui"

describe("UX P1-b group UI helpers", () => {
  test("pass never becomes a chat bubble", () => {
    expect(isGroupPassText("(pass)")).toBe(true)
    const bubbles = groupMessagesToChat([
      {
        messageId: "1",
        botId: "a",
        botName: "阿庫婭",
        round: 1,
        text: "到",
        kind: "speak",
        visible: true,
        createdAt: 1,
      },
      {
        messageId: "2",
        botId: "b",
        botName: "達克妮絲",
        round: 1,
        text: "(pass)",
        kind: "pass",
        visible: false,
        createdAt: 2,
      },
    ])
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0]?.text).toContain("阿庫婭")
    expect(bubbles.some((b) => b.text.includes("(pass)"))).toBe(false)
  })
})
