import { describe, expect, test } from "bun:test"
import { createServiceNowHandler } from "./server"
import { serviceNowOrigin } from "./client"

function mcpRequest(method: string, params: unknown, token?: string) {
  return new Request("http://connector.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
}

describe("ServiceNow MCP transport", () => {
  test("rejects missing credentials before upstream access", async () => {
    let called = false
    const handler = createServiceNowHandler({ instanceUrl: "https://tenant.service-now.com", request: (async () => {
      called = true
      return Response.json({ result: [] })
    }) })
    const body = await (await handler(mcpRequest("tools/call", { name: "list_cases", arguments: {} }))).json() as any
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toBe("SERVICENOW_AUTHORIZATION_REQUIRED")
    expect(called).toBe(false)
  })

  test("MCP discovery exposes a bounded read tool without querying ServiceNow", async () => {
    const handler = createServiceNowHandler({ instanceUrl: "https://tenant.service-now.com", request: (async () => {
      throw new Error("discovery must not call upstream")
    }) })
    const response = await handler(mcpRequest("tools/list", {}))
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.result.tools[0].name).toBe("list_cases")
    expect(body.result.tools[0].annotations.readOnlyHint).toBe(true)
  })

  test("concurrent MCP calls keep credentials scoped to each request", async () => {
    const calls: Array<{ token: string | null; url: URL; redirect: RequestRedirect | undefined }> = []
    const handler = createServiceNowHandler({ instanceUrl: "https://tenant.service-now.com", request: (async (url, init) => {
      calls.push({ token: new Headers(init?.headers).get("authorization"), url: new URL(String(url)), redirect: init?.redirect })
      return Response.json({ result: [{ sys_id: { value: "abc", display_value: "ignored" }, number: "CS001", short_description: "Case" }] })
    }) })
    const responses = await Promise.all(["user-a", "user-b"].map((token) => handler(mcpRequest("tools/call", { name: "list_cases", arguments: { case_number: "CS001", limit: 1 } }, token))))
    for (const response of responses) {
      const body = await response.json() as any
      expect(body.result.isError).not.toBe(true)
      expect(body.result.structuredContent.cases[0].sys_id).toBe("abc")
    }
    expect(calls.map((call) => call.token).sort()).toEqual(["Bearer user-a", "Bearer user-b"])
    expect(calls[0].url.pathname).toBe("/api/now/table/sn_customerservice_case")
    expect(calls[0].url.searchParams.get("sysparm_limit")).toBe("1")
    expect(calls[0].redirect).toBe("error")
  })

  test("encoded query injection and excessive pages are rejected by MCP schema", async () => {
    let calls = 0
    const handler = createServiceNowHandler({ instanceUrl: "https://tenant.service-now.com", request: (async () => {
      calls++
      return Response.json({ result: [] })
    }) })
    for (const args of [{ case_number: "CS001^ORactive=true" }, { limit: 101 }, { offset: -1 }]) {
      const body = await (await handler(mcpRequest("tools/call", { name: "list_cases", arguments: args }, "user-a"))).json() as any
      expect(body.error !== undefined || body.result?.isError === true).toBe(true)
    }
    expect(calls).toBe(0)
  })

  test("expired authorization produces a safe error without reflecting upstream content", async () => {
    const handler = createServiceNowHandler({ instanceUrl: "https://tenant.service-now.com", request: (async () => new Response("private upstream diagnostic", { status: 401 })) })
    const body = await (await handler(mcpRequest("tools/call", { name: "list_cases", arguments: {} }, "expired"))).json() as any
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toBe("SERVICENOW_REAUTHORIZATION_REQUIRED")
    expect(JSON.stringify(body)).not.toContain("private upstream diagnostic")
  })

  test("deployment requires an HTTPS origin without embedded credentials or paths", () => {
    for (const url of ["http://tenant.test", "https://user:pass@tenant.test", "https://tenant.test/path", "https://tenant.test?token=x"]) {
      expect(() => serviceNowOrigin(url)).toThrow()
    }
  })
})
