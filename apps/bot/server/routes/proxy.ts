import { Readable } from "node:stream"
import WebSocket from "ws"
import type { FastifyInstance } from "fastify"

import { authenticateProxySession } from "../auth"
import type { BotServerContext } from "../context"

export async function proxyRoutes(app: FastifyInstance, context: BotServerContext) {
  app.get("/api/desktop/:runtimeSessionId/*", async (request, reply) => {
    const { runtimeSessionId, "*": path } = request.params as { runtimeSessionId: string; "*": string }
    if (path && (path.startsWith("//") || path.includes("://") || path.includes("\\"))) {
      return reply.code(400).send({ error: "INVALID_PATH" })
    }
    const session = await authenticateProxySession(context.runtimeBroker, runtimeSessionId, "desktop", request)
    if (!session) return reply.code(404).send({ error: "DESKTOP_SESSION_NOT_FOUND" })
    const target = new URL(path || "vnc.html", session.sandboxUrl)
    const response = await fetch(target, {
      headers: {
        "E2b-Sandbox-Id": session.sandboxId,
        "E2b-Sandbox-Port": "6080",
      },
    })
    const contentType = response.headers.get("content-type")
    const cacheControl = response.headers.get("cache-control")
    if (contentType) reply.header("content-type", contentType)
    if (cacheControl) reply.header("cache-control", cacheControl)
    return reply.code(response.status).send(Buffer.from(await response.arrayBuffer()))
  })

  app.get("/api/desktop/:runtimeSessionId/websockify", { websocket: true }, async (socket, request) => {
    const { runtimeSessionId } = request.params as { runtimeSessionId: string }
    const session = await authenticateProxySession(context.runtimeBroker, runtimeSessionId, "desktop", request)
    if (!session) {
      socket.close(1008, "DESKTOP_SESSION_NOT_FOUND")
      return
    }
    bridgeE2bWebSocket(socket, session, "6080")
  })

  app.get("/api/executor/:runtimeSessionId", { websocket: true }, async (socket, request) => {
    const { runtimeSessionId } = request.params as { runtimeSessionId: string }
    const query = request.query as { tier?: string }
    const tier = query.tier === "desktop" || query.tier === "headless" ? query.tier : undefined
    const session = await authenticateProxySession(context.runtimeBroker, runtimeSessionId, tier, request)
    if (!session) {
      socket.close(1008, "EXECUTOR_SESSION_NOT_FOUND")
      return
    }
    bridgeE2bWebSocket(socket, session, "4512")
  })

  const HOP_BY_HOP_HEADERS = new Set([
    "host",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
  ])

  const PUBLIC_V1_GET_PATHS = new Set([
    "/v1/identity/browser-configuration",
    "/v1/identity/login-branding",
  ])

  app.all("/v1/*", async (request, reply) => {
    const origin = process.env.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
    let target: URL
    try {
      target = new URL(request.url, origin)
    } catch {
      return reply.code(400).send({ error: "INVALID_URL" })
    }

    const pathname = target.pathname
    let decodedPathname: string
    try {
      decodedPathname = decodeURIComponent(pathname)
    } catch {
      return reply.code(400).send({ error: "INVALID_PATH" })
    }
    if (
      pathname.includes("..") || pathname.includes("//") || pathname.includes("\\") ||
      decodedPathname.includes("..") || decodedPathname.includes("//") || decodedPathname.includes("\\") || decodedPathname.includes("\0")
    ) {
      return reply.code(400).send({ error: "INVALID_PATH" })
    }

    const isPublic = request.method === "GET" && PUBLIC_V1_GET_PATHS.has(pathname)
    const authHeader = request.headers.authorization
    const token = Array.isArray(authHeader) ? authHeader[0] : authHeader
    if (!isPublic && (!token || !token.startsWith("Bearer ") || !token.slice(7).trim())) {
      return reply.code(401).send({ error: "GENIO_ONE_SESSION_TOKEN_REQUIRED" })
    }

    const connectionHeader = request.headers.connection
    const dynamicHopByHop = new Set<string>()
    if (typeof connectionHeader === "string") {
      for (const item of connectionHeader.split(",")) {
        const trimmed = item.trim().toLowerCase()
        if (trimmed) dynamicHopByHop.add(trimmed)
      }
    }

    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase()
      if (HOP_BY_HOP_HEADERS.has(lower) || dynamicHopByHop.has(lower) || value === undefined) continue
      headers.set(lower, Array.isArray(value) ? value.join(",") : value)
    }
    const method = request.method
    const hasBody = method !== "GET" && method !== "HEAD" && request.body !== undefined
    const body = hasBody
      ? (typeof request.body === "string" || Buffer.isBuffer(request.body)
          ? (request.body as BodyInit)
          : JSON.stringify(request.body))
      : undefined
    const response = await fetch(target, {
      method,
      headers,
      body,
    })
    for (const [key, value] of response.headers) {
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue
      reply.header(key, value)
    }
    if (!response.body) {
      return reply.code(response.status).send()
    }
    return reply.code(response.status).send(Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]))
  })
}

function bridgeE2bWebSocket(
  socket: WebSocket,
  session: { sandboxId: string; sandboxUrl: URL },
  sandboxPort: string,
) {
  const target = new URL(session.sandboxUrl)
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:"
  const upstream = new WebSocket(target, {
    headers: {
      "E2b-Sandbox-Id": session.sandboxId,
      "E2b-Sandbox-Port": sandboxPort,
    },
  })
  const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = []
  socket.on("message", (data: WebSocket.RawData, binary: boolean) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
    else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 500) pending.push({ data, binary })
  })
  socket.on("error", (err) => {
    console.warn(JSON.stringify({ event: "bridge.socket.error", error: err instanceof Error ? err.message : String(err) }))
    upstream.close()
  })
  upstream.on("open", () => {
    for (const message of pending.splice(0)) upstream.send(message.data, { binary: message.binary })
  })
  upstream.on("message", (data: WebSocket.RawData, binary: boolean) => {
    if (socket.readyState === socket.OPEN) socket.send(data, { binary })
  })
  upstream.on("close", () => socket.close())
  upstream.on("error", (err) => {
    console.warn(JSON.stringify({ event: "bridge.upstream.error", error: err instanceof Error ? err.message : String(err) }))
    socket.close(1011, "DESKTOP_UPSTREAM_FAILED")
  })
  socket.on("close", () => upstream.close())
}
