import { afterEach, expect, test } from "bun:test"
import Fastify from "fastify"
import websocket from "@fastify/websocket"
import WebSocket, { WebSocketServer } from "ws"

import { desktopBrowserGrants, DESKTOP_BROWSER_GRANT_QUERY } from "../desktop-proxy"
import { proxyRoutes } from "./proxy"
import { createCapabilityGate } from "../capability-gate"
import type { RuntimeSession } from "../runtime-broker"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function runtimeSession() {
  const desktop = {
    details: {
      kind: "e2b-self-hosted" as const,
      tier: "desktop" as const,
      cwd: "/home/user",
      desktopUrl: "https://desktop.example/vnc.html",
      sandboxId: "sandbox-1",
      environmentId: "e2b-sandbox-1",
      execServerUrl: "ws://executor.example",
      execReady: true,
      botId: "bot-a",
      workspaceId: "workspace-a",
    },
    proxy: {
      executor: { url: "http://e2b.test/", headers: { "E2b-Sandbox-Id": "sandbox-1", "E2b-Sandbox-Port": "4512" } },
      desktop: { url: "http://e2b.test/", headers: { "E2b-Sandbox-Id": "sandbox-1", "E2b-Sandbox-Port": "6080" } },
    },
    close: async () => {},
  }
  return {
    id: "runtime-1",
    relaySecret: "relay",
    principal: { tenant_id: "tenant-1", subject_id: "subject-1", acting_client_id: "genio-one-bot", scopes: [] },
    details: desktop.details,
    runtimeDetails: { desktop: desktop.details },
    leases: { desktop },
    desktop,
    eventBuffer: [],
  } as RuntimeSession
}

function waitForListening(server: WebSocketServer) {
  return new Promise<void>((resolve) => server.once("listening", resolve))
}

function closeWebSocket(server: WebSocketServer) {
  return new Promise<void>((resolve) => server.close(() => resolve()))
}

