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

describe("formal Platform USER_OAUTH connection proxy", () => {
  let cleanupDir: string | null = null
  let app: Awaited<ReturnType<typeof createBotApp>> | null = null
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.GENIO_ONE_PLATFORM_ORIGIN
  const forwardedBodies: string[] = []

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
    else process.env.GENIO_ONE_PLATFORM_ORIGIN = originalOrigin
    if (app) await app.close()
    app = null
    if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true })
    cleanupDir = null
  })

  async function boot(status: "CONNECTED" | "NEEDS_CONNECTION") {
    forwardedBodies.length = 0
    process.env.GENIO_ONE_PLATFORM_ORIGIN = "http://platform.test"
    cleanupDir = mkdtempSync(join(tmpdir(), "bot-platform-connection-"))
    const db = join(cleanupDir, "registry.sqlite")
    const registry = new BotRegistry(db, join(cleanupDir, "artifacts"))

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      forwardedBodies.push(String(init?.body ?? ""))
      const url = String(input)
      if (url.endsWith("/v1/identity/session")) {
        return new Response(JSON.stringify(principal), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (url.endsWith("/v1/tenants/tenant-keycloak-local/me/resource-connections/servicenow-csm")) {
        return new Response(JSON.stringify([{
          connection_id: "sn-connection",
          display_name: "ServiceNow CSM",
          authentication: "OAUTH",
          status,
        }]), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (url.endsWith("/v1/tenants/tenant-keycloak-local/me/resource-connections/servicenow-csm/sn-connection/authorize") && init?.method === "POST") {
        return new Response(JSON.stringify({
          authorization_url: "https://servicenow.example/authorize?state=platform-state",
          expires_at: Math.floor(Date.now() / 1000) + 600,
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch
    app = await createBotApp({ botRegistry: registry })
    return { headers: { authorization: "Bearer test-token", "content-type": "application/json" } }
  }

  test("starts and reports status from Platform without accepting a client completion code", async () => {
    const { headers } = await boot("NEEDS_CONNECTION")
    const started = await app!.inject({
      method: "POST",
      url: "/api/connections/servicenow-csm/oauth/start",
      headers,
      payload: {},
    })
    expect(started.statusCode).toBe(201)
    expect(started.json()).toMatchObject({
      status: "NEEDS_CONNECTION",
      provider: "platform",
      connectionId: "sn-connection",
      addState: "NEEDS_CONNECTION",
    })
    expect((started.json() as { state?: string }).state).toBeUndefined()

    const complete = await app!.inject({
      method: "POST",
      url: "/api/connections/servicenow-csm/oauth/complete",
      headers,
      payload: { state: "forged", code: "ok" },
    })
    expect(complete.statusCode).toBe(404)
    expect(forwardedBodies.some(body => body.includes("forged"))).toBe(false)
  })

  test("returns connected only when the Platform binding is connected", async () => {
    const { headers } = await boot("CONNECTED")
    const status = await app!.inject({
      method: "GET",
      url: "/api/connections/servicenow-csm/oauth/status?connectionId=sn-connection",
      headers,
    })
    expect(status.statusCode).toBe(200)
    expect(status.json() as Record<string, unknown>).toEqual({
      status: "CONNECTED",
      provider: "platform",
      connectionId: "sn-connection",
      addState: "CONNECTED",
    })
  })
})
