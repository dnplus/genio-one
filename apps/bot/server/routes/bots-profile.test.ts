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

describe("slice A BotProfile HTTP create + read-back", () => {
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

  test("POST /api/bots then GET /api/bots/:botId returns live profile fields", async () => {
    cleanupDir = mkdtempSync(join(tmpdir(), "bot-profile-"))
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
    const created = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      payload: {
        name: "Aqua",
        title: "切片驗證員",
        description: "驗證 server-side BotProfile read-back；不以 localStorage 當 SoT。",
        avatar: { shape: "galet", color: "turquoise", expression: "neutre" },
        modelRoute: "codex-subscription",
      },
    })
    expect(created.statusCode).toBe(201)
    const body = created.json() as { id: string; title: string; description: string; tenantId: string; ownerSubjectId: string }
    expect(body.id).toStartWith("bot-")
    expect(body.title).toBe("切片驗證員")
    expect(body.description).toContain("read-back")
    expect(body.tenantId).toBe(principal.tenant_id)
    expect(body.ownerSubjectId).toBe(principal.subject_id)

    const readBack = await app.inject({
      method: "GET",
      url: `/api/bots/${body.id}`,
      headers: { authorization: "Bearer test-token" },
    })
    expect(readBack.statusCode).toBe(200)
    const profile = readBack.json() as Record<string, unknown>
    expect(profile.botId).toBe(body.id)
    expect(profile.name).toBe("Aqua")
    expect(profile.title).toBe("切片驗證員")
    expect(profile.description).toBe("驗證 server-side BotProfile read-back；不以 localStorage 當 SoT。")
    expect(profile.modelRoute).toBe("codex-subscription")
    expect(profile.tenantId).toBe(principal.tenant_id)
    expect(profile.ownerSubjectId).toBe(principal.subject_id)
    expect(typeof profile.createdAt).toBe("number")
    expect(typeof profile.updatedAt).toBe("number")
    expect(profile.avatar).toEqual({ shape: "galet", color: "turquoise", expression: "neutre" })

    const listed = await app.inject({
      method: "GET",
      url: "/api/bots",
      headers: { authorization: "Bearer test-token" },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toHaveLength(1)
  })
})
