import { randomBytes } from "node:crypto"
import type { GenioPrincipal } from "./runtime-broker"

export interface BotToolSession {
  runtimeSessionId: string
  botId: string
  principal: GenioPrincipal
  accessToken?: string
  invocationId?: string
}

export interface InvocationBotToolSession {
  config: ReturnType<BotToolSessions["config"]>
  release: () => void
}

export class BotToolSessions {
  private readonly sessions = new Map<string, BotToolSession>()
  private readonly tokens = new Map<string, string>()

  config(botId: string, principal: GenioPrincipal, runtimeSessionId: string) {
    const key = this.key(runtimeSessionId, botId)
    const existing = this.tokens.get(key)
    if (existing && this.sessions.has(existing)) return this.configFor(existing)
    const token = this.token()
    this.sessions.set(token, { runtimeSessionId, botId, principal })
    this.tokens.set(key, token)
    return this.configFor(token)
  }

  bindInvocation(runtimeSessionId: string, botId: string, principal: GenioPrincipal, invocationId: string, accessToken: string): InvocationBotToolSession {
    const key = this.key(runtimeSessionId, botId)
    const tokenValue = accessToken.trim()
    if (!tokenValue || !invocationId.trim()) throw new Error("BOT_TOOL_INVOCATION_INVALID")
    const config = this.config(botId, principal, runtimeSessionId)
    const token = this.tokens.get(key)!
    const session = this.sessions.get(token)!
    if (!samePrincipal(session.principal, principal)) throw new Error("BOT_TOOL_SESSION_PRINCIPAL_MISMATCH")
    const boundInvocationId = invocationId.trim()
    if (session.invocationId && session.invocationId !== boundInvocationId) throw new Error("BOT_TOOL_INVOCATION_CONFLICT")
    session.accessToken = tokenValue
    session.invocationId = boundInvocationId
    let released = false
    return {
      config,
      release: () => {
        if (released) return
        released = true
        const current = this.sessions.get(token)
        if (current?.invocationId === boundInvocationId) {
          delete current.accessToken
          delete current.invocationId
        }
      },
    }
  }

  resolve(authorization: string | undefined) {
    return this.sessions.get(authorization?.replace(/^Bearer /, "") ?? "") ?? null
  }

  invalidate(authorization: string | undefined) {
    const token = authorization?.replace(/^Bearer /, "") ?? ""
    const session = this.sessions.get(token)
    if (!session) return
    this.sessions.delete(token)
    const key = this.key(session.runtimeSessionId, session.botId)
    if (this.tokens.get(key) === token) this.tokens.delete(key)
  }

  private configFor(token: string) {
    return {
      url: `http://127.0.0.1:${process.env.GENIO_BOT_PORT || "5181"}/api/bot-tools`,
      http_headers: { Authorization: `Bearer ${token}` },
      default_tools_approval_mode: "auto",
      tools: { request_user_input_async: { approval_mode: "approve" }, update_work_summary: { approval_mode: "approve" } },
      required: false,
    }
  }

  private key(runtimeSessionId: string, botId: string) {
    const runtime = runtimeSessionId.trim()
    const bot = botId.trim()
    if (!runtime || !bot) throw new Error("BOT_TOOL_SESSION_INVALID")
    return `${runtime}\u0000${bot}`
  }

  private token() {
    return randomBytes(32).toString("hex")
  }
}

function samePrincipal(left: GenioPrincipal, right: GenioPrincipal) {
  return left.tenant_id === right.tenant_id && left.subject_id === right.subject_id && left.acting_client_id === right.acting_client_id
}
