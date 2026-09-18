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

describe("UX P1-b group HTTP", () => {
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

  test("persists group folders without exposing scripted turns", async () => {
    cleanupDir = mkdtempSync(join(tmpdir(), "bot-group-http-"))
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

    const ids: string[] = []
    for (const name of ["阿庫婭", "達克妮絲", "惠惠"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/bots",
        headers,
        payload: { name, title: name, description: "P1-b" },
      })
      expect(res.statusCode).toBe(201)
      ids.push(res.json().id)
    }

    const folder = await app.inject({
      method: "POST",
      url: "/api/bot-groups",
      headers,
      payload: { name: "solo", memberBotIds: [ids[0]] },
    })
    expect(folder.statusCode).toBe(201)
    expect(folder.json().memberBotIds).toEqual([ids[0]])

    const created = await app.inject({
      method: "POST",
      url: "/api/bot-groups",
      headers,
      payload: { name: "美好世界團隊", memberBotIds: ids },
    })
    expect(created.statusCode).toBe(201)
    const group = created.json()
    expect(group.memberBotIds).toHaveLength(3)

    const listed = await app.inject({ method: "GET", url: "/api/bot-groups", headers })
    expect(listed.json().some((value: { groupId: string }) => value.groupId === group.groupId)).toBe(true)
    const removed = await app.inject({ method: "POST", url: `/api/bot-groups/${group.groupId}/turns`, headers, payload: { scriptedReplies: { [ids[0]!]: "fake" } } })
    expect(removed.statusCode).toBe(404)
  })
})
