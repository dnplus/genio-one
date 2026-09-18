import { test, expect } from "bun:test"
import { createServiceNowHandler } from "./server"

const id = "0123456789abcdef0123456789abcdef"
test("CSM CRUD uses scoped Table API methods and handles deletion without JSON", async () => {
  const calls: string[] = []
  const handle = createServiceNowHandler({ instanceUrl: "https://sn.test", request: async (url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer user-token")
    expect(new URL(String(url)).pathname).toStartWith("/api/now/table/sn_customerservice_case")
    calls.push(init?.method ?? "GET")
    return init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ result: { sys_id: id, number: "CS001" } })
  } })
  for (const [name, args] of [
    ["get_case", { sys_id: id }],
    ["create_case", { fields: { short_description: "Test" } }],
    ["update_case", { sys_id: id, fields: { priority: 2 } }],
    ["delete_case", { sys_id: id }],
  ] as const) {
    const response = await handle(new Request("http://connector.test/mcp", { method: "POST", headers: { authorization: "Bearer user-token", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }))
    const body = await response.json() as any
    expect(body.result.isError).not.toBe(true)
  }
  expect(calls).toEqual(["GET", "POST", "PATCH", "DELETE"])
})
