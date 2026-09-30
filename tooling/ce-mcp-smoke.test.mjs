import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import test from "node:test"
import { browserToken, parseOptions, parseRpc, smoke } from "./ce-mcp-smoke.mjs"

test("credential destinations require TLS or loopback and token values are never CLI arguments", () => {
  assert.throws(() => parseOptions(["--url", "http://remote.example/mcp", "--tool", "x", "--token-env", "TOKEN"]), /HTTPS/)
  assert.throws(() => parseOptions(["--url", "https://user:secret@remote.example/mcp", "--tool", "x", "--token-env", "TOKEN"]), /credentials/)
  assert.throws(() => parseOptions(["--url", "http://localhost:1975/mcp", "--tool", "x", "--token", "value"]), /Unknown/)
  assert.deepEqual(parseOptions(["--url", "http://localhost:1975/mcp", "--tool", "x", "--token-env", "TOKEN", "--argument", "repoName=facebook/react"]).arguments, { repoName: "facebook/react" })
})

test("MCP SSE parsing skips progress events and finds execution errors", () => {
  assert.deepEqual(parseRpc('event: message\ndata: {"method":"notifications/progress"}\n\nevent: message\ndata: {"id":3,"result":{"isError":true}}\n\n'), { id: 3, result: { isError: true } })
  assert.equal(parseRpc("not json"), null)
})

test("MCP receipts use the Gateway response ID for audit correlation", async () => {
  const gatewayReceipts = new Map()
  const gateway = createServer(async (request, reply) => {
    reply.setHeader("content-type", "application/json")
    if (!request.headers.authorization) { reply.writeHead(401).end("{}"); return }
    let body = ""
    for await (const chunk of request) body += chunk
    const rpc = JSON.parse(body)
    const original = request.headers["x-request-id"]
    const mutated = `${original.slice(0, 14)}9${original.slice(15)}`
    reply.setHeader("x-request-id", mutated)
    const responseCorrelationId = rpc.method === "tools/call" ? `${mutated.slice(0, 14)}a${mutated.slice(15)}` : null
    if (responseCorrelationId) reply.setHeader("x-genio-correlation-id", responseCorrelationId)
    gatewayReceipts.set(rpc.method, { clientRequestId: original, responseCorrelationId, requestId: mutated })
    const result = rpc.method === "tools/list" ? { tools: [{ name: "mail2000__list_mailboxes" }] }
      : rpc.method === "tools/call" ? { content: [{ type: "text", text: "test result" }] } : {}
    reply.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }))
  })
  await new Promise((done) => gateway.listen(0, "127.0.0.1", done))
  const previous = process.env.GENIO_MCP_CORRELATION_TEST_TOKEN
  process.env.GENIO_MCP_CORRELATION_TEST_TOKEN = "test-only-token"
  try {
    const result = await smoke({ url: `http://127.0.0.1:${gateway.address().port}/mcp`, tokenEnv: "GENIO_MCP_CORRELATION_TEST_TOKEN", tool: "mail2000__list_mailboxes", arguments: {} })
    const list = result.requests.find((receipt) => receipt.method === "tools/list")
    const call = result.requests.find((receipt) => receipt.method === "tools/call")
    assert.equal(result.status, "PASS")
    assert.equal(list.sent_correlation_id, gatewayReceipts.get("tools/list").clientRequestId)
    assert.equal(list.response_request_id, gatewayReceipts.get("tools/list").requestId)
    assert.equal(list.correlation_id, gatewayReceipts.get("tools/list").requestId)
    assert.notEqual(list.sent_correlation_id, list.correlation_id)
    assert.equal(call.sent_correlation_id, gatewayReceipts.get("tools/call").clientRequestId)
    assert.equal(call.response_request_id, gatewayReceipts.get("tools/call").requestId)
    assert.equal(call.response_correlation_id, gatewayReceipts.get("tools/call").responseCorrelationId)
    assert.equal(call.correlation_id, gatewayReceipts.get("tools/call").requestId)
  } finally {
    if (previous === undefined) delete process.env.GENIO_MCP_CORRELATION_TEST_TOKEN
    else process.env.GENIO_MCP_CORRELATION_TEST_TOKEN = previous
    gateway.closeAllConnections()
    await new Promise((done) => gateway.close(done))
  }
})

test("browser sign-in verifies state and binds the code exchange to its PKCE verifier", async () => {
  let origin, challenge, redirectUri
  const issuer = createServer(async (request, reply) => {
    reply.setHeader("content-type", "application/json")
    if (request.url === "/realm/.well-known/openid-configuration") { reply.end(JSON.stringify({ issuer: `${origin}/realm`, authorization_endpoint: `${origin}/auth`, token_endpoint: `${origin}/token` })); return }
    if (request.url === "/token") {
      let body = ""; for await (const chunk of request) body += chunk
      const fields = new URLSearchParams(body)
      assert.equal(fields.get("code"), "test-code")
      assert.equal(fields.get("redirect_uri"), redirectUri)
      assert.equal(createHash("sha256").update(fields.get("code_verifier")).digest("base64url"), challenge)
      assert.equal(fields.has("client_secret"), false)
      reply.end(JSON.stringify({ access_token: "test-only-token" })); return
    }
    reply.writeHead(404).end()
  })
  await new Promise((yes) => issuer.listen(0, "127.0.0.1", yes))
  origin = `http://127.0.0.1:${issuer.address().port}`
  try {
    const token = await browserToken(`${origin}/realm`, "codex-mcp", { timeoutMs: 5000, announce: async (link) => {
      const authorization = new URL(link)
      challenge = authorization.searchParams.get("code_challenge"); redirectUri = authorization.searchParams.get("redirect_uri")
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256")
      const wrong = await fetch(`${redirectUri}?state=wrong&code=bad`); assert.equal(wrong.status, 400)
      const valid = new URL(redirectUri); valid.searchParams.set("state", authorization.searchParams.get("state")); valid.searchParams.set("code", "test-code")
      const response = await fetch(valid); assert.equal(response.status, 200)
    } })
    assert.equal(token, "test-only-token")
  } finally { issuer.closeAllConnections(); await new Promise((yes) => issuer.close(yes)) }
})
