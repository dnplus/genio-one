export interface BotQuestion {
  id: string
  botId: string
  sourceThreadId: string
  sourceTurnId: string
  sourceItemId?: string
  title: string
  options: string[]
  revision: number
  state: "pending" | "answered" | "dismissed" | "superseded"
  createdAt: number
  answer?: string
  clientAnswerId?: string
  delivery: "none" | "queued" | "sending" | "delivered" | "uncertain" | "failed"
  deliveryThreadId?: string
  deliveryTurnId?: string
  error?: string
}
