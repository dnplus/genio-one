import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { requestAccessToken, verifyGenioOneAccessToken } from "../auth"

const MAX_AUDIO_BYTES = 3_500_000
const formats = new Map([["audio/webm", "webm"], ["audio/mp4", "mp4"], ["audio/wav", "wav"], ["audio/mpeg", "mp3"], ["audio/ogg", "ogg"]])

async function availableModel(token: string) {
  const principal = await verifyGenioOneAccessToken(token)
  const gateway = process.env.GENIO_BOT_ASR_GATEWAY_BASE_URL?.trim()
  const modelName = process.env.GENIO_BOT_ASR_MODEL?.trim() || "breeze-asr"
  if (!gateway) return null
  const endpoint = new URL(`${gateway.replace(/\/$/, "")}/audio/transcriptions`)
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("ASR_CONFIGURATION_INVALID")
  const origin = process.env.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
  const base = `/v1/tenants/${encodeURIComponent(principal.tenant_id)}`
  const responses = await Promise.all([`${base}/models`, `${base}/catalog`].map((path) => fetch(new URL(path, origin), {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(5000), redirect: "error",
  })))
  if (responses.some((response) => !response.ok)) throw new Error("ASR_CATALOG_UNAVAILABLE")
  const models = await responses[0]!.json() as Array<{ model_name: string; display_name: string; resource_id: string; lifecycle: string; capabilities: string[] }>
  const catalog = await responses[1]!.json() as { capabilities: Array<{ resource_id: string; capability_id: string; access: string; connection_status: string }> }
  const model = models.find((item) => item.model_name === modelName && item.lifecycle === "PUBLISHED" && item.capabilities.includes("TRANSCRIPTION"))
  if (!model || !catalog.capabilities.some((item) => item.resource_id === model.resource_id && item.capability_id === "model.invoke" && ["ENTITLED", "AUTO_GRANT"].includes(item.access) && item.connection_status === "READY")) return null
  return { endpoint, name: model.model_name, displayName: model.display_name }
}

export async function transcriptionRoutes(app: FastifyInstance) {
  await app.register(async (routes) => {
    routes.addContentTypeParser(/^audio\//, { parseAs: "buffer", bodyLimit: MAX_AUDIO_BYTES }, (_request, body, done) => done(null, body))
    routes.get("/api/transcription", async (request, reply) => {
      reply.header("cache-control", "no-store")
      let token: string
      try { token = requestAccessToken(request) } catch { return reply.code(401).send({ error: "ASR_AUTH_REQUIRED" }) }
      try {
        const model = await availableModel(token)
        return { available: Boolean(model), model: model?.name ?? null, displayName: model?.displayName ?? null }
      } catch (error) {
        const message = error instanceof Error ? error.message : "ASR_UNAVAILABLE"
        return reply.code(message.startsWith("GENIO_ONE_SESSION") ? 401 : 503).send({ error: message.startsWith("GENIO_ONE_SESSION") ? "ASR_AUTH_REQUIRED" : "ASR_UNAVAILABLE" })
      }
    })
    routes.post("/api/transcription", { bodyLimit: MAX_AUDIO_BYTES }, async (request, reply) => {
      reply.header("cache-control", "no-store")
      let token: string
      try { token = requestAccessToken(request) } catch { return reply.code(401).send({ error: "ASR_AUTH_REQUIRED" }) }
      const mime = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? ""
      const extension = formats.get(mime)
      if (!extension || !Buffer.isBuffer(request.body) || !request.body.length) return reply.code(400).send({ error: "ASR_INVALID_AUDIO" })
      const correlationId = randomUUID()
      const started = Date.now()
      const controller = new AbortController()
      const disconnected = () => { if (!reply.raw.writableEnded) controller.abort() }
      reply.raw.on("close", disconnected)
      try {
        const model = await availableModel(token)
        if (!model) return reply.code(503).send({ error: "ASR_NOT_CONFIGURED" })
        const form = new FormData()
        form.set("model", model.name)
        form.set("response_format", "json")
        form.set("file", new Blob([new Uint8Array(request.body)], { type: mime }), `recording.${extension}`)
        const target = new URL(model.endpoint)
        const gatewayHost = target.hostname.endsWith(".localhost") ? target.host : null
        if (gatewayHost) target.hostname = "127.0.0.1"
        const response = await fetch(target, {
          method: "POST", body: form, redirect: "error",
          headers: { authorization: `Bearer ${token}`, "x-request-id": correlationId, "x-genio-session-id": correlationId, ...(gatewayHost ? { host: gatewayHost } : {}) },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        })
        reply.header("x-request-id", correlationId).header("cache-control", "no-store")
        if (!response.ok) {
          await response.body?.cancel()
          request.log.warn({ event: "bot.asr.failed", correlationId, model: model.name, upstreamStatus: response.status, elapsedMs: Date.now() - started })
          return reply.code(response.status === 429 ? 429 : response.status === 403 ? 403 : 502).send({ error: response.status === 429 ? "ASR_BUSY" : response.status === 403 ? "ASR_ACCESS_DENIED" : "ASR_UPSTREAM_FAILED" })
        }
        const result = await response.json() as { text?: unknown }
        if (typeof result.text !== "string" || result.text.length > 32_000) throw new Error("ASR_INVALID_RESPONSE")
        request.log.info({ event: "bot.asr.completed", correlationId, model: model.name, audioBytes: request.body.length, elapsedMs: Date.now() - started })
        return { text: result.text.trim(), model: model.name, correlationId }
      } catch (error) {
        const message = error instanceof Error ? error.message : ""
        request.log.warn({ event: "bot.asr.failed", correlationId, elapsedMs: Date.now() - started })
        return reply.code(message.startsWith("GENIO_ONE_SESSION") ? 401 : 502).send({ error: message.startsWith("GENIO_ONE_SESSION") ? "ASR_AUTH_REQUIRED" : "ASR_UPSTREAM_FAILED" })
      } finally {
        reply.raw.off("close", disconnected)
      }
    })
  })
}
