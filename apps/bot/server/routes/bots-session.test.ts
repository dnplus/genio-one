import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createBotApp } from "../app"
import { BotRegistry } from "../bot-registry"

const principal = {
  tenant_id: "tenant-keycloak-local",
  subject_id: "person-owner",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

describe("slice B BotSession HTTP + roster projection", () => {
  let cleanupDir: string | null = null
  let app: Awaited<ReturnType<typeof createBotApp>> | null = null
  const originalFetch = globalThis.fetch

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (app) await app.close()
    app = null
    if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true })
    cleanupDir = null
  })

  test("session persists across bot switch + roster projects unread/working", async () => {
    cleanupDir = mkdtempSync(join(tmpdir(), "bot-session-"))
    const registry = new BotRegistry(join(cleanupDir, "registry.sqlite"), join(cleanupDir, "artifacts"))
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/me/agents")) return Response.json({ subject_id: "agent-test", kind: "AGENT" }, { status: 201 })
      if (url.includes("/v1/identity/session")) {
        return new Response(JSON.stringify(principal), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    app = await createBotApp({ botRegistry: registry })
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" }

    const aqua = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers,
      payload: { name: "阿庫婭", title: "切片B", description: "server BotSession" },
    })
    expect(aqua.statusCode).toBe(201)
    const aquaId = (aqua.json() as { id: string }).id

    const darkness = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers,
      payload: { name: "達克妮絲", title: "另一隻", description: "切換不丟 session" },
    })
    const darkId = (darkness.json() as { id: string }).id

    registry.rememberThread(aquaId, "thread-aqua-1")
    registry.rememberThread(darkId, "thread-dark-1")
    const rejected = await app.inject({
      method: "PUT", url: `/api/bots/${darkId}/session`, headers,
      payload: { appServerThreadId: "thread-aqua-1" },
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().error).toBe("BOT_THREAD_NOT_OWNED")
    const saved = await app.inject({
      method: "PUT",
      url: `/api/bots/${aquaId}/session`,
      headers,
      payload: { appServerThreadId: "thread-aqua-1", activeRuntimeTier: "none", memoryPointer: "mem-aqua" },
    })
    expect(saved.statusCode).toBe(200)
    expect((saved.json() as { appServerThreadId: string }).appServerThreadId).toBe("thread-aqua-1")

    await app.inject({
      method: "PUT",
      url: `/api/bots/${darkId}/session`,
      headers,
      payload: { appServerThreadId: "thread-dark-1", activeRuntimeTier: "headless" },
    })

    const started = await app.inject({
      method: "POST",
      url: `/api/bots/${aquaId}/session/events`,
      headers,
      payload: { type: "turn_started" },
    })
    expect(started.statusCode).toBe(400)
    registry.recordRuntimeEvent(principal, JSON.stringify({ method: "turn/started", params: { threadId: "thread-aqua-1", turn: { id: "native-turn", status: "inProgress", items: [] } } }))
    expect(registry.getSession(aquaId)?.workState).toBe("working")

    const completed = await app.inject({
      method: "POST",
      url: `/api/bots/${aquaId}/session/events`,
      headers,
      payload: { type: "turn_completed" },
    })
    expect(completed.statusCode).toBe(400)
    const completion = JSON.stringify({ method: "turn/completed", params: { threadId: "thread-aqua-1", turn: { id: "native-turn", status: "completed", items: [] } } })
    registry.recordRuntimeEvent(principal, completion)
    const completedBody = registry.getSession(aquaId)!
    expect(completedBody.workState).toBe("idle")
    expect(completedBody.unread).toBe(true)
    expect(completedBody.appServerThreadId).toBe("thread-aqua-1")

    const roster = await app.inject({ method: "GET", url: "/api/bots/roster", headers })
    expect(roster.statusCode).toBe(200)
    const entries = roster.json() as Array<{ bot: { id: string }; session: { unread: boolean; appServerThreadId: string | null; workState: string } }>
    expect(entries).toHaveLength(2)
    const aquaEntry = entries.find((entry) => entry.bot.id === aquaId)!
    const darkEntry = entries.find((entry) => entry.bot.id === darkId)!
    expect(aquaEntry.session.unread).toBe(true)
    expect((roster.json() as Array<{ summary?: unknown }>).every((entry) => entry.summary !== undefined)).toBe(true)
    expect(aquaEntry.session.appServerThreadId).toBe("thread-aqua-1")
    expect(darkEntry.session.appServerThreadId).toBe("thread-dark-1")

    // switch focus → viewed clears unread; other bot session untouched
    const loaded = await app.inject({ method: "GET", url: `/api/bots/${aquaId}/timeline`, headers })
    const missingVersion = await app.inject({ method: "POST", url: `/api/bots/${aquaId}/session/events`, headers, payload: { type: "viewed" } })
    expect(missingVersion.statusCode).toBe(409)
    const viewed = await app.inject({
      method: "POST",
      url: `/api/bots/${aquaId}/session/events`,
      headers,
      payload: { type: "viewed", version: loaded.headers.etag },
    })
    expect((viewed.json() as { unread: boolean }).unread).toBe(false)
    registry.recordRuntimeEvent(principal, completion)
    expect(registry.getSession(aquaId)?.unread).toBe(false)
    registry.recordRuntimeEvent(principal, JSON.stringify({ method: "turn/completed", params: { threadId: "thread-aqua-1", turn: { id: "new-result", status: "completed", items: [{ type: "agentMessage", id: "new-answer", text: "new reply" }] } } }))
    const stale = await app.inject({ method: "POST", url: `/api/bots/${aquaId}/session/events`, headers, payload: { type: "viewed", version: loaded.headers.etag } })
    expect(stale.statusCode).toBe(409)
    expect(registry.getSession(aquaId)?.unread).toBe(true)
    const bypass = await app.inject({ method: "PUT", url: `/api/bots/${aquaId}/session`, headers, payload: { unread: false } })
    expect(bypass.statusCode).toBe(400)
    expect(registry.getSession(aquaId)?.unread).toBe(true)

    const rereadDark = await app.inject({
      method: "GET",
      url: `/api/bots/${darkId}/session`,
      headers,
    })
    expect((rereadDark.json() as { appServerThreadId: string }).appServerThreadId).toBe("thread-dark-1")
  })
})
