import { afterEach, expect, test } from "bun:test"

import { createBotApp } from "../app"
import { BotRegistry } from "../bot-registry"

const principal = {
  tenant_id: "tenant-workspace-create",
  subject_id: "person-owner",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

let app: Awaited<ReturnType<typeof createBotApp>> | null = null
let registry: BotRegistry | null = null
const originalFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (app) await app.close()
  registry?.close()
  app = null
  registry = null
})

test("create validates and persists an optional workspace binding before agent registration", async () => {
  registry = new BotRegistry(":memory:")
  let workspaceRequests = 0
  const workspaceUrls: string[] = []
  let agentRequests = 0
  let workspaceResponse: () => Promise<Response> = async () => Response.json({ workspace_id: "workspace-se" })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("/v1/identity/session")) return Response.json(principal)
    if (url.includes("/team-workspaces/")) {
      workspaceRequests += 1
      workspaceUrls.push(url)
      return workspaceResponse()
    }
    if (url.endsWith("/me/agents")) {
      agentRequests += 1
      return Response.json({ subject_id: `agent-create-${agentRequests}`, kind: "AGENT" }, { status: 201 })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch
  app = await createBotApp({ botRegistry: registry })
  const headers = { authorization: "Bearer test-token", "content-type": "application/json" }
  const create = (payload: Record<string, unknown>) => app!.inject({
    method: "POST",
    url: "/api/bots",
    headers,
    payload: { name: "Workspace bot", ...payload },
  })

  const invalid = await create({ teamWorkspaceId: " " })
  expect(invalid.statusCode).toBe(400)
  expect(invalid.json().error).toBe("TEAM_WORKSPACE_INVALID")
  expect(agentRequests).toBe(0)
  expect(registry.list(principal)).toHaveLength(0)

  workspaceResponse = async () => Response.json({ code: "TEAM_WORKSPACE_CONTRIBUTOR_REQUIRED" }, { status: 403 })
  const denied = await create({ teamWorkspaceId: "workspace-se" })
  expect(denied.statusCode).toBe(403)
  expect(denied.json().error).toBe("TEAM_WORKSPACE_CONTRIBUTOR_REQUIRED")
  expect(agentRequests).toBe(0)
  expect(registry.list(principal)).toHaveLength(0)

  workspaceResponse = async () => new Response("unavailable", { status: 503 })
  const unavailable = await create({ teamWorkspaceId: "workspace-se" })
  expect(unavailable.statusCode).toBe(503)
  expect(unavailable.json().error).toBe("TEAM_WORKSPACE_UNAVAILABLE")
  expect(agentRequests).toBe(0)
  expect(registry.list(principal)).toHaveLength(0)

  workspaceResponse = async () => Response.json({ workspace_id: "workspace-se" })
  const bound = await create({ teamWorkspaceId: "workspace-se" })
  expect(bound.statusCode).toBe(201)
  expect(bound.json().teamWorkspaceId).toBe("workspace-se")
  expect(agentRequests).toBe(1)
  expect(registry.list(principal)).toHaveLength(1)
  expect(workspaceUrls).toHaveLength(3)
  expect(workspaceUrls.every((url) => new URL(url).searchParams.get("access") === "contributor")).toBe(true)

  const checksBeforeUnboundCreate = workspaceRequests
  const unbound = await create({})
  expect(unbound.statusCode).toBe(201)
  expect(unbound.json().teamWorkspaceId).toBeNull()
  expect(workspaceRequests).toBe(checksBeforeUnboundCreate)
  expect(agentRequests).toBe(2)
  expect(registry.list(principal)).toHaveLength(2)
})

test("patch uses contributor-only workspace validation", async () => {
  registry = new BotRegistry(":memory:")
  const bot = registry.create(principal, { name: "Workspace bot", description: "工作" })
  let workspaceUrl: string | null = null
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("/v1/identity/session")) return Response.json(principal)
    if (url.includes("/team-workspaces/")) {
      workspaceUrl = url
      if (new URL(url).searchParams.get("access") === "contributor") {
        return Response.json({ code: "TEAM_WORKSPACE_CONTRIBUTOR_REQUIRED" }, { status: 403 })
      }
      return Response.json({ workspace_id: "workspace-se" })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch
  app = await createBotApp({ botRegistry: registry })

  const response = await app.inject({
    method: "PATCH",
    url: `/api/bots/${bot.id}`,
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    payload: { teamWorkspaceId: "workspace-se" },
  })

  expect(response.statusCode).toBe(403)
  expect(response.json().error).toBe("TEAM_WORKSPACE_CONTRIBUTOR_REQUIRED")
  expect(workspaceUrl).not.toBeNull()
  expect(new URL(workspaceUrl!).searchParams.get("access")).toBe("contributor")
  expect(registry.getOwned(bot.id, principal)?.teamWorkspaceId).toBeNull()
})
