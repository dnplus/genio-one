import { randomUUID } from "node:crypto"

export const interactionMethods = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request"])
type Interaction = { id: number | string; method: string; params: { threadId: string; turnId?: string; [key: string]: unknown }; genioRequestToken: string }

export class PendingInteractions {
  private readonly entries = new Map<number | string, Interaction>()
  private readonly sending = new Set<string>()

  observe(message: { id?: unknown; method?: string; params?: any }) {
    if (message.method && interactionMethods.has(message.method) && (typeof message.id === "string" || typeof message.id === "number") && typeof message.params?.threadId === "string") {
      const existing = this.entries.get(message.id)
      if (!existing) this.entries.set(message.id, { id: message.id, method: message.method, params: message.params, genioRequestToken: randomUUID() })
    }
    if (message.method === "serverRequest/resolved") this.entries.delete(message.params?.requestId)
    if (message.method === "turn/completed") {
      for (const [id, entry] of this.entries) {
        if (entry.params.threadId === message.params?.threadId && entry.params.turnId === (message.params?.turn?.id ?? message.params?.turnId)) this.entries.delete(id)
      }
    }
  }

  list(threadId: string) { return [...this.entries.values()].filter((entry) => entry.params.threadId === threadId) }

  async respond(threadId: string, token: string, result: unknown, send: (line: string) => Promise<void>) {
    const entry = [...this.entries.values()].find((entry) => entry.genioRequestToken === token && entry.params.threadId === threadId)
    if (!entry || this.sending.has(token)) throw new Error("BOT_INTERACTION_EXPIRED")
    this.sending.add(token)
    try {
      await send(JSON.stringify({ id: entry.id, result }))
      if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id)
    } finally { this.sending.delete(token) }
  }
}
