/**
 * UX P2 client helpers: Hands preview + login wall projections (no password collection).
 * Kept browser-safe — does not import E2B / PEP adapters (those stay server-side).
 */
import type { ChatMessage } from "../../bots-storage"

/** Mirrors server SharedUserComputer fields the UI needs. */
export interface HandsComputerView {
  computer_id: string
  status: "idle" | "ready" | "denied"
  mock_preview_url: string | null
  desktop_windows: Array<{ bot_id: string; window_id: string; label: string }>
}

export interface LoginWallView {
  id: string
  kind: "request_help" | "human_takeover"
  site_label: string
  reason: string
  bot_id: string
  computer_id: string
  status: "pending" | "takeover_open" | "completed" | "dismissed"
  created_at: string
}

export const USER_SCOPED_COMPUTER_COPY = {
  headline: "舊版共用電腦模擬預覽",
  body:
    "此區只展示舊版共用電腦模型的 mock 互動。實際遠端執行請以提供者與工作區狀態為準；授權仍走 One Policy。",
  securityNote: "模擬預覽，不代表目前 Hands 工作區",
} as const

export function handsPreviewStatusLabel(status: HandsComputerView["status"] | HandsComputerView | null): string {
  const s = typeof status === "string" ? status : status?.status
  switch (s) {
    case "ready":
      return "Hands 預覽就緒"
    case "denied":
      return "無法開啟 Hands"
    default:
      return "尚未開啟 Hands"
  }
}

export function loginWallStatusLabel(status: LoginWallView["status"]): string {
  switch (status) {
    case "pending":
      return "需要你登入"
    case "takeover_open":
      return "人類接管中"
    case "completed":
      return "登入完成"
    case "dismissed":
      return "已關閉"
  }
}

export function loginWallCardTitle(wall: Pick<LoginWallView, "kind" | "site_label">): string {
  if (wall.kind === "human_takeover") return `人類接管 · ${wall.site_label}`
  return `需要協助登入 · ${wall.site_label}`
}

export function loginWallToChatMessage(wall: LoginWallView): ChatMessage {
  const action =
    wall.kind === "human_takeover"
      ? "請接管共用電腦完成登入"
      : "需要你的協助在共用電腦上登入"
  const text =
    `${action}（${wall.site_label}）。` +
    `請在 Hands／遠端桌面預覽中操作；不要把密碼貼到聊天。` +
    (wall.reason ? ` 原因：${wall.reason}` : "")
  return {
    id: `msg-${wall.id}`,
    role: "system",
    kind: "login_wall",
    text,
    createdAt: Date.parse(wall.created_at) || Date.now(),
    loginWallId: wall.id,
    collectsPassword: false,
  }
}

export function handsPreviewSummary(computer: HandsComputerView | null): {
  statusLabel: string
  previewUrl: string | null
  windowCount: number
  computerId: string | null
  userScopedCopy: string
} {
  if (!computer) {
    return {
      statusLabel: handsPreviewStatusLabel(null),
      previewUrl: null,
      windowCount: 0,
      computerId: null,
      userScopedCopy: USER_SCOPED_COMPUTER_COPY.securityNote,
    }
  }
  return {
    statusLabel: handsPreviewStatusLabel(computer),
    previewUrl: computer.mock_preview_url,
    windowCount: computer.desktop_windows.length,
    computerId: computer.computer_id,
    userScopedCopy: USER_SCOPED_COMPUTER_COPY.securityNote,
  }
}

/** True when a composer should refuse password-shaped payloads. */
export function composerShouldBlockPassword(text: string, wallPending: boolean): boolean {
  if (!wallPending) return false
  return /(?:^|\s)(?:password|passwd|密碼|口令)\s*[=:：]\s*\S+/i.test(text)
}
