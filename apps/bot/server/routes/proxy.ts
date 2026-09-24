import { Readable } from "node:stream"
import WebSocket from "ws"
import type { FastifyInstance } from "fastify"

import { authenticateDesktopProxySession, authenticateExecutorProxySession, requestAccessToken, requestPrincipal } from "../auth"
import { appendDesktopLocationCleanup, desktopBrowserCookie, DESKTOP_BROWSER_GRANT_QUERY } from "../desktop-proxy"
import type { BotServerContext } from "../context"
import { assertCapability, PERSONAL_BOT_COMPUTER_USE } from "../capability-gate"
import { executorMethodCapability } from "../local-hands"
import { defaultRuntimeCapabilityAction } from "@genioone/protocol/runtime-capability-actions"

export async function proxyRoutes(app: FastifyInstance, context: BotServerContext) {
  const authorizeDesktop = async (runtimeSessionId: string) => {
    const runtime = context.runtimeBroker.get(runtimeSessionId)
    const lease = runtime?.leases.desktop
    if (!runtime || !lease || !lease.details.execReady || !lease.details.botId || !lease.details.workspaceId || (lease.details.kind !== "e2b-self-hosted" && lease.details.kind !== "cloudflare-hands")) throw new Error("DESKTOP_SESSION_NOT_FOUND")
    const botId = lease.details.botId
    const workspace = context.workspaces.get(runtime.principal, botId, lease.details.workspaceId)
    if (!workspace || workspace.provider !== lease.details.kind) throw new Error("RUNTIME_WORKSPACE_NOT_OWNED")
    const accessToken = context.runtimeBroker.accessTokenForBot(runtime.id, botId) || ""
    await assertCapability(context.capabilityGate, runtime.principal, PERSONAL_BOT_COMPUTER_USE, accessToken)
    const actor = { principal: runtime.principal, botId, accessToken, sessionId: runtime.id }
    await context.handsPlacement.authorizeUse(actor, workspace.provider)
    await context.handsPlacement.runCapability(actor, "computer.use", "invoke", () => undefined, undefined, "ALLOW")
    if (context.runtimeBroker.get(runtime.id)?.leases.desktop !== lease || !lease.details.execReady) throw new Error("RUNTIME_LEASE_STALE")
  }

  app.get("/api/desktop/:runtimeSessionId/*", async (request, reply) => {
    const { runtimeSessionId, "*": path } = request.params as { runtimeSessionId: string; "*": string }
    let decoded: string
    try { decoded = decodeURIComponent(path || "") }
    catch { return reply.code(400).send({ error: "INVALID_PATH" }) }
    if (path && (decoded !== path || decoded.startsWith("/") || decoded.includes("\\") || decoded.includes(":") || decoded.includes("\0") || decoded.split("/").some((part) => part === "." || part === ".." || !part))) {
      return reply.code(400).send({ error: "INVALID_PATH" })
    }
    const session = authenticateDesktopProxySession(context.runtimeBroker, runtimeSessionId, request, path === "vnc.html")
    if (!session) return reply.code(404).send({ error: "DESKTOP_SESSION_NOT_FOUND" })
    if (path === "vnc.html") {
      try { await authorizeDesktop(runtimeSessionId) }
      catch (error) { return reply.code(403).send({ error: error instanceof Error ? error.message : "RUNTIME_POLICY_DENIED" }) }
    }
    const target = new URL(path || "vnc.html", session.target.url)
    const response = await fetch(target, {
      headers: session.target.headers,
    })
    const contentType = response.headers.get("content-type")
    const cacheControl = response.headers.get("cache-control")
    if (contentType) reply.header("content-type", contentType)
    if (cacheControl) reply.header("cache-control", cacheControl)
    if (path === "vnc.html" && response.ok && session.bootstrap) {
      const credential = typeof (request.query as Record<string, unknown> | undefined)?.[DESKTOP_BROWSER_GRANT_QUERY] === "string"
        ? (request.query as Record<string, string>)[DESKTOP_BROWSER_GRANT_QUERY]
        : null
      if (credential) reply.header("set-cookie", desktopBrowserCookie(runtimeSessionId, credential, session.grantExpiresAt))
      reply.header("cache-control", "no-store")
      reply.header("referrer-policy", "no-referrer")
    }
    const body = new Uint8Array(await response.arrayBuffer())
    return reply.code(response.status).send(path === "vnc.html" && response.ok ? appendDesktopLocationCleanup(body) : Buffer.from(body))
  })

  app.get("/api/desktop/:runtimeSessionId/websockify", { websocket: true }, async (socket, request) => {
    const { runtimeSessionId } = request.params as { runtimeSessionId: string }
    const session = authenticateDesktopProxySession(context.runtimeBroker, runtimeSessionId, request, false)
    if (!session) {
      socket.close(1008, "DESKTOP_SESSION_NOT_FOUND")
      return
    }
    try { await authorizeDesktop(runtimeSessionId) }
    catch (error) { socket.close(1008, error instanceof Error ? error.message.slice(0, 100) : "RUNTIME_POLICY_DENIED"); return }
    bridgeProviderWebSocket(socket, session.websocketTarget)
  })

  app.get("/api/executor/:runtimeSessionId", { websocket: true }, async (socket, request) => {
    const { runtimeSessionId } = request.params as { runtimeSessionId: string }
    const query = request.query as { tier?: string }
    const tier = query.tier === "desktop" || query.tier === "headless" ? query.tier : undefined
    const session = await authenticateExecutorProxySession(context.runtimeBroker, runtimeSessionId, tier, request)
    if (!session) {
      socket.close(1008, "EXECUTOR_SESSION_NOT_FOUND")
      return
    }
    const runtime = context.runtimeBroker.get(runtimeSessionId)
    const lease = tier ? runtime?.leases[tier] : runtime?.desktop
    if (!runtime || !lease || !lease.details.execReady || lease.proxy?.executor !== session || !lease.details.botId || !lease.details.workspaceId || (lease.details.kind !== "e2b-self-hosted" && lease.details.kind !== "cloudflare-hands")) {
      socket.close(1008, "EXECUTOR_SESSION_NOT_FOUND")
      return
    }
    let executorActor: { principal: typeof runtime.principal; botId: string; accessToken: string; sessionId: string } | null = null
    let executorProvider: "e2b-self-hosted" | "cloudflare-hands" | null = null
    try {
      const principal = await requestPrincipal(request)
      const workspace = context.workspaces.get(principal, lease.details.botId, lease.details.workspaceId)
      if (!workspace || workspace.provider !== lease.details.kind) throw new Error("RUNTIME_WORKSPACE_NOT_OWNED")
      executorActor = { principal, botId: lease.details.botId, accessToken: requestAccessToken(request), sessionId: runtime.id }
      executorProvider = workspace.provider
      await context.handsPlacement.authorizeUse(executorActor, executorProvider)
      if (context.runtimeBroker.get(runtime.id)?.leases[lease.details.tier as "headless" | "desktop"] !== lease || !lease.details.execReady) throw new Error("RUNTIME_LEASE_STALE")
    } catch (error) {
      socket.close(1008, error instanceof Error ? error.message.slice(0, 100) : "RUNTIME_POLICY_DENIED")
      return
    }
    bridgeProviderWebSocket(socket, session, async (message) => {
      if (!executorActor || !executorProvider || !lease.details.execReady || context.runtimeBroker.get(runtime.id)?.leases[lease.details.tier as "headless" | "desktop"] !== lease) throw new Error("RUNTIME_LEASE_STALE")
      if (typeof message.method !== "string") {
        if (message.id !== undefined) return null
        throw new Error("EXECUTOR_REQUEST_INVALID")
      }
      const capabilityId = executorMethodCapability(message.method)
      if (!capabilityId) return null
      if (message.id === undefined) throw new Error("EXECUTOR_REQUEST_ID_REQUIRED")
      const action = defaultRuntimeCapabilityAction(capabilityId)
      if (!action) throw new Error("RUNTIME_POLICY_CAPABILITY_INVALID")
      await context.handsPlacement.authorizeUse(executorActor, executorProvider)
      const finish = await context.handsPlacement.beginCapability(executorActor, capabilityId, action)
      if (!lease.details.execReady || context.runtimeBroker.get(runtime.id)?.leases[lease.details.tier as "headless" | "desktop"] !== lease) {
        await finish("FAILED", "RUNTIME_LEASE_STALE")
        throw new Error("RUNTIME_LEASE_STALE")
      }
      return finish
    })
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

function bridgeProviderWebSocket(
  socket: WebSocket,
  target: { url: string | URL; headers: Record<string, string> },
  authorizeFrame?: (message: Record<string, unknown>) => Promise<((outcome: "COMPLETED" | "FAILED", reasonCode?: string) => Promise<void>) | null>,
) {
  const frame = (data: WebSocket.RawData) => Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
  const upstreamUrl = new URL(target.url)
  upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:"
  const upstream = new WebSocket(upstreamUrl, { headers: target.headers })
  const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = []
  const decisions = new Map<string, { finish: (outcome: "COMPLETED" | "FAILED", reasonCode?: string) => Promise<void>; processId?: string }>()
  const processes = new Map<string, (outcome: "COMPLETED" | "FAILED", reasonCode?: string) => Promise<void>>()
  let inbound = Promise.resolve()
  let outbound = Promise.resolve()
  socket.on("message", (data: WebSocket.RawData, binary: boolean) => {
    inbound = inbound.then(async () => {
      if (authorizeFrame) {
        if (binary || frame(data).byteLength > 8 * 1024 * 1024) throw new Error("EXECUTOR_FRAME_INVALID")
        const message = JSON.parse(frame(data).toString("utf8")) as Record<string, unknown>
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("EXECUTOR_FRAME_INVALID")
        const finish = await authorizeFrame(message)
        if (finish) {
          const key = JSON.stringify(message.id)
          if (decisions.size >= 64 || decisions.has(key)) throw new Error("EXECUTOR_REQUEST_CONFLICT")
          const processId = message.method === "process/start" && message.params && typeof message.params === "object" && typeof (message.params as { processId?: unknown }).processId === "string"
            ? (message.params as { processId: string }).processId
            : undefined
          if (message.method === "process/start" && (!processId || processes.has(processId))) throw new Error("EXECUTOR_PROCESS_CONFLICT")
          decisions.set(key, { finish, ...(processId ? { processId } : {}) })
          if (processId) processes.set(processId, finish)
        }
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
      else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 500) pending.push({ data, binary })
      else throw new Error("EXECUTOR_UPSTREAM_UNAVAILABLE")
    }).catch((error) => { socket.close(1008, error instanceof Error ? error.message.slice(0, 100) : "EXECUTOR_POLICY_DENIED"); upstream.close() })
  })
  socket.on("error", (err) => {
    console.warn(JSON.stringify({ event: "bridge.socket.error", error: err instanceof Error ? err.message : String(err) }))
    upstream.close()
  })
  upstream.on("open", () => {
    for (const message of pending.splice(0)) upstream.send(message.data, { binary: message.binary })
  })
  upstream.on("message", (data: WebSocket.RawData, binary: boolean) => {
    outbound = outbound.then(async () => {
      if (authorizeFrame && !binary) {
        const message = JSON.parse(frame(data).toString("utf8")) as { id?: unknown; error?: { code?: unknown } }
        const notification = message as { method?: string; params?: { processId?: string; exitCode?: number } }
        if (notification.method === "process/exited" && notification.params?.processId) {
          const finish = processes.get(notification.params.processId)
          if (finish) {
            processes.delete(notification.params.processId)
            for (const [key, pending] of decisions) if (pending.processId === notification.params.processId) decisions.delete(key)
            await finish(notification.params.exitCode === 0 ? "COMPLETED" : "FAILED", notification.params.exitCode === 0 ? undefined : "EXECUTOR_PROCESS_EXIT_NONZERO")
          }
        }
        if (message.id !== undefined) {
          const key = JSON.stringify(message.id)
          const pendingDecision = decisions.get(key)
          if (pendingDecision) {
            decisions.delete(key)
            if (pendingDecision.processId) {
              if (message.error) {
                processes.delete(pendingDecision.processId)
                await pendingDecision.finish("FAILED", typeof message.error.code === "string" ? message.error.code : "EXECUTOR_PROCESS_START_FAILED")
              }
            } else await pendingDecision.finish(message.error ? "FAILED" : "COMPLETED", typeof message.error?.code === "string" ? message.error.code : undefined)
          }
        }
      }
      if (socket.readyState === socket.OPEN) socket.send(data, { binary })
    }).catch(() => { socket.close(1011, "EXECUTOR_REPORT_UNAVAILABLE"); upstream.close() })
  })
  const failOutstanding = () => {
    for (const { finish } of decisions.values()) void finish("FAILED", "EXECUTOR_PROXY_DISCONNECTED").catch(() => undefined)
    for (const finish of processes.values()) void finish("FAILED", "EXECUTOR_RESULT_UNCONFIRMED").catch(() => undefined)
    decisions.clear()
    processes.clear()
  }
  upstream.on("close", () => { failOutstanding(); socket.close() })
  upstream.on("error", (err) => {
    console.warn(JSON.stringify({ event: "bridge.upstream.error", error: err instanceof Error ? err.message : String(err) }))
    socket.close(1011, "DESKTOP_UPSTREAM_FAILED")
  })
  socket.on("close", () => { failOutstanding(); upstream.close() })
}
