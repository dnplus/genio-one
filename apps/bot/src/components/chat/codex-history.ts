import type { Turn } from "../../../server/generated/v2/Turn"
import type { CodexClient } from "../../lib/codex-client"
export { reconstructTurnMessages, runtimeActivityDetails } from "../../../shared/bot-timeline"

export async function readEarlierCodexTurns(client: Pick<CodexClient, "request">, threadId: string, botId: string) {
  await client.request("thread/resume", { threadId, excludeTurns: true, approvalPolicy: "never", sandbox: "read-only" }, botId)
  return readCodexTurns(client, threadId, botId)
}

export async function readCodexTurns(client: Pick<CodexClient, "request">, threadId: string, botId?: string) {
  const turns = new Map<string, Turn>()
  let cursor: string | undefined
  do {
    const page = await client.request("thread/turns/list", {
      threadId, cursor, limit: 50, sortDirection: "asc", itemsView: "full",
    }, botId) as { data: Turn[]; nextCursor: string | null }
    for (const turn of page.data) turns.set(turn.id, turn)
    if (page.nextCursor && page.nextCursor === cursor) throw new Error("CODEX_HISTORY_CURSOR_STALLED")
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return [...turns.values()]
}
