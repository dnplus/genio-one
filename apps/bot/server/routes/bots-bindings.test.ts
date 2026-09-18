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

const catalogCaps = [
  {
    resource_id: "servicenow-csm",
    resource_display_name: "ServiceNow CSM",
    capability_id: "servicenow.csm.read_case",
    capability_display_name: "Read case",
    access: "ENTITLED",
    hub_status: "AVAILABLE",
    connection_status: "IDLE",
    approval_policy_ref: "policy/one-default",
    skill_id: "servicenow-csm",
  },
  {
    resource_id: "jira",
    resource_display_name: "Jira",
    capability_id: "jira.issue.read",
    capability_display_name: "Read issue",
    access: "REQUEST",
    hub_status: "AVAILABLE",
    connection_status: "READY",
  },
  {
    resource_id: "slack",
    resource_display_name: "Slack",
    capability_id: "slack.post",
    capability_display_name: "Post message",
    access: "AUTO_GRANT",
    hub_status: "REQUEST_ACCESS",
    connection_status: "UNAVAILABLE",
  },
  {
    resource_id: "github",
    resource_display_name: "GitHub",
    capability_id: "github.pr.read",
    capability_display_name: "Read PR",
    access: "AUTO_GRANT",
    hub_status: "CONNECTED",
    connection_status: "READY",
  },
  {
    resource_id: "secret-vault",
    resource_display_name: "Vault",
    capability_id: "vault.read",
    capability_display_name: "Read secret",
    access: "DENIED",
    hub_status: "AVAILABLE",
    connection_status: "READY",
    denial_reason: "policy_denied",
  },
]

describe("slice C BotBinding + catalog Add state machine", () => {
  let cleanupDir: string | null = null
  let app: Awaited<ReturnType<typeof createBotApp>> | null = null
  const originalFetch = globalThis.fetch
  const originalCorpCatalog = process.env.GENIO_BOT_CORP_CATALOG

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalCorpCatalog === undefined) delete process.env.GENIO_BOT_CORP_CATALOG
    else process.env.GENIO_BOT_CORP_CATALOG = originalCorpCatalog
    if (app) await app.close()
    app = null
    if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true })
    cleanupDir = null
  })

  test("Add states: ENTITLED installs, REQUEST pending, NEEDS_CONNECTION blocked, CONNECTED installs, DENIED kept, missing=denied", async () => {
    process.env.GENIO_BOT_CORP_CATALOG = "platform"
    cleanupDir = mkdtempSync(join(tmpdir(), "bot-bindings-"))
    const registry = new BotRegistry(join(cleanupDir, "registry.sqlite"), join(cleanupDir, "artifacts"))
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/me/agents")) return Response.json({ subject_id: "agent-test", kind: "AGENT" }, { status: 201 })
      if (url.includes("/v1/identity/session")) {
        return new Response(JSON.stringify(principal), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (url.includes("/catalog")) {
        return new Response(JSON.stringify({ capabilities: catalogCaps }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/me/resource-connections/")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    app = await createBotApp({ botRegistry: registry })
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" }

    const created = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers,
      payload: { name: "阿庫婭", title: "切片C", description: "BotBinding + Add" },
    })
    expect(created.statusCode).toBe(201)
    const botId = (created.json() as { id: string; bindings: unknown[] }).id
    expect((created.json() as { bindings: unknown[] }).bindings).toEqual([])

    const projection = await app.inject({ method: "GET", url: `/api/bots/${botId}/catalog-add`, headers })
    expect(projection.statusCode).toBe(200)
    const rows = (projection.json() as { catalog: Array<{ capabilityId: string; addState: string }> }).catalog
    expect(rows.find((r) => r.capabilityId === "servicenow.csm.read_case")?.addState).toBe("ENTITLED")
    expect(rows.find((r) => r.capabilityId === "jira.issue.read")?.addState).toBe("REQUEST")
    expect(rows.find((r) => r.capabilityId === "slack.post")?.addState).toBe("NEEDS_CONNECTION")
    expect(rows.find((r) => r.capabilityId === "github.pr.read")?.addState).toBe("CONNECTED")
    expect(rows.find((r) => r.capabilityId === "vault.read")?.addState).toBe("DENIED")

    const entitled = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/bindings/add`,
      headers,
      payload: { resourceId: "servicenow-csm", capabilityId: "servicenow.csm.read_case" },
    })
    expect(entitled.statusCode).toBe(201)
    const entitledBody = entitled.json() as { addState: string; binding: { state: string; approvalPolicyRef: string | null; skillId: string | null } }
    expect(entitledBody.addState).toBe("ENTITLED")
    expect(entitledBody.binding.state).toBe("INSTALLED")
    expect(entitledBody.binding.approvalPolicyRef).toBe("policy/one-default")
    expect(entitledBody.binding.skillId).toBe("servicenow-csm")

    const requestAdd = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/bindings/add`,
      headers,
      payload: { resourceId: "jira", capabilityId: "jira.issue.read" },
    })
    expect(requestAdd.statusCode).toBe(202)
    expect((requestAdd.json() as { binding: { state: string; reason: string } }).binding.state).toBe("PENDING")
    expect((requestAdd.json() as { binding: { reason: string } }).binding.reason).toBe("access_request_required")

    const needsConn = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/bindings/add`,
      headers,
      payload: { resourceId: "slack", capabilityId: "slack.post" },
    })
    expect(needsConn.statusCode).toBe(409)
    expect((needsConn.json() as { error: string }).error).toBe("BOT_CONNECTION_REQUIRED")

    const connected = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/bindings/add`,
      headers,
      payload: { resourceId: "github", capabilityId: "github.pr.read" },
    })
    expect(connected.statusCode).toBe(201)
    expect((connected.json() as { addState: string; binding: { state: string } }).addState).toBe("CONNECTED")
    expect((connected.json() as { binding: { state: string } }).binding.state).toBe("INSTALLED")

    const denied = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/bindings/add`,
      headers,
      payload: { resourceId: "secret-vault", capabilityId: "vault.read" },
    })
    expect(denied.statusCode).toBe(403)
    expect((denied.json() as { binding: { state: string; reason: string } }).binding.state).toBe("DENIED")

    const missing = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/bindings/add`,
      headers,
      payload: { resourceId: "ghost", capabilityId: "ghost.tool" },
    })
    expect(missing.statusCode).toBe(403)
    expect((missing.json() as { reason: string }).reason).toContain("capability_not_in_catalog")

    const listed = await app.inject({ method: "GET", url: `/api/bots/${botId}/bindings`, headers })
    expect(listed.statusCode).toBe(200)
    const bindings = listed.json() as Array<{ capabilityId: string; state: string }>
    expect(bindings.some((b) => b.capabilityId === "servicenow.csm.read_case" && b.state === "INSTALLED")).toBe(true)
    expect(bindings.some((b) => b.capabilityId === "jira.issue.read" && b.state === "PENDING")).toBe(true)
    expect(bindings.some((b) => b.capabilityId === "slack.post")).toBe(false)
  })
})

