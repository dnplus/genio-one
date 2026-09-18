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

describe("UX P1-a handoff HTTP", () => {
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

  test.each(["ack", "item", "completed"] as const)("POST handoff with %s arriving first; other turns and duplicate dispatch excluded", async (first) => {
    cleanupDir = mkdtempSync(join(tmpdir(), "bot-handoff-http-"))
    const registry = new BotRegistry(join(cleanupDir, "registry.sqlite"), join(cleanupDir, "artifacts"))
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/me/agents")) return Response.json({ subject_id: "agent-test", kind: "AGENT" }, { status: 201 })
      if (url.includes("/v1/identity/session")) {
        return new Response(JSON.stringify(principal), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    let targetTurns = 0
    let finishTarget: (() => void) | undefined
    let started!: () => void
    const targetStarted = new Promise<void>((resolve) => { started = resolve })
    app = await createBotApp({ botRegistry: registry, createCodexRuntime: (_token, callbacks) => ({
      async send(line) {
        const request = JSON.parse(line)
        if (request.method === "initialize") callbacks.onMessage(JSON.stringify({ id: request.id, result: {} }))
        if (request.method === "thread/resume") callbacks.onMessage(JSON.stringify({ id: request.id, error: { code: -32600, message: "no rollout found for thread id missing-thread" } }))
        if (request.method === "thread/start") callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: "contract-target-thread" } } }))
        if (request.method === "turn/start") {
          targetTurns++
          const input = { id: "target-input", type: "userMessage", clientId: request.params.clientUserMessageId, content: request.params.input }
          if (first === "ack") callbacks.onMessage(JSON.stringify({ id: request.id, result: { turn: { id: "target-turn" } } }))
          if (first === "item") callbacks.onMessage(JSON.stringify({ method: "item/started", params: { threadId: "contract-target-thread", turnId: "target-turn", item: input } }))
          callbacks.onMessage(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "contract-target-thread", turnId: "other-turn", itemId: "other", delta: "Unrelated result" } }))
          callbacks.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId: "contract-target-thread", turn: { id: "other-turn", status: "completed", items: [] } } }))
          finishTarget = () => {
            callbacks.onMessage(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "contract-target-thread", turnId: "target-turn", itemId: "answer", delta: "已確認工單升級" } }))
            callbacks.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId: "contract-target-thread", turn: { id: "target-turn", status: "completed", items: [input, { id: "answer", type: "agentMessage", text: "已確認工單升級" }] } } }))
          }
          started()
        }
      },
      async close() {},
    }) })
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" }

    const aqua = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers,
      payload: { name: "阿庫婭", title: "Aqua", description: "發起交接" },
    })
    const dark = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers,
      payload: { name: "達克妮絲", title: "Darkness", description: "接收交接" },
    })
    const meg = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers,
      payload: { name: "惠惠", title: "Megumin", description: "第三人" },
    })
    const aquaId = (aqua.json() as { id: string }).id
    const darkId = (dark.json() as { id: string }).id
    const megId = (meg.json() as { id: string }).id
    registry.rememberThread(darkId, "missing-thread")
    registry.saveSession({ botId: darkId, appServerThreadId: "missing-thread" })

    const created = await app.inject({
      method: "POST",
      url: "/api/bot-handoffs",
      headers,
      payload: {
        fromBotId: aquaId,
        toBotId: darkId,
        fact: "工單 CS001284 已升級",
        kind: "task",
      },
    })
    expect(created.statusCode).toBe(201)
    const ack = created.json() as {
      handoffId: string
      async: boolean
      processed: boolean
      state: string
      events: Array<{ type: string }>
    }
    expect(ack.async).toBe(true)
    expect(ack.processed).toBe(false)
    expect(ack.state).toBe("ACKED")
    expect(ack.events.some((e) => e.type === "handoff.acked")).toBe(true)
    await targetStarted
    expect(targetTurns).toBe(1)
    expect(registry.listHandoffEvents(principal, aquaId).some((event) => event.type === "handoff.replied")).toBe(false)
    finishTarget!()

    const blocked = await app.inject({
      method: "POST",
      url: "/api/bot-handoffs",
      headers,
      payload: {
        fromBotId: aquaId,
        toBotIds: [darkId, megId],
        fact: "無腦廣播",
      },
    })
    expect(blocked.statusCode).toBe(400)
    expect((blocked.json() as { error: string }).error).toBe("HANDOFF_FAN_OUT_REQUIRES_EXPLICIT")

    const events = await app.inject({
      method: "GET",
      url: `/api/bots/${aquaId}/handoff-events`,
      headers,
    })
    expect(events.statusCode).toBe(200)
    expect((events.json() as unknown[]).length).toBeGreaterThan(0)

    const processed = await app.inject({
      method: "POST",
      url: `/api/bot-handoffs/${ack.handoffId}/process`,
      headers,
      payload: {},
    })
    expect(processed.statusCode).toBe(200)
    expect((processed.json() as { processed: boolean; state: string }).processed).toBe(true)
    expect((processed.json() as { state: string }).state).toBe("COMPLETED")
    expect(targetTurns).toBe(1)
    expect(registry.listHandoffEvents(principal, aquaId).filter((event) => event.type === "handoff.replied")).toHaveLength(1)
    expect(registry.readTimeline(principal, darkId).some((message) => message.text === "已確認工單升級")).toBe(true)
    expect(registry.getSessionThreads(darkId).find((segment) => segment.threadId === "missing-thread")?.historyStatus).toBe("unavailable")
  })
})
