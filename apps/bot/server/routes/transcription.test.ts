import { afterEach, expect, test } from "bun:test"
import Fastify from "fastify"
import { transcriptionRoutes } from "./transcription"

const originalFetch = globalThis.fetch
const oldGateway = process.env.GENIO_BOT_ASR_GATEWAY_BASE_URL
afterEach(() => {
  globalThis.fetch = originalFetch
  if (oldGateway === undefined) delete process.env.GENIO_BOT_ASR_GATEWAY_BASE_URL
  else process.env.GENIO_BOT_ASR_GATEWAY_BASE_URL = oldGateway
})

test("authenticated ASR uses the published default model, preserves audio and propagates gateway denial", async () => {
  process.env.GENIO_BOT_ASR_GATEWAY_BASE_URL = "http://asr.example.test/v1"
  let allowed = true
  let gatewayStatus = 200
  let calls = 0
  globalThis.fetch = (async (url: URL | string, options?: RequestInit) => {
    const path = new URL(url).pathname
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer user-token")
    if (path === "/v1/identity/session") return Response.json({ tenant_id: "tenant", subject_id: "user", acting_client_id: "bot", scopes: [] })
    if (path === "/v1/tenants/tenant/models") return Response.json([{ model_name: "breeze-asr", display_name: "Breeze ASR 25", lifecycle: "PUBLISHED", resource_id: "asr", capabilities: ["TRANSCRIPTION"] }])
    if (path === "/v1/tenants/tenant/catalog") return Response.json({ capabilities: [{ resource_id: "asr", capability_id: "model.invoke", access: allowed ? "AUTO_GRANT" : "REQUEST", connection_status: "READY" }] })
    expect(path).toBe("/v1/audio/transcriptions")
    calls++
    const form = options?.body as FormData
    expect(form.get("model")).toBe("breeze-asr")
    expect(new Uint8Array(await (form.get("file") as File).arrayBuffer())).toEqual(new Uint8Array([1, 2, 255]))
    expect(new Headers(options?.headers).get("x-request-id")).toBeTruthy()
    return Response.json(gatewayStatus === 200 ? { text: " 測試文字 " } : { error: "denied" }, { status: gatewayStatus })
  }) as typeof fetch
  const app = Fastify()
  await transcriptionRoutes(app)
  try {
    expect((await app.inject({ method: "GET", url: "/api/transcription" })).statusCode).toBe(401)
    const headers = { authorization: "Bearer user-token", "content-type": "audio/webm;codecs=opus" }
    const audio = Buffer.from([1, 2, 255])
    const success = await app.inject({ method: "POST", url: "/api/transcription", headers, payload: audio })
    expect(success.statusCode).toBe(200)
    expect(success.json().text).toBe("測試文字")
    gatewayStatus = 403
    expect((await app.inject({ method: "POST", url: "/api/transcription", headers, payload: audio })).statusCode).toBe(403)
    allowed = false
    expect((await app.inject({ method: "POST", url: "/api/transcription", headers, payload: audio })).statusCode).toBe(503)
    expect(calls).toBe(2)
    expect((await app.inject({ method: "POST", url: "/api/transcription", headers, payload: Buffer.alloc(3_500_001) })).statusCode).toBe(413)
  } finally { await app.close() }
})
