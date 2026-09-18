import { randomBytes } from "node:crypto"
import type { GenioPrincipal } from "./runtime-broker"

export class BotToolSessions {
  private readonly sessions = new Map<string, { botId: string; principal: GenioPrincipal; accessToken: string; expiresAt: number }>()

  config(botId: string, principal: GenioPrincipal, accessToken: string) {
    for (const [key, session] of this.sessions) if (session.expiresAt <= Date.now()) this.sessions.delete(key)
    const token = randomBytes(32).toString("hex")
    this.sessions.set(token, { botId, principal, accessToken, expiresAt: Date.now() + 30 * 60_000 })
    return {
      url: `http://127.0.0.1:${process.env.GENIO_BOT_PORT || "5181"}/api/bot-tools`,
      http_headers: { Authorization: `Bearer ${token}` },
      default_tools_approval_mode: "auto",
      tools: { request_user_input_async: { approval_mode: "approve" }, update_work_summary: { approval_mode: "approve" } },
      required: false,
    }
  }

  resolve(authorization: string | undefined) {
    const session = this.sessions.get(authorization?.replace(/^Bearer /, "") ?? "")
    return session && session.expiresAt > Date.now() ? session : null
  }
}
