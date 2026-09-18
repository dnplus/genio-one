import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createBotApp } from "../app"
import { BotRegistry } from "../bot-registry"
import {
  assertDesignerReadBack,
  designerCreatePayload,
  type BotDesignerDraft,
} from "../bot-designer"

const principal = {
  tenant_id: "tenant-keycloak-local",
  subject_id: "person-owner",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

const draft: BotDesignerDraft = {
  name: "阿庫婭",
  oneJob: "把模糊需求收成可驗收切片",
  antiJobs: "不代寄信、不擅自啟用 routine、不裝市集插件",
  voice: "直球、短句、可靠",
  wake: "chat",
  avatar: { shape: "galet", color: "turquoise", expression: "neutre" },
}

describe("slice D Bot Designer HTTP create + read-back", () => {
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

  test("designer CreateBot → GET profile matches input; private; no skills/bindings; session ready", async () => {
    cleanupDir = mkdtempSync(join(tmpdir(), "bot-designer-"))
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
    const payload = designerCreatePayload(draft)
    const created = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      payload,
    })
    expect(created.statusCode).toBe(201)
    const body = created.json() as {
      id: string
      skills: string[]
      bindings: unknown[]
      sharePolicy: { visibility: string }
      antiJobs: string
      voice: string
      wake: string
      modelRoute: string
    }
    expect(body.skills).toEqual([])
    expect(body.bindings).toEqual([])
    expect(body.sharePolicy.visibility).toBe("PRIVATE")
    expect(body.antiJobs).toBe(draft.antiJobs)
    expect(body.voice).toBe(draft.voice)
    expect(body.wake).toBe(draft.wake)
    expect(body.modelRoute).toBe(payload.modelRoute)

    const readBack = await app.inject({
      method: "GET",
      url: `/api/bots/${body.id}`,
      headers: { authorization: "Bearer test-token" },
    })
    expect(readBack.statusCode).toBe(200)
    const profile = readBack.json() as {
      botId: string
      name: string
      title: string
      description: string
      antiJobs: string
      voice: string
      wake: string
      modelRoute: string
      visibility: string
    }
    assertDesignerReadBack(draft, profile)
    expect(profile.visibility).toBe("PRIVATE")

    // Conversation-ready: roster projects a BotSession (idle) without enabling routines
    const roster = await app.inject({
      method: "GET",
      url: "/api/bots/roster",
      headers: { authorization: "Bearer test-token" },
    })
    expect(roster.statusCode).toBe(200)
    const entries = roster.json() as Array<{ bot: { id: string }; session: { workState: string; appServerThreadId: string | null } }>
    expect(entries).toHaveLength(1)
    expect(entries[0]!.bot.id).toBe(body.id)
    expect(entries[0]!.session.workState).toBe("idle")
  })
})
