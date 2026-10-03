import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { createConnection } from "node:net"
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

test("Archify accepts a POST at the request size boundary and rejects a larger declared body", async () => {
  const handler = createArchifyHandler({ bearerToken: token })
  const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  const boundaryBody = message.padEnd(192 * 1024, " ")
  const accepted = await handler(new Request("http://archify.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "content-length": String(boundaryBody.length) },
    body: boundaryBody,
  }))
  expect(accepted.status).toBe(200)
  expect((await accepted.json() as any).result.tools).toBeDefined()

  const rejected = await handler(new Request("http://archify.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "content-length": String(boundaryBody.length + 1) },
    body: boundaryBody,
  }))
  expect(rejected.status).toBe(413)
  expect(await rejected.json()).toEqual({ error: "ARCHIFY_REQUEST_TOO_LARGE" })
})

test("Archify rejects an unlengthened stream before reading the remaining body", async () => {
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      if (pulls === 1) controller.enqueue(new Uint8Array(192 * 1024))
      else if (pulls === 2) controller.enqueue(new Uint8Array([32]))
      else throw new Error("read past request limit")
    },
  }, { highWaterMark: 0 })
  const response = await createArchifyHandler({ bearerToken: token })(new Request("http://archify.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body,
  }))
  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({ error: "ARCHIFY_REQUEST_TOO_LARGE" })
  expect(pulls).toBe(2)
})

test("Archify rejects an oversized raw chunked HTTP request without Content-Length", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createArchifyHandler({ bearerToken: token }) })
  try {
    const body = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}${" ".repeat(192 * 1024)}`
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: server.port! })
      const chunks: Buffer[] = []
      socket.setTimeout(5_000, () => socket.destroy(new Error("chunked response timeout")))
      socket.on("connect", () => {
        socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`)
        for (let offset = 0; offset < body.length; offset += 16 * 1024) {
          const chunk = body.slice(offset, offset + 16 * 1024)
          socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`)
        }
        socket.end("0\r\n\r\n")
      })
      socket.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      socket.on("error", reject)
    })
    expect(response).toMatch(/^HTTP\/1\.1 413 /)
    expect(response).toContain("ARCHIFY_REQUEST_TOO_LARGE")
  } finally {
    server.stop(true)
  }
})