describe("resource binding HTTP lifecycle", () => {
  const owner = {
    tenant_id: "tenant-binding-lifecycle",
    subject_id: "person-owner",
    acting_client_id: "genio-one-bot",
    scopes: ["genioone-invocation"],
  }
  const otherOwner = { ...owner, subject_id: "person-other" }
  const foreignOwner = { ...owner, tenant_id: "tenant-other" }
  const catalog = [
    {
      resource_id: "mail2000",
      resource_display_name: "Mail2000",
      capability_id: "mcp.invoke",
      capability_display_name: "Mail invoke",
      access: "ENTITLED",
      hub_status: "AVAILABLE",
      connection_status: "IDLE",
    },
    {
      resource_id: "mail2000",
      resource_display_name: "Mail2000",
      capability_id: "mcp.list_mailboxes",
      capability_display_name: "List mailboxes",
      access: "ENTITLED",
      hub_status: "AVAILABLE",
      connection_status: "IDLE",
    },
    {
      resource_id: "servicenow-csm",
      resource_display_name: "ServiceNow CSM",
      capability_id: "mcp.invoke",
      capability_display_name: "ServiceNow invoke",
      access: "ENTITLED",
      hub_status: "AVAILABLE",
      connection_status: "IDLE",
    },
    {
      resource_id: "genio-one-discovery",
      resource_display_name: "Discovery",
      capability_id: "search_resources",
      capability_display_name: "Search resources",
      access: "AUTO_GRANT",
      hub_status: "CONNECTED",
      connection_status: "READY",
      builtin_service: "DISCOVERY",
    },
  ]
  let cleanupDir: string | null = null
  let app: Awaited<ReturnType<typeof createBotApp>> | null = null
  const originalFetch = globalThis.fetch
  const originalCorpCatalog = process.env.GENIO_BOT_CORP_CATALOG

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalCorpCatalog === undefined) delete process.env.GENIO_BOT_CORP_CATALOG
    else process.env.GENIO_BOT_CORP_CATALOG = originalCorpCatalog
    if (app) await app.close()
    app = null
    if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true })
    cleanupDir = null
  })

  test("adds, reads back, removes one resource, and rejects other owners", async () => {
    process.env.GENIO_BOT_CORP_CATALOG = "platform"
    cleanupDir = mkdtempSync(join(tmpdir(), "bot-binding-lifecycle-"))
    const registry = new BotRegistry(join(cleanupDir, "registry.sqlite"), join(cleanupDir, "artifacts"))
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/me/agents")) return Response.json({ subject_id: "agent-test", kind: "AGENT" }, { status: 201 })
      const bearer = new Headers(init?.headers).get("authorization") || ""
      const token = bearer.startsWith("Bearer ") ? bearer.slice("Bearer ".length) : ""
      if (url.includes("/v1/identity/session")) {
        const identity = token === "owner-token" ? owner : token === "other-token" ? otherOwner : token === "foreign-token" ? foreignOwner : null
        return new Response(identity ? JSON.stringify(identity) : "unauthorized", {
          status: identity ? 200 : 401,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.endsWith("/catalog")) {
        return new Response(JSON.stringify({ capabilities: catalog }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/me/resource-connections/")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    app = await createBotApp({ botRegistry: registry })
    const ownerHeaders = { authorization: "Bearer owner-token", "content-type": "application/json" }
    const ownerAuthHeaders = { authorization: "Bearer owner-token" }
    const otherHeaders = { authorization: "Bearer other-token" }
    const foreignHeaders = { authorization: "Bearer foreign-token" }

    const created = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers: ownerHeaders,
      payload: { name: "Sales Agent", title: "Sales", description: "Mail and CRM" },
    })
    expect(created.statusCode).toBe(201)
    const botId = (created.json() as { id: string }).id

    const forged = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/bindings/add`,
      headers: ownerHeaders,
      payload: { resourceId: "mail2000", capabilityId: "mcp.invoke", state: "DENIED", ownerSubjectId: "person-other" },
    })
    expect(forged.statusCode).toBe(201)
    expect((forged.json() as { binding: { state: string } }).binding.state).toBe("INSTALLED")

    for (const payload of [
      { resourceId: "mail2000", capabilityId: "mcp.list_mailboxes" },
      { resourceId: "servicenow-csm", capabilityId: "mcp.invoke" },
      { resourceId: "genio-one-discovery", capabilityId: "search_resources" },
    ]) {
      const added = await app.inject({ method: "POST", url: `/api/bots/${botId}/bindings/add`, headers: ownerHeaders, payload })
      expect(added.statusCode).toBe(201)
      expect((added.json() as { binding: { resourceId: string; capabilityId: string; state: string } }).binding).toMatchObject({
        ...payload,
        state: "INSTALLED",
      })
    }

    const afterAdd = await app.inject({ method: "GET", url: `/api/bots/${botId}/bindings`, headers: ownerAuthHeaders })
    expect(afterAdd.statusCode).toBe(200)
    const bindingsAfterAdd = afterAdd.json() as Array<{ resourceId: string; capabilityId: string; state: string }>
    expect(bindingsAfterAdd).toHaveLength(4)
    expect(bindingsAfterAdd.filter((binding) => binding.resourceId === "mail2000")).toHaveLength(2)
    expect(bindingsAfterAdd.filter((binding) => binding.capabilityId === "mcp.invoke")).toHaveLength(2)
    const rosterAfterAdd = await app.inject({ method: "GET", url: "/api/bots/roster", headers: ownerAuthHeaders })
    expect(rosterAfterAdd.statusCode).toBe(200)
    expect((rosterAfterAdd.json() as Array<{ bot: { id: string; bindings: unknown[] } }>).find((entry) => entry.bot.id === botId)?.bot.bindings).toHaveLength(4)

    const removed = await app.inject({ method: "DELETE", url: `/api/bots/${botId}/bindings/mail2000`, headers: ownerAuthHeaders })
    expect(removed.statusCode).toBe(200)
    expect((removed.json() as { removedCount: number }).removedCount).toBe(2)

    const afterRemove = await app.inject({ method: "GET", url: `/api/bots/${botId}/bindings`, headers: ownerAuthHeaders })
    expect(afterRemove.statusCode).toBe(200)
    const bindingsAfterRemove = afterRemove.json() as Array<{ resourceId: string; capabilityId: string }>
    expect(bindingsAfterRemove.some((binding) => binding.resourceId === "mail2000")).toBe(false)
    expect(bindingsAfterRemove).toEqual([
      expect.objectContaining({ resourceId: "genio-one-discovery", capabilityId: "search_resources" }),
      expect.objectContaining({ resourceId: "servicenow-csm", capabilityId: "mcp.invoke" }),
    ])
    const rosterAfterRemove = await app.inject({ method: "GET", url: "/api/bots/roster", headers: ownerAuthHeaders })
    expect(rosterAfterRemove.statusCode).toBe(200)
    const readBackBot = (rosterAfterRemove.json() as Array<{ bot: { id: string; bindings: Array<{ resourceId: string }> } }>).find((entry) => entry.bot.id === botId)?.bot
    expect(readBackBot?.bindings.some((binding) => binding.resourceId === "mail2000")).toBe(false)

    const otherAdd = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/bindings/add`,
      headers: otherHeaders,
      payload: { resourceId: "mail2000", capabilityId: "mcp.invoke" },
    })
    expect(otherAdd.statusCode).toBe(404)
    expect((otherAdd.json() as { error: string }).error).toBe("BOT_NOT_FOUND")

    const otherRemove = await app.inject({ method: "DELETE", url: `/api/bots/${botId}/bindings/servicenow-csm`, headers: otherHeaders })
    expect(otherRemove.statusCode).toBe(404)
    expect((otherRemove.json() as { error: string }).error).toBe("BOT_NOT_FOUND")

    const foreignRead = await app.inject({ method: "GET", url: `/api/bots/${botId}/bindings`, headers: foreignHeaders })
    expect(foreignRead.statusCode).toBe(404)
    expect((foreignRead.json() as { error: string }).error).toBe("BOT_NOT_FOUND")
  })
})
