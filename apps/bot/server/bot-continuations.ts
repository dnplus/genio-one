import type { Database } from "bun:sqlite"
import type { BotInvocationRequest } from "./bot-invocation-store"
import type { Turn } from "./generated/v2/Turn"

export type BotContinuation = { invocation_id: string; bot_id: string; tenant_id: string; owner_id: string; peer_bot_id: string; task: string; result: string; outcome: string; client_id: string; thread_id: string | null; turn_id: string | null; state: string }

export class BotContinuations {
  constructor(private readonly db: Database, private readonly isFyi: (invocationId: string) => boolean = () => false) {
    db.exec(`create table if not exists bot_continuations (
      invocation_id text primary key, bot_id text not null, tenant_id text not null, owner_id text not null,
      peer_bot_id text not null, task text not null, result text not null, client_id text not null unique,
      thread_id text, turn_id text, state text not null default 'pending'
    )`)
    const columns = db.query("pragma table_info(bot_continuations)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "outcome")) db.exec("alter table bot_continuations add column outcome text not null default 'COMPLETED'")
  }

  enqueue(invocation: BotInvocationRequest) {
    if (this.isFyi(invocation.requestId)) return
    if (!["COMPLETED", "FAILED", "DENIED", "EXPIRED"].includes(invocation.state)) return
    if (invocation.state === "COMPLETED" && !invocation.resultSummary) return
    const result = invocation.resultSummary || invocation.decisionReason || (invocation.state === "COMPLETED" ? "工作已完成，沒有文字摘要。" : "交接未完成。")
    this.db.query(`insert or ignore into bot_continuations (invocation_id, bot_id, tenant_id, owner_id, peer_bot_id, task, result, client_id, outcome)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(invocation.requestId, invocation.callerBotId, invocation.tenantId, invocation.callerSubjectId, invocation.targetBotId, invocation.task, result, `handoff-result:${invocation.requestId}`, invocation.state)
  }

  pending() { return this.db.query("select * from bot_continuations where state in ('pending', 'starting', 'running') order by rowid").all() as BotContinuation[] }

  inputLabel(botId: string, clientId: string) {
    if (this.db.query("select 1 from bot_continuations where bot_id = ? and client_id = ?").get(botId, clientId)) return "收到隊友結果，接續處理"
    if (clientId.startsWith("handoff-task:") && this.db.query("select 1 from bot_invocations where target_bot_id = ? and request_id = ?").get(botId, clientId.slice("handoff-task:".length))) return this.isFyi(clientId.slice("handoff-task:".length)) ? "收到 FYI，空閒時讀取" : "收到交接工作"
    return null
  }

  inputHandoff(botId: string, clientId: string) {
    const prefix = clientId.startsWith("handoff-result:") ? "handoff-result:" : clientId.startsWith("handoff-task:") ? "handoff-task:" : null
    if (!prefix) return null
    const row = this.db.query(`select handoff_id from bot_handoffs where invocation_id = ? and
      ${prefix === "handoff-result:" ? "from_bot_id" : "to_bot_id"} = ?`)
      .get(clientId.slice(prefix.length), botId) as { handoff_id: string } | null
    return row?.handoff_id ?? null
  }

  claim(id: string, threadId: string) {
    return this.db.query("update bot_continuations set state = 'starting', thread_id = ? where invocation_id = ? and state = 'pending'").run(threadId, id).changes === 1
  }

  started(id: string, turnId: string) {
    this.db.query("update bot_continuations set state = 'running', turn_id = ? where invocation_id = ? and state = 'starting'").run(turnId, id)
  }

  observe(botId: string, threadId: string, method: string, params: any) {
    if ((method === "item/started" || method === "item/completed") && params.item?.type === "userMessage" && params.item.clientId) {
      this.db.query("update bot_continuations set state = 'running', turn_id = ? where bot_id = ? and thread_id = ? and client_id = ? and state = 'starting'").run(params.turnId, botId, threadId, params.item.clientId)
    }
    if (method === "turn/completed") {
      this.db.query("update bot_continuations set state = ? where bot_id = ? and thread_id = ? and turn_id = ? and state in ('starting', 'running')")
        .run(params.turn?.status === "completed" ? "completed" : "failed", botId, threadId, params.turn?.id ?? params.turnId)
    }
  }

  reconcile(entry: BotContinuation, turns: Turn[]) {
    const turn = turns.find((turn) => turn.items.some((item) => item.type === "userMessage" && item.clientId === entry.client_id))
    if (!turn) return false
    this.db.query("update bot_continuations set turn_id = ?, state = ? where invocation_id = ?")
      .run(turn.id, turn.status === "inProgress" ? "running" : turn.status === "completed" ? "completed" : "failed", entry.invocation_id)
    return true
  }
}
