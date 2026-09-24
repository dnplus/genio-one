import { afterEach, expect, test } from "bun:test"

import { createBotApp } from "../app"
import { BotRegistry } from "../bot-registry"

const principal = {
  tenant_id: "tenant-workspace-duplicate",
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

test("duplicate revalidates a workspace binding before agent registration and copy", async () => {
  registry = new BotRegistry(":memory:")
  const source = registry.create(principal, {
    name: "Workspace bot",
    description: "工作",
    teamWorkspaceId: "workspace-se",
  })
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
      return Response.json({ subject_id: `agent-copy-${agentRequests}`, kind: "AGENT" }, { status: 201 })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch
  app = await createBotApp({ botRegistry: registry })
  const headers = { authorization: "Bearer test-token" }
  const duplicate = (botId: string) => app!.inject({
    method: "POST",
    url: `/api/bots/${botId}/duplicate`,
    headers,
  })

  workspaceResponse = async () => Response.json({ code: "TEAM_WORKSPACE_CONTRIBUTOR_REQUIRED" }, { status: 403 })
  const revoked = await duplicate(source.id)
  expect(revoked.statusCode).toBe(403)
  expect(revoked.json().error).toBe("TEAM_WORKSPACE_CONTRIBUTOR_REQUIRED")
  expect(registry.list(principal)).toHaveLength(1)
  expect(agentRequests).toBe(0)

  workspaceResponse = async () => new Response("unavailable", { status: 503 })
  const unavailable = await duplicate(source.id)
  expect(unavailable.statusCode).toBe(503)
  expect(unavailable.json().error).toBe("TEAM_WORKSPACE_UNAVAILABLE")
  expect(registry.list(principal)).toHaveLength(1)
  expect(agentRequests).toBe(0)

  workspaceResponse = async () => Response.json({ workspace_id: "workspace-se" })
  const copied = await duplicate(source.id)
  expect(copied.statusCode).toBe(201)
  expect(copied.json().teamWorkspaceId).toBe("workspace-se")
  expect(registry.list(principal)).toHaveLength(2)
  expect(agentRequests).toBe(1)
  expect(workspaceUrls.every((url) => new URL(url).searchParams.get("access") === "contributor")).toBe(true)

  const unbound = registry.create(principal, { name: "Unbound bot", description: "工作" })
  const checksBeforeUnboundCopy = workspaceRequests
  const unboundCopy = await duplicate(unbound.id)
  expect(unboundCopy.statusCode).toBe(201)
  expect(unboundCopy.json().teamWorkspaceId).toBeNull()
  expect(workspaceRequests).toBe(checksBeforeUnboundCopy)
  expect(agentRequests).toBe(2)
})
