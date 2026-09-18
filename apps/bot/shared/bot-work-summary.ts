export const BOT_WORK_SUMMARY_KEY = "目前工作"
export const BOT_WORK_SUMMARY_STATUS_GUIDANCE = "Use active while follow-up work remains; blocked requires at least one blocker; completed requires empty nextSteps and blockers. Never discard unresolved work just to mark a summary completed."

export interface BotWorkSummary {
  goal: string
  status: "active" | "blocked" | "completed"
  decisions: string[]
  progress: string[]
  nextSteps: string[]
  blockers: string[]
}

export function formatWorkSummary(summary: BotWorkSummary): string {
  const status = { active: "進行中", blocked: "有待解決事項", completed: "已結束" }[summary.status]
  return [`目標：${summary.goal}`, `狀態：${status}`, ...([
    ["已確認決策", summary.decisions], ["已記錄進展", summary.progress],
    ["下一步", summary.nextSteps], ["待解決事項", summary.blockers],
  ] as const).flatMap(([label, items]) => items.length ? [`${label}：\n${items.map((item) => `• ${item}`).join("\n")}`] : [])].join("\n\n")
}