test("desktop browser grant covers VNC bootstrap, relative assets, and websockify only", async () => {
  const previous = process.env.E2B_SANDBOX_URL
  const originalNow = Date.now
  let now = 1_000
  Date.now = () => now
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await waitForListening(upstream)
  const upstreamAddress = upstream.address()
  if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("UPSTREAM_ADDRESS_UNAVAILABLE")
  process.env.E2B_SANDBOX_URL = `http://127.0.0.1:${upstreamAddress.port}`
  upstream.on("connection", (socket, request) => {
    if (request.headers["e2b-sandbox-id"] !== "sandbox-2" || request.headers["e2b-sandbox-port"] !== "6080") socket.close(1008)
    socket.on("message", (message) => socket.send(message))
  })

  const runtime = runtimeSession()
  runtime.leases.desktop!.proxy!.executor.url = process.env.E2B_SANDBOX_URL
  runtime.leases.desktop!.proxy!.desktop!.url = process.env.E2B_SANDBOX_URL
  let active = true
  const runtimeBroker = { get: (id: string) => active && id === runtime.id ? runtime : undefined, accessTokenForBot: () => "access-token" } as any
  const app = Fastify()
  await app.register(websocket)
  await proxyRoutes(app, {
    runtimeBroker,
    workspaces: { get: () => ({ workspaceId: "workspace-a", provider: "e2b-self-hosted" }) },
    capabilityGate: createCapabilityGate({ mode: "open" }),
    handsPlacement: { authorizeUse: async () => undefined, runCapability: async (_actor: unknown, _capability: unknown, _action: unknown, task: () => unknown) => task() },
  } as any)
  const targets: string[] = []
  globalThis.fetch = (async (input) => {
    const target = String(input)
    targets.push(target)
    if (target.endsWith("/vnc.html")) return new Response("<body>noVNC</body>", { headers: { "content-type": "text/html" } })
    return new Response("asset", { headers: { "content-type": "text/javascript" } })
  }) as typeof fetch

  try {
    const credential = desktopBrowserGrants.issue(runtimeBroker, runtime.id)!
    const first = await app.inject({ method: "GET", url: `/api/desktop/${runtime.id}/vnc.html?${DESKTOP_BROWSER_GRANT_QUERY}=${credential}` })
    expect(first.statusCode).toBe(200)
    expect(first.headers["set-cookie"]).toContain("HttpOnly")
    expect(first.headers["cache-control"]).toBe("no-store")
    expect(first.headers["referrer-policy"]).toBe("no-referrer")
    expect(first.body).toContain("location.pathname+location.hash")
    const initialCookie = String(first.headers["set-cookie"]).split(";")[0]!

    const renewedCredential = desktopBrowserGrants.issue(runtimeBroker, runtime.id)!
    const renewed = await app.inject({ method: "GET", url: `/api/desktop/${runtime.id}/vnc.html?${DESKTOP_BROWSER_GRANT_QUERY}=${renewedCredential}`, headers: { cookie: initialCookie } })
    expect(renewed.statusCode).toBe(200)
    expect(renewed.headers["set-cookie"]).toContain(renewedCredential)

    runtime.leases.desktop = {
      ...runtime.leases.desktop!,
      details: { ...runtime.leases.desktop!.details, sandboxId: "sandbox-2", environmentId: "e2b-sandbox-2" },
      proxy: {
        executor: { url: process.env.E2B_SANDBOX_URL!, headers: { "E2b-Sandbox-Id": "sandbox-2", "E2b-Sandbox-Port": "4512" } },
        desktop: { url: process.env.E2B_SANDBOX_URL!, headers: { "E2b-Sandbox-Id": "sandbox-2", "E2b-Sandbox-Port": "6080" } },
      },
    }
    const replacementCredential = desktopBrowserGrants.issue(runtimeBroker, runtime.id)!
    const replacement = await app.inject({ method: "GET", url: `/api/desktop/${runtime.id}/vnc.html?${DESKTOP_BROWSER_GRANT_QUERY}=${replacementCredential}`, headers: { cookie: initialCookie } })
    expect(replacement.statusCode).toBe(200)
    expect(replacement.headers["set-cookie"]).toContain(replacementCredential)
    const cookie = String(replacement.headers["set-cookie"]).split(";")[0]!

    const asset = await app.inject({ method: "GET", url: `/api/desktop/${runtime.id}/app/ui.js`, headers: { cookie } })
    expect(asset.statusCode).toBe(200)
    expect(targets).toContain(
      `http://127.0.0.1:${upstreamAddress.port}/vnc.html`,
    )
    expect(targets).toContain(`http://127.0.0.1:${upstreamAddress.port}/app/ui.js`)

    await app.listen({ host: "127.0.0.1", port: 0 })
    const address = app.server.address()
    if (!address || typeof address === "string") throw new Error("PROXY_ADDRESS_UNAVAILABLE")
    const client = await new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/desktop/${runtime.id}/websockify`, { headers: { cookie } })
      client.once("open", () => resolve(client))
      client.once("error", reject)
    })
    const sendAndReceive = (marker: string) => new Promise<void>((resolve, reject) => {
      client.once("message", (message) => {
        expect(message.toString()).toBe(marker)
        resolve()
      })
      client.once("error", reject)
      client.send(marker)
    })
    await sendAndReceive("desktop-marker")

    const executorClosed = await new Promise<number>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/executor/${runtime.id}?tier=desktop&${DESKTOP_BROWSER_GRANT_QUERY}=${credential}`, { headers: { cookie } })
      client.once("error", reject)
      client.once("close", (code) => resolve(code))
    })
    expect(executorClosed).toBe(1008)
    expect((await app.inject({ method: "GET", url: `/v1/anything?${DESKTOP_BROWSER_GRANT_QUERY}=${credential}`, headers: { cookie } })).statusCode).toBe(401)
    expect((await app.inject({ method: "GET", url: `/api/desktop/other-runtime/vnc.html?${DESKTOP_BROWSER_GRANT_QUERY}=${credential}` })).statusCode).toBe(404)

    now += 60_001
    expect((await app.inject({ method: "GET", url: `/api/desktop/${runtime.id}/app/ui.js`, headers: { cookie } })).statusCode).toBe(404)
    const expiredClosed = await new Promise<number>((resolve, reject) => {
      const expired = new WebSocket(`ws://127.0.0.1:${address.port}/api/desktop/${runtime.id}/websockify`, { headers: { cookie } })
      expired.once("error", reject)
      expired.once("close", (code) => resolve(code))
    })
    expect(expiredClosed).toBe(1008)
    await sendAndReceive("existing-websocket-marker")
    const clientClosed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)))
    for (const socket of upstream.clients) socket.close()
    expect(await clientClosed).toBe(1000)

    active = false
    expect((await app.inject({ method: "GET", url: `/api/desktop/${runtime.id}/vnc.html?${DESKTOP_BROWSER_GRANT_QUERY}=${credential}` })).statusCode).toBe(404)
  } finally {
    await app.close()
    await closeWebSocket(upstream)
    if (previous === undefined) delete process.env.E2B_SANDBOX_URL
    else process.env.E2B_SANDBOX_URL = previous
    Date.now = originalNow
  }
})

