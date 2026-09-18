import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createArchifyHandler } from "./server"

const root = path.dirname(fileURLToPath(import.meta.url))
const token = "archify-test-service-token"

function request(method: string, params: unknown, authorized = true) {
  return new Request("http://archify.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorized ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
}

async function architectureSpec() {
  const source = JSON.parse(await readFile(path.join(root, "vendor/archify/examples/web-app.architecture.json"), "utf8")) as Record<string, any>
  delete source.meta.output
  return source
}

test("Archify requires a service bearer token and exposes only bounded MCP tools", async () => {
  const handler = createArchifyHandler({ bearerToken: token })
  expect((await handler(new Request("http://archify.test/health"))).status).toBe(200)
  expect((await handler(request("tools/list", {}, false))).status).toBe(401)
  const tools = await (await handler(request("tools/list", {}))).json() as { result: { tools: Array<{ name: string }> } }
  expect(tools.result.tools.map((tool) => tool.name).sort()).toEqual(["archify_render", "archify_schema"])
  const guide = await (await handler(request("tools/call", { name: "archify_schema", arguments: { type: "workflow" } }))).json() as any
  expect(guide.result.content[0].text).toMatch(/^ARCHIFY_SCHEMA sha256=[a-f0-9]{64}$/)
  expect(guide.result.structuredContent.schema).toBeDefined()
  expect(guide.result.structuredContent.example.diagram_type).toBe("workflow")
})

test("Archify invokes validate and deliver then returns the HTML only as an artifact", async () => {
  const handler = createArchifyHandler({ bearerToken: token })
  const spec = await architectureSpec()
  spec.meta.title = "Connector rendering path"
  const response = await handler(request("tools/call", { name: "archify_render", arguments: { type: "architecture", spec } }))
  expect(response.status).toBe(200)
  const body = await response.json() as any
  expect(body.result.isError).not.toBe(true)
  expect(body.result.content[0].text).toMatch(/^ARCHIFY_RENDERED type=architecture sha256=[a-f0-9]{64} bytes=[0-9]+$/)
  expect(body.result.content[0].text).not.toContain("<html")
  expect(body.result.structuredContent.artifact.bytes).toBeGreaterThan(1_000)
  expect(body.result._meta["genio/artifacts"]).toHaveLength(1)
  expect(body.result._meta["genio/artifacts"][0].mimeType).toBe("text/html")
  expect(body.result._meta["genio/artifacts"][0].text).toMatch(/^<!DOCTYPE html>/i)
})

test("Archify rejects path-like output and shell-shaped text without executing either", async () => {
  const handler = createArchifyHandler({ bearerToken: token })
  const rejected = await architectureSpec()
  rejected.meta.output = "../../outside.html"
  const rejectedBody = await (await handler(request("tools/call", { name: "archify_render", arguments: { type: "architecture", spec: rejected } }))).json() as any
  expect(rejectedBody.result.isError).toBe(true)
  expect(rejectedBody.result.content[0].text).toBe("ARCHIFY_SPEC_REJECTED")
  const harmless = await architectureSpec()
  harmless.meta.title = "$(touch /tmp/genio-archify-injection-marker)"
  const response = await handler(request("tools/call", { name: "archify_render", arguments: { type: "architecture", spec: harmless } }))
  const body = await response.json() as any
  expect(body.result.isError).not.toBe(true)
  expect(await Bun.file("/tmp/genio-archify-injection-marker").exists()).toBe(false)
})

test("Archify returns a bounded validation failure without revealing the specification", async () => {
  const handler = createArchifyHandler({ bearerToken: token })
  const response = await handler(request("tools/call", { name: "archify_render", arguments: { type: "architecture", spec: { diagram_type: "architecture", secret: "not-a-valid-spec" } } }))
  const body = await response.json() as any
  expect(body.result.isError).toBe(true)
  expect(body.result.content[0].text).toMatch(/^ARCHIFY_/)
  expect(JSON.stringify(body.result)).not.toContain("not-a-valid-spec")
})
