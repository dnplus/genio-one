export interface BotSidebarSummary {
  preview: string
  timestamp?: number
  waitingFor?: "answer" | "approval"
}
