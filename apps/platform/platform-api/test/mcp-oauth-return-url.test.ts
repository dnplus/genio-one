import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"

import { mcpOAuthHttp } from "../src/capabilities/mcp-oauth/http"
import { mcpOAuthReturnUrl } from "../src/capabilities/mcp-oauth/module"

test("MCP OAuth returns to the owning Resource connections", () => {
  assert.equal(
    mcpOAuthReturnUrl(new URL("http://127.0.0.1:5173"), "resource-notion"),
    "http://127.0.0.1:5173/management?view=connections&resource=resource-notion",
  )
})

test("mcpOAuthHttp disconnect forwards the Resource from the Connection path", async () => {
  const disconnected: Array<{ tenantId: string; resourceId: string; connectionId: string; subjectId: string }> = []
  const app = Fastify()
  app.addHook("preHandler", async (request) => {
    request.principal = { tenant_id: "tenant", subject_id: "alice" } as typeof request.principal
  })
  await app.register(mcpOAuthHttp, {
    service: { async disconnect(input: typeof disconnected[number]) { disconnected.push(input) } } as any,
    passwords: {} as any,
    registrations: {} as any,
    authorizeRuntime: async () => {},
  })

  try {
    for (const resourceId of ["resource-one", "resource-two"]) {
      const response = await app.inject({
        method: "DELETE",
        url: `/v1/tenants/tenant/resources/${resourceId}/connections/shared/mcp-oauth`,
      })
      assert.equal(response.statusCode, 204, response.body)
    }
    assert.deepEqual(disconnected, [
      { tenantId: "tenant", resourceId: "resource-one", connectionId: "shared", subjectId: "alice" },
      { tenantId: "tenant", resourceId: "resource-two", connectionId: "shared", subjectId: "alice" },
    ])
  } finally {
    await app.close()
  }
})

test("mcpOAuthHttp callback rejects invalid target URLs", async () => {
  let target = ""
  const app = Fastify()
  await app.register(mcpOAuthHttp, {
    service: { complete: async () => target } as any,
    passwords: {} as any,
    registrations: {} as any,
    authorizeRuntime: async () => {},
  })

  try {
    for (const invalidTarget of [
      "javascript:alert(1)",
      "data:text/html,xss",
      "ftp://attacker.example/callback",
      "//attacker.example/callback",
      "///attacker.example/callback",
      "/management?view=connections",
      "https:attacker.example",
      "https:/attacker.example",
      "https:///attacker.example",
      "\\\\attacker.example/callback",
      "/\\attacker.example/callback",
      "https:\\\\attacker.example/callback",
      "https://ui.example.com\\@attacker.example/callback",
      "http://example.com\r\nHeader: injected",
      "https://ui.example.com/\u0000",
      "https://ui.example.com/\tcallback",
      "https://ui.example.com/\u007F",
      "https://ui.example.com/\u0085",
      " https://ui.example.com/callback",
      "https://ui.example.com/callback ",
      "https://",
    ]) {
      target = invalidTarget
      const response = await app.inject({
        method: "GET",
        url: "/v1/mcp-oauth/callback?state=teststate",
      })

      assert.equal(response.statusCode, 400, invalidTarget)
      assert.equal(JSON.parse(response.body).code, "MCP_OAUTH_CALLBACK_INVALID", invalidTarget)
      assert.equal(response.headers.location, undefined, invalidTarget)
    }
  } finally {
    await app.close()
  }
})

test("mcpOAuthHttp callback preserves HTTP and HTTPS return URLs and OAuth outcomes", async () => {
  let target = ""
  const app = Fastify()
  await app.register(mcpOAuthHttp, {
    service: { complete: async () => target } as any,
    passwords: {} as any,
    registrations: {} as any,
    authorizeRuntime: async () => {},
  })

  try {
    for (const origin of ["http://127.0.0.1:5173", "https://ui.example.com"]) {
      for (const outcome of ["connected", "failed"]) {
        const returnUrl = new URL(mcpOAuthReturnUrl(new URL(origin), "resource-notion"))
        returnUrl.searchParams.set("mcp_oauth", outcome)
        target = returnUrl.toString()
        const response = await app.inject({
          method: "GET",
          url: "/v1/mcp-oauth/callback?state=teststate",
        })

        assert.equal(response.statusCode, 303, target)
        assert.equal(response.headers.location, target)
      }
    }
  } finally {
    await app.close()
  }
})
