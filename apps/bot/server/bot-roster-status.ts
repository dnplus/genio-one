/**
 * UX P1-c: sidebar roster status projection from BotSession.
 *
 * Maps session workState + unread → working | unread | needs-attention
 * with human-primary labels (no raw idle/stopped/workState enums as UI copy).
 */
import type { BotSession, BotWorkState } from "./bot-registry"

export type RosterSidebarStatus = "working" | "unread" | "needs-attention"

export interface RosterSidebarProjection {
  /** Machine-stable status key for CSS / data attributes / tests. */
  status: RosterSidebarStatus | null
  /** Human primary label — never raw workState / protocol tokens. */
  statusLabel: string | null
}

export const ROSTER_SIDEBAR_HUMAN_LABELS = {
  working: "工作中",
  unread: "未讀動態",
  "needs-attention": "需要注意",
} as const satisfies Record<RosterSidebarStatus, string>

const FORBIDDEN_PRIMARY_TOKENS = [
  "turn_started",
  "turn_completed",
  "turn_stopped",
  "workState",
  "IDLE",
  "WORKING",
  "STOPPED",
] as const

export type RosterSessionSlice = Pick<BotSession, "unread" | "workState"> & { waitingFor?: "answer" | "approval" }

export function projectRosterSidebarStatus(
  session: RosterSessionSlice,
): RosterSidebarProjection {
  if (session.waitingFor) return { status: "needs-attention", statusLabel: session.waitingFor === "answer" ? "等待你回答" : "等待你確認" }
  if (session.workState === "working") {
    return { status: "working", statusLabel: ROSTER_SIDEBAR_HUMAN_LABELS.working }
  }
  if (session.workState === "stopped") {
    return {
      status: "needs-attention",
      statusLabel: ROSTER_SIDEBAR_HUMAN_LABELS["needs-attention"],
    }
  }
  if (session.unread) {
    return { status: "unread", statusLabel: ROSTER_SIDEBAR_HUMAN_LABELS.unread }
  }
  return { status: null, statusLabel: null }
}

export function rosterStatusLabelFor(status: RosterSidebarStatus): string {
  return ROSTER_SIDEBAR_HUMAN_LABELS[status]
}

/** Preview line under the bot name — human, never raw enums. */
export function rosterStatusPreview(
  session: RosterSessionSlice,
  fallbackPreview: string,
): string {
  const { status, statusLabel } = projectRosterSidebarStatus(session)
  if (status === "working") return `${statusLabel}…`
  if (status === "needs-attention") return session.waitingFor ? statusLabel! : "已停止，未回覆"
  if (status === "unread") return statusLabel ?? fallbackPreview
  return fallbackPreview
}

export function assertRosterHumanPrimaryCopy(...labels: Array<string | null | undefined>): void {
  for (const label of labels) {
    if (!label) continue
    for (const token of FORBIDDEN_PRIMARY_TOKENS) {
      if (label.includes(token)) {
        throw new Error(`roster status leaked protocol token ${token}: ${label}`)
      }
    }
  }
}

export function isBotWorkState(value: unknown): value is BotWorkState {
  return value === "idle" || value === "working" || value === "stopped"
}