test("executor websocket denies shell frames before forwarding and reports an allowed process once across exit and close", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await waitForListening(upstream)
  const upstreamAddress = upstream.address()
  if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("UPSTREAM_ADDRESS_UNAVAILABLE")
  const runtime = runtimeSession()
  runtime.selectedBotId = "other-bot"
  runtime.leases.desktop!.proxy!.executor.url = `http://127.0.0.1:${upstreamAddress.port}/`
  const runtimeBroker = { get: (id: string) => id === runtime.id ? runtime : undefined } as any
  const nativeFrames: Array<{ id?: number; method?: string; params?: { processId?: string } }> = []
  let shellAllowed = false
  let finishReport!: () => void
  let reportStarted!: () => void
  const reportStartedPromise = new Promise<void>((resolve) => { reportStarted = resolve })
  const reportGate = new Promise<void>((resolve) => { finishReport = resolve })
  const reports: Array<{ correlationId: string; outcome: string }> = []
  upstream.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { id: number; method: string; params?: { processId?: string } }
      nativeFrames.push(frame)
      if (frame.method === "process/start") {
        socket.send(JSON.stringify({ id: frame.id, result: { processId: frame.params?.processId } }))
        socket.send(JSON.stringify({ method: "process/exited", params: { processId: frame.params?.processId, exitCode: 0 } }))
      }
    })
  })
  const app = Fastify()
  await app.register(websocket)
  await proxyRoutes(app, {
    runtimeBroker,
    workspaces: { get: () => ({ workspaceId: "workspace-a", provider: "e2b-self-hosted" }) },
    handsPlacement: {
      async authorizeUse() {},
      async beginCapability(_actor: unknown, capabilityId: string, action: string) {
        expect(capabilityId).toBe("shell.exec")
        expect(action).toBe("execute")
        if (!shellAllowed) throw new Error("SHELL_DENIED")
        return async (outcome: string) => {
          reports.push({ correlationId: "shell-correlation", outcome })
          reportStarted()
          await reportGate
        }
      },
    },
  } as any)
  globalThis.fetch = (async () => Response.json(runtime.principal)) as unknown as typeof fetch
  try {
    await app.listen({ host: "127.0.0.1", port: 0 })
    const address = app.server.address()
    if (!address || typeof address === "string") throw new Error("PROXY_ADDRESS_UNAVAILABLE")
    const connect = async () => {
      const upstreamConnected = new Promise<void>((resolve) => upstream.once("connection", () => resolve()))
      const client = await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/executor/${runtime.id}?tier=desktop`, { headers: { authorization: "Bearer actor" } })
        socket.once("open", () => resolve(socket))
        socket.once("error", reject)
      })
      await upstreamConnected
      return client
    }

    const denied = await connect()
    const deniedClosed = new Promise<number>((resolve) => denied.once("close", (code) => resolve(code)))
    denied.send(JSON.stringify({ id: 1, method: "process/start", params: { processId: "denied-process" } }))
    expect(await deniedClosed).toBe(1008)
    expect(nativeFrames).toEqual([])
    expect(reports).toEqual([])

    shellAllowed = true
    const allowed = await connect()
    const received = new Promise<{ id: number; result: { processId: string } }>((resolve) => allowed.once("message", (raw) => resolve(JSON.parse(raw.toString()))))
    allowed.send(JSON.stringify({ id: 2, method: "process/start", params: { processId: "allowed-process" } }))
    expect(await received).toEqual({ id: 2, result: { processId: "allowed-process" } })
    await reportStartedPromise
    for (const socket of upstream.clients) socket.close()
    finishReport()
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(nativeFrames.map((frame) => frame.params?.processId)).toEqual(["allowed-process"])
    expect(reports).toEqual([{ correlationId: "shell-correlation", outcome: "COMPLETED" }])
    allowed.close()
  } finally {
    finishReport()
    globalThis.fetch = originalFetch
    await app.close()
    for (const socket of upstream.clients) socket.terminate()
    await closeWebSocket(upstream)
  }
})
