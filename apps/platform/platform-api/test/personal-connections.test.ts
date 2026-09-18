import { test, expect } from "bun:test"
import Fastify from "fastify"
import { personalConnectionHttp } from "../src/capabilities/mcp-oauth/personal-http"
import type { AccessGovernanceStore } from "../src/capabilities/access/module"
import type { ResourceConnectionRegistry } from "../src/capabilities/connections/module"
import type { McpOAuthService } from "../src/capabilities/mcp-oauth/module"

test("personal connection route uses authenticated user and Auto Grant without exposing provider configuration", async () => {
  const app = Fastify()
  app.addHook("onRequest", async (request) => {
    request.principal = { tenant_id: "tenant", subject_id: "person", client_id: "bot", role: "USER", organization_ids: [] }
  })
  const actors: string[] = []
  let access = "AUTO_GRANT"
  let disconnected = ""
  await app.register(personalConnectionHttp, {
    passwords: { async resolveRequestHeaders() { return [] }, async save() { return { status: "SAVED" } }, async status() { return { status: "NEEDS_CONNECTION" } }, async remove() {}, async resolve() { throw new Error("not used") } },
    access: { async catalog({ actor }: { actor: { subjectId: string } }) {
      actors.push(actor.subjectId)
      return { capabilities: [{ resource_id: "sn", access }] }
    } } as unknown as AccessGovernanceStore,
    connections: {
      async list() { return [{ connection_id: "connection", display_name: "ServiceNow", lifecycle: "ENABLED", connection_kind: "MCP", downstream_identity: { mode: "USER_OAUTH" }, endpoint: "private-endpoint", credential_ref: "private-secret" }] },
      async get() { return { lifecycle: "ENABLED" } },
    } as unknown as ResourceConnectionRegistry,
    oauth: {
      async status(input: { subjectId: string }) { actors.push(input.subjectId); return null },
      async start(input: { subjectId: string }) { actors.push(input.subjectId); return { authorization_url: "https://sn.test/authorize", expires_at: 1000 } },
      async disconnect(input: { subjectId: string }) { disconnected = input.subjectId },
    } as unknown as McpOAuthService,
  })
  const base = "/v1/tenants/tenant/me/resource-connections/sn"
  try {
    const response = await app.inject({ url: base })
    expect(response.statusCode).toBe(200)
    expect(response.json<unknown>()).toEqual([{ connection_id: "connection", display_name: "ServiceNow", authentication: "OAUTH", status: "NEEDS_CONNECTION" }])
    expect(response.body).not.toContain("private")
    expect((await app.inject({ method: "POST", url: `${base}/connection/authorize`, payload: { subject_id: "attacker" } })).statusCode).toBe(200)
    expect(actors.every((actor) => actor === "person")).toBe(true)
    access = "REQUEST"
    expect((await app.inject({ url: base })).statusCode).toBe(403)
    expect((await app.inject({ method: "POST", url: `${base}/connection/authorize` })).statusCode).toBe(403)
    expect((await app.inject({ method: "DELETE", url: `${base}/connection` })).statusCode).toBe(204)
    expect(disconnected).toBe("person")
    expect((await app.inject({ url: base.replace("/tenant/", "/another/") })).statusCode).toBe(401)
  } finally { await app.close() }
})
