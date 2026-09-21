import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createBotApp } from "../app"
import { BotRegistry } from "../bot-registry"
import { CE_DEMO_USE_CASE_ID } from "@genioone/protocol/ce-demo"

const principal = {
  tenant_id: "tenant-uat",
  subject_id: "person-dylan",
  acting_client_id: "genio-one-bot",
  organization_ids: ["org-engineering"],
  scopes: ["genioone-invocation"],
}

describe("Bot creation usage context", () => {
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

  test("creates a Bot with the verified organization and active use case", async () => {
    cleanupDir = mkdtempSync(join(tmpdir(), "bot-usage-context-"))
    const registry = new BotRegistry(join(cleanupDir, "registry.sqlite"), join(cleanupDir, "artifacts"))
    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url.includes("/v1/identity/session")) return new Response(JSON.stringify(principal), { status: 200 })
      if (url.includes("/v1/tenants/tenant-uat/me/agents")) return new Response(JSON.stringify({ subject_id: "agent-dylan", kind: "AGENT" }), { status: 201 })
      if (url.includes("/v1/tenants/tenant-uat/organizations/org-engineering/use-cases")) return new Response(JSON.stringify([{
        tenant_id: "tenant-uat",
        organization_id: "org-engineering",
        use_case_id: "uat-purpose-dylan",
        display_name: "code-debug-document",
        risk_level: "LOW",
        state: "ACTIVE",
        created_at: 1,
      }]), { status: 200 })
      return new Response("not found", { status: 404 })
    }) as typeof fetch
    app = await createBotApp({ botRegistry: registry })
    const created = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers: { authorization: "Bearer user-token", "content-type": "application/json" },
      payload: { name: "Engineering Agent", modelRoute: "genio-gateway" },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      ownerOrganizationId: "org-engineering",
      useCaseId: "uat-purpose-dylan",
      agentSubjectId: "agent-dylan",
    })
  })

  test("does not create an Agent when the requested use case is outside the verified inventory", async () => {
    cleanupDir = mkdtempSync(join(tmpdir(), "bot-usage-context-deny-"))
    const registry = new BotRegistry(join(cleanupDir, "registry.sqlite"), join(cleanupDir, "artifacts"))
    let agentCalls = 0
    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url.includes("/v1/identity/session")) return new Response(JSON.stringify(principal), { status: 200 })
      if (url.includes("/v1/tenants/tenant-uat/organizations/org-engineering/use-cases")) return new Response(JSON.stringify([]), { status: 200 })
      if (url.includes("/v1/tenants/tenant-uat/me/agents")) {
        agentCalls += 1
        return new Response(JSON.stringify({ subject_id: "agent-dylan", kind: "AGENT" }), { status: 201 })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch
    app = await createBotApp({ botRegistry: registry })
    const denied = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers: { authorization: "Bearer user-token", "content-type": "application/json" },
      payload: { name: "Forged", useCaseId: "forged-purpose", modelRoute: "genio-gateway" },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error).toBe("USE_CASE_NOT_ALLOWED")
    expect(agentCalls).toBe(0)
    expect(registry.list(principal as never)).toHaveLength(0)
  })

  test("installs the Gemini demo with its verified use case and preserves the installed Bot", async () => {
    cleanupDir = mkdtempSync(join(tmpdir(), "bot-demo-install-"))
    const registry = new BotRegistry(join(cleanupDir, "registry.sqlite"), join(cleanupDir, "artifacts"))
    let agentCalls = 0
    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url.includes("/v1/identity/session")) return new Response(JSON.stringify(principal), { status: 200 })
      if (url.includes("/v1/tenants/tenant-uat/catalog")) return Response.json({ capabilities: [{
        resource_id: "genio.demo.gemini-bot",
        resource_kind: "EXTENSION",
        capability_id: "gemini-interviews",
        access: "ENTITLED",
        connection_status: "READY",
      }] })
      if (url.includes("/v1/tenants/tenant-uat/organizations/org-engineering/use-cases")) return Response.json([{
        tenant_id: "tenant-uat",
        organization_id: "org-engineering",
        use_case_id: "existing-use-case",
        display_name: "Existing use case",
        state: "ACTIVE",
      }, {
        tenant_id: "tenant-uat",
        organization_id: "org-engineering",
        use_case_id: CE_DEMO_USE_CASE_ID,
        display_name: "CE 示範專案",
        state: "ACTIVE",
      }])
      if (url.includes("/v1/tenants/tenant-uat/me/agents")) {
        agentCalls += 1
        return new Response(JSON.stringify({ subject_id: "agent-dylan", kind: "AGENT" }), { status: 201 })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch
    app = await createBotApp({ botRegistry: registry })
    const missingSelection = await app.inject({
      method: "POST",
      url: "/api/bots/install",
      headers: { authorization: "Bearer user-token", "content-type": "application/json" },
      payload: { resourceId: "genio.demo.gemini-bot", version: "1.0.0" },
    })
    expect(missingSelection.statusCode).toBe(409)
    expect(missingSelection.json().error).toBe("USE_CASE_SELECTION_REQUIRED")
    expect(agentCalls).toBe(0)
    const payload = {
      resourceId: "genio.demo.gemini-bot",
      version: "1.0.0",
      useCaseId: CE_DEMO_USE_CASE_ID,
    }
    const first = await app.inject({
      method: "POST",
      url: "/api/bots/install",
      headers: { authorization: "Bearer user-token", "content-type": "application/json" },
      payload,
    })
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({
      sourceResourceId: "genio.demo.gemini-bot",
      useCaseId: CE_DEMO_USE_CASE_ID,
      ownerOrganizationId: "org-engineering",
    })
    const second = await app.inject({
      method: "POST",
      url: "/api/bots/install",
      headers: { authorization: "Bearer user-token", "content-type": "application/json" },
      payload,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().id).toBe(first.json().id)
    expect(agentCalls).toBe(1)
  })
})
