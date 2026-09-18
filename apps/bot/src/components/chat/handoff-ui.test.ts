import { describe, expect, test } from "bun:test"

import { ackToCallerMessages, extractMentionedBotIds, fanOutBlockedMessage, handoffBubbleText, mergeRecipientTranscript, peerReplyMessages, targetSessionMessages } from "./handoff-ui"

describe("UX P1-a handoff UI helpers", () => {
  test("bubble copy + fan-out block + ack projection", () => {
    expect(handoffBubbleText({
      type: "handoff.acked",
      kind: "task",
      summary: "交接 → 達克妮絲",
      fact: "x",
    })).toContain("稍後處理")

    expect(extractMentionedBotIds("請 @bot-a 與 @bot-b 處理", ["bot-a", "bot-b", "bot-c"])).toEqual(["bot-a", "bot-b"])
    expect(extractMentionedBotIds("請 @HH 運營夥伴 協助查看", [{ id: "bot-default", name: "HH 運營夥伴" }])).toEqual(["bot-default"])
    expect(extractMentionedBotIds("請 @bot-default 協助查看", [{ id: "bot-default", name: "HH 運營夥伴" }])).toEqual(["bot-default"])
    expect(fanOutBlockedMessage(2).text).toContain("fan-out")

    const messages = ackToCallerMessages({
      handoffId: "h1",
      invocationId: "i1",
      state: "ACKED",
      kind: "task",
      visibility: "visible",
      fromBotId: "a",
      toBotId: "b",
      fact: "事實",
      summary: "交接 → B",
      async: true,
      processed: false,
      createdAt: 1,
      events: [
        {
          eventId: "e1",
          handoffId: "h1",
          tenantId: "t",
          botId: "a",
          peerBotId: "b",
          kind: "task",
          visibility: "visible",
          type: "handoff.acked",
          summary: "已確認送出（對方稍後處理）",
          fact: "事實",
          invocationId: "i1",
          createdAt: 2,
        },
      ],
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind).toBe("handoff")
    expect(messages[0]?.role).toBe("system")

    const dualMessages = ackToCallerMessages({
      handoffId: "h2",
      invocationId: "i2",
      state: "ACKED",
      kind: "task",
      visibility: "visible",
      fromBotId: "a",
      toBotId: "b",
      fact: "事實",
      summary: "交接 → B",
      async: true,
      processed: false,
      createdAt: 1,
      events: [
        {
          eventId: "e-sent",
          handoffId: "h2",
          tenantId: "t",
          botId: "a",
          peerBotId: "b",
          kind: "task",
          visibility: "visible",
          type: "handoff.sent",
          summary: "已送出交接：交接 → B",
          fact: "事實",
          invocationId: "i2",
          createdAt: 2,
        },
        {
          eventId: "e-acked",
          handoffId: "h2",
          tenantId: "t",
          botId: "a",
          peerBotId: "b",
          kind: "task",
          visibility: "visible",
          type: "handoff.acked",
          summary: "已確認送出（對方稍後處理）",
          fact: "事實",
          invocationId: "i2",
          createdAt: 3,
        },
      ],
    })
    expect(dualMessages).toHaveLength(1)
    expect(dualMessages[0]?.handoffEventType).toBe("handoff.acked")
  })

  test("peer reply is a pill plus main-agent restatement, never raw bot id", () => {
    const echo = peerReplyMessages({
      requestId: "r0",
      handoffId: "h0",
      peerBotId: "bot-nova",
      peerName: "Nova",
      fromBotId: "bot-policy",
      fromName: "Policy Bot",
      outbound: "say hi",
      inbound: "say hi",
    })
    expect(echo).toHaveLength(1)
    expect(echo[0]?.handoffEventType).toBe("handoff.acked")

    const messages = peerReplyMessages({
      requestId: "r1",
      handoffId: "h1",
      peerBotId: "bot-nova",
      peerName: "Nova",
      fromBotId: "bot-policy",
      fromName: "Policy Bot",
      outbound: "查個新聞給我",
      inbound: "今天頭條是地方選舉與天氣。",
    })
    expect(messages).toHaveLength(2)
    expect(messages[0]?.kind).toBe("handoff")
    expect(messages[0]?.handoffEventType).toBe("handoff.replied")
    expect(messages[0]?.text).toBe("Nova 回覆了")
    expect(messages[1]?.role).toBe("assistant")
    expect(messages[1]?.text).toBe("今天頭條是地方選舉與天氣。")
    expect(messages[1]?.text).not.toContain("bot-nova")
    expect(messages[1]?.text).not.toMatch(/###/)
    expect(messages[1]?.handoffThread?.outbound).toBe("查個新聞給我")
  })

  test("target session shows received user input even before Codex reconstructs it", () => {
    const inbox = targetSessionMessages({
      handoffId: "h-in",
      fromBotId: "bot-policy",
      fromName: "Policy Bot",
      toBotId: "bot-nova",
      outbound: "查個新聞給我",
      inbound: "",
    })
    expect(inbox.some((message) => message.role === "user" && message.text === "查個新聞給我")).toBe(true)
    const merged = mergeRecipientTranscript(inbox, [])
    expect(merged.some((message) => message.role === "user" && message.text === "查個新聞給我")).toBe(true)
    const reconstructed = [{ id: "codex-u1", role: "user" as const, text: "查個新聞給我", createdAt: 9 }]
    const afterCodex = mergeRecipientTranscript(inbox, reconstructed)
    expect(afterCodex.filter((message) => message.role === "user" && message.text === "查個新聞給我")).toHaveLength(1)
  })
})
