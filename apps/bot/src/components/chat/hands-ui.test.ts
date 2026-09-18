import { describe, expect, test } from "bun:test"

import {
  composerShouldBlockPassword,
  handsPreviewSummary,
  loginWallCardTitle,
  loginWallToChatMessage,
  USER_SCOPED_COMPUTER_COPY,
} from "./hands-ui"

describe("UX P2 hands-ui", () => {
  test("projects login wall chat message without password collection", () => {
    const wall = {
      id: "lw-1",
      kind: "request_help" as const,
      site_label: "GitHub",
      reason: "需要登入",
      bot_id: "bot-a",
      computer_id: "user-computer-1",
      status: "pending" as const,
      created_at: "2026-09-06T04:00:00.000Z",
    }
    const msg = loginWallToChatMessage(wall)
    expect(msg.kind).toBe("login_wall")
    expect(msg.collectsPassword).toBe(false)
    expect(msg.text).toContain("不要把密碼貼到聊天")
    expect(loginWallCardTitle(wall)).toContain("GitHub")
  })

  test("hands preview summary exposes user-scoped copy", () => {
    const summary = handsPreviewSummary(null)
    expect(summary.statusLabel).toBe("尚未開啟 Hands")
    expect(summary.userScopedCopy).toBe(USER_SCOPED_COMPUTER_COPY.securityNote)
  })

  test("composer blocks password while login wall pending", () => {
    expect(composerShouldBlockPassword("password: x", true)).toBe(true)
    expect(composerShouldBlockPassword("password: x", false)).toBe(false)
    expect(composerShouldBlockPassword("我去桌面登入", true)).toBe(false)
  })
})
