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

const baseCapability = (resource_id: string, capability_id: string) => ({
  resource_id,
  resource_display_name: resource_id,
  capability_id,
  capability_display_name: capability_id,
  resource_owner_id: "org-engineering",
  resource_owner_display_name: "Engineering",
  connection_status: "READY",
  access: "ENTITLED",
  hub_status: "CONNECTED",
})

describe("Platform catalog personal connection overlay", () => {
  let cleanupDir: string | null = null
  let app: Awaited<ReturnType<typeof createBotApp>> | null = null
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.GENIO_ONE_PLATFORM_ORIGIN
  const originalCatalogMode = process.env.GENIO_BOT_CORP_CATALOG

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
    else process.env.GENIO_ONE_PLATFORM_ORIGIN = originalOrigin
    if (originalCatalogMode === undefined) delete process.env.GENIO_BOT_CORP_CATALOG
    else process.env.GENIO_BOT_CORP_CATALOG = originalCatalogMode
    if (app) await app.close()
    app = null
    if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true })
    cleanupDir = null
  })

  async function boot(mode: "full" | "empty" | "unavailable", mailStatus: "NEEDS_CONNECTION" | "SAVED" = "NEEDS_CONNECTION") {
    process.env.GENIO_ONE_PLATFORM_ORIGIN = "http://platform.test"
    process.env.GENIO_BOT_CORP_CATALOG = "platform"
    cleanupDir = mkdtempSync(join(tmpdir(), "bot-catalog-overlay-"))
    const db = join(cleanupDir, "registry.sqlite")
    const registry = new BotRegistry(db, join(cleanupDir, "artifacts"))

    const bot = registry.create(principal, { name: "Overlay Bot", description: "overlay" })
    const calls = new Map<string, number>()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/v1/identity/session")) {
        return new Response(JSON.stringify(principal), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (url.endsWith("/v1/tenants/tenant-keycloak-local/catalog")) {
        if (mode === "unavailable") return new Response("upstream unavailable", { status: 503 })
        if (mode === "empty") return new Response(JSON.stringify({ capabilities: [] }), { status: 200 })
        return new Response(JSON.stringify({ capabilities: [
          baseCapability("mail2000", "mcp.invoke"),
          { ...baseCapability("mail2000", "mcp.send"), access: "AUTO_GRANT" },
          { ...baseCapability("servicenow-csm", "mcp.invoke"), access: "AUTO_GRANT" },
          baseCapability("notion-resource", "mcp.invoke"),
          { ...baseCapability("genio-one-discovery", "search_resources"), builtin_service: "DISCOVERY" },
        ] }), { status: 200 })
      }
      const match = url.match(/\/me\/resource-connections\/([^/?]+)$/)
      if (match) {
        const resourceId = decodeURIComponent(match[1]!)
        calls.set(resourceId, (calls.get(resourceId) ?? 0) + 1)
        const connections = resourceId === "mail2000"
          ? [{ connection_id: "mail2000", display_name: "Mail2000", authentication: "PASSWORD", status: mailStatus }]
          : resourceId === "servicenow-csm"
            ? [{ connection_id: "servicenow-csm", display_name: "ServiceNow CSM", authentication: "OAUTH", status: "NEEDS_CONNECTION" }]
            : resourceId === "notion-resource"
              ? [{ connection_id: "notion", display_name: "Notion MCP", authentication: "OAUTH", status: "CONNECTED" }]
              : []
        return new Response(JSON.stringify(connections), { status: 200 })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch
    app = await createBotApp({ botRegistry: registry })
    return { botId: bot.id, calls, headers: { authorization: "Bearer test-token" } }
  }

  test("overlays each entitled resource once and keeps password SAVED available", async () => {
    const { botId, calls, headers } = await boot("full", "NEEDS_CONNECTION")
    const blocked = await app!.inject({ method: "GET", url: `/api/bots/${botId}/catalog-add`, headers })
    expect(blocked.statusCode).toBe(200)
    const blockedRows = (blocked.json() as { catalog: Array<{ resourceId: string; capabilityId: string; addState: string; connectionStatus: string }> }).catalog
    expect(blockedRows.find((row) => row.resourceId === "mail2000" && row.capabilityId === "mcp.invoke")).toMatchObject({ addState: "NEEDS_CONNECTION", connectionStatus: "NEEDS_CONNECTION" })
    expect(blockedRows.find((row) => row.resourceId === "servicenow-csm")).toMatchObject({ addState: "NEEDS_CONNECTION", connectionStatus: "NEEDS_CONNECTION" })
    expect(blockedRows.find((row) => row.resourceId === "notion-resource")).toMatchObject({ addState: "CONNECTED", connectionStatus: "CONNECTED" })
    expect(blockedRows.find((row) => row.resourceId === "genio-one-discovery")).toMatchObject({ builtinService: "DISCOVERY", addState: "CONNECTED" })
    expect(calls).toEqual(new Map([
      ["mail2000", 1],
      ["servicenow-csm", 1],
      ["notion-resource", 1],
      ["genio-one-discovery", 1],
    ]))

    await app!.close()
    app = null
    if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true })
    cleanupDir = null
    const saved = await boot("full", "SAVED")
    const savedResult = await app!.inject({ method: "GET", url: `/api/bots/${saved.botId}/catalog-add`, headers: saved.headers })
    const savedRow = (savedResult.json() as { catalog: Array<{ resourceId: string; capabilityId: string; addState: string; connectionStatus: string }> }).catalog.find((row) => row.resourceId === "mail2000" && row.capabilityId === "mcp.invoke")
    expect(savedRow).toMatchObject({ addState: "ENTITLED", connectionStatus: "AVAILABLE" })
  })

  test("empty or unavailable formal catalog never falls back to local fixture capabilities", async () => {
    for (const mode of ["empty", "unavailable"] as const) {
      const { botId, calls, headers } = await boot(mode)
      const result = await app!.inject({ method: "GET", url: `/api/bots/${botId}/catalog-add`, headers })
      expect(result.statusCode).toBe(mode === "empty" ? 200 : 400)
      if (mode === "empty") expect((result.json() as { catalog: unknown[] }).catalog).toEqual([])
      else expect(result.json<{ error: string }>().error).toBe("BOT_CATALOG_UNAVAILABLE")
      expect(calls.size).toBe(0)
      await app!.close()
      app = null
      if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true })
      cleanupDir = null
    }
  })
})
