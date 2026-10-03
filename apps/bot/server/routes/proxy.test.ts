import { afterEach, expect, test } from "bun:test"
import { request as httpRequest } from "node:http"
import Fastify from "fastify"
import websocket from "@fastify/websocket"
import WebSocket, { WebSocketServer } from "ws"
import RealWebSocket from "../../node_modules/ws/wrapper.mjs"

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

function waitForClose(socket: WebSocket) {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RELAY_CLOSE_TIMEOUT")), 5_000)
    socket.once("close", (code) => { clearTimeout(timer); resolve(code) })
  })
}

async function desktopRelay(upstream: WebSocketServer) {
  const address = upstream.address()
  if (!address || typeof address === "string") throw new Error("UPSTREAM_ADDRESS_UNAVAILABLE")
  const runtime = runtimeSession()
  runtime.id = crypto.randomUUID()
  runtime.leases.desktop!.proxy!.desktop!.url = `http://127.0.0.1:${address.port}/`
  const runtimeBroker = { get: (id: string) => id === runtime.id ? runtime : undefined, accessTokenForBot: () => "access-token" } as any
  const app = Fastify()
  await app.register(websocket)
  await proxyRoutes(app, {
    runtimeBroker,
    workspaces: { get: () => ({ workspaceId: "workspace-a", provider: "e2b-self-hosted" }) },
    capabilityGate: createCapabilityGate({ mode: "open" }),
    handsPlacement: { authorizeUse: async () => undefined, runCapability: async (_actor: unknown, _capability: unknown, _action: unknown, task: () => unknown) => task() },
  } as any)
  globalThis.fetch = (async () => new Response("<body>noVNC</body>")) as unknown as typeof fetch
  const grant = desktopBrowserGrants.issue(runtimeBroker, runtime.id)!
  const bootstrap = await app.inject({ method: "GET", url: `/api/desktop/${runtime.id}/vnc.html?${DESKTOP_BROWSER_GRANT_QUERY}=${grant}` })
  expect(bootstrap.statusCode).toBe(200)
  const cookie = String(bootstrap.headers["set-cookie"]).split(";")[0]!
  await app.listen({ host: "127.0.0.1", port: 0 })
  const proxyAddress = app.server.address()
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("PROXY_ADDRESS_UNAVAILABLE")
  const clients = new Set<WebSocket>()
  const connect = async () => {
    const client = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${proxyAddress.port}/api/desktop/${runtime.id}/websockify`, { headers: { cookie } })
      socket.once("open", () => resolve(socket))
      socket.once("error", reject)
    })
    clients.add(client)
    client.once("close", () => clients.delete(client))
    return client
  }
  const close = async () => {
    for (const client of clients) client.terminate()
    for (const socket of upstream.clients) socket.terminate()
    await app.close()
    await closeWebSocket(upstream)
  }
  return { connect, close, browserPeer: () => [...app.websocketServer.clients].find((socket) => socket.readyState === WebSocket.OPEN) }
}

test("desktop relay preserves text and binary and closes both peers for oversized frames in either direction", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await waitForListening(upstream)
  const forwarded: Buffer[] = []
  upstream.on("connection", (socket) => socket.on("message", (data, binary) => {
    forwarded.push(Buffer.from(data as Buffer))
    socket.send(data, { binary })
  }))
  const relay = await desktopRelay(upstream)
  try {
    const client = await relay.connect()
    const text = new Promise<[string, boolean]>((resolve) => client.once("message", (data, binary) => resolve([data.toString(), binary])))
    client.send("RFB text")
    expect(await text).toEqual(["RFB text", false])
    const binary = new Promise<[Buffer, boolean]>((resolve) => client.once("message", (data, isBinary) => resolve([Buffer.from(data as Buffer), isBinary])))
    client.send(Buffer.from([0, 255, 3]))
    expect(await binary).toEqual([Buffer.from([0, 255, 3]), true])
    const closed = waitForClose(client)
    client.send(Buffer.alloc(8 * 1024 * 1024 + 1))
    expect(await closed).toBe(1009)
    expect(forwarded).toEqual([Buffer.from("RFB text"), Buffer.from([0, 255, 3])])

    const provider = new Promise<WebSocket>((resolve) => upstream.once("connection", resolve))
    const second = await relay.connect()
    const upstreamPeer = await provider
    const secondClosed = waitForClose(second)
    const originalWarn = console.warn
    const parserWarnings: string[] = []
    console.warn = (value) => { parserWarnings.push(String(value)) }
    try {
      upstreamPeer.send(Buffer.alloc(8 * 1024 * 1024 + 1))
      expect(await secondClosed).toBe(1009)
      expect(parserWarnings.some((warning) => warning.includes("Max payload size exceeded"))).toBe(true)
    } finally {
      console.warn = originalWarn
    }

    const third = await relay.connect()
    const thirdClosed = waitForClose(third)
    third.send(Buffer.alloc(16 * 1024 * 1024 + 1))
    expect([1006, 1009]).toContain(await thirdClosed)
    expect(forwarded).toEqual([Buffer.from("RFB text"), Buffer.from([0, 255, 3])])
  } finally {
    await relay.close()
  }
})

test("desktop relay limits connecting upstream bytes before 500 frames", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0, verifyClient: (_info, done) => { setTimeout(() => done(true), 1_000) } })
  await waitForListening(upstream)
  const relay = await desktopRelay(upstream)
  try {
    const client = await relay.connect()
    const closed = waitForClose(client)
    for (let index = 0; index < 9; index += 1) {
      client.send(Buffer.alloc(1024 * 1024))
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(await closed).toBe(1009)
  } finally {
    await relay.close()
  }
})

test("desktop relay forwards binary frames queued before the upstream handshake", async () => {
  let releaseHandshake!: () => void
  const handshake = new Promise<void>((resolve) => { releaseHandshake = resolve })
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0, verifyClient: (_info, done) => { void handshake.then(() => done(true)) } })
  await waitForListening(upstream)
  const received = new Promise<Buffer>((resolve) => upstream.once("connection", (socket) => socket.once("message", (data) => resolve(Buffer.from(data as Buffer)))))
  const relay = await desktopRelay(upstream)
  try {
    const client = await relay.connect()
    const browserPeer = relay.browserPeer()
    expect(browserPeer).toBeDefined()
    const ingested = new Promise<void>((resolve) => browserPeer!.once("message", () => resolve()))
    const payload = Buffer.from([0, 255, 3])
    client.send(payload)
    await ingested
    releaseHandshake()
    expect(await received).toEqual(payload)
    expect(client.readyState).toBe(WebSocket.OPEN)
  } finally {
    releaseHandshake()
    await relay.close()
  }
})

test("desktop relay closes a slow provider and a slow browser instead of retaining unlimited sends", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await waitForListening(upstream)
  const relay = await desktopRelay(upstream)
  const bufferedAmount = Object.getOwnPropertyDescriptor(RealWebSocket.prototype, "bufferedAmount")
  const saturate = () => Object.defineProperty(RealWebSocket.prototype, "bufferedAmount", { configurable: true, get: () => 8 * 1024 * 1024 })
  const restore = () => {
    if (bufferedAmount) Object.defineProperty(RealWebSocket.prototype, "bufferedAmount", bufferedAmount)
    else Reflect.deleteProperty(RealWebSocket.prototype, "bufferedAmount")
  }
  try {
    const firstProvider = new Promise<WebSocket>((resolve) => upstream.once("connection", resolve))
    const client = await relay.connect()
    const provider = await firstProvider
    const providerClosed = waitForClose(provider)
    const clientClosed = waitForClose(client)
    saturate()
    client.send(Buffer.from([1, 2, 3]))
    expect([1006, 1009]).toContain(await clientClosed)
    expect([1006, 1009]).toContain(await providerClosed)
    restore()

    const secondProvider = new Promise<WebSocket>((resolve) => upstream.once("connection", resolve))
    const slowBrowser = await relay.connect()
    const sendingProvider = await secondProvider
    const browserPeer = relay.browserPeer()
    expect(browserPeer).toBeDefined()
    Object.defineProperty(browserPeer!, "bufferedAmount", { configurable: true, value: 8 * 1024 * 1024 })
    const browserClosed = waitForClose(slowBrowser)
    const sendingProviderClosed = waitForClose(sendingProvider)
    await new Promise((resolve) => setTimeout(resolve, 10))
    sendingProvider.send(Buffer.from([4, 5, 6]))
    expect([1006, 1009]).toContain(await browserClosed)
    expect([1006, 1009]).toContain(await sendingProviderClosed)
  } finally {
    restore()
    await relay.close()
  }
}, 15_000)

test("desktop relay closes both peers when automatic pong exceeds the send budget", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await waitForListening(upstream)
  const relay = await desktopRelay(upstream)
  const originalBufferedAmount = Object.getOwnPropertyDescriptor(RealWebSocket.prototype, "bufferedAmount")
  try {
    const firstProvider = new Promise<WebSocket>((resolve) => upstream.once("connection", resolve))
    const firstBrowser = await relay.connect()
    const firstUpstream = await firstProvider
    const browserPeer = relay.browserPeer()
    expect(browserPeer).toBeDefined()
    Object.defineProperty(browserPeer!, "bufferedAmount", { configurable: true, value: 8 * 1024 * 1024 + 1 })
    const browserClosed = waitForClose(firstBrowser)
    const upstreamClosed = waitForClose(firstUpstream)
    firstBrowser.ping()
    expect([1006, 1009]).toContain(await browserClosed)
    expect([1006, 1009]).toContain(await upstreamClosed)

    const secondProvider = new Promise<WebSocket>((resolve) => upstream.once("connection", resolve))
    const secondBrowser = await relay.connect()
    const providerPeer = await secondProvider
    Object.defineProperty(RealWebSocket.prototype, "bufferedAmount", { configurable: true, get: () => 8 * 1024 * 1024 + 1 })
    const secondBrowserClosed = waitForClose(secondBrowser)
    const providerClosed = waitForClose(providerPeer)
    providerPeer.ping()
    expect([1006, 1009]).toContain(await secondBrowserClosed)
    expect([1006, 1009]).toContain(await providerClosed)
  } finally {
    if (originalBufferedAmount) Object.defineProperty(RealWebSocket.prototype, "bufferedAmount", originalBufferedAmount)
    else Reflect.deleteProperty(RealWebSocket.prototype, "bufferedAmount")
    await relay.close()
  }
}, 15_000)

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

test("executor relay queues Bun text frames and counts UTF-8 bytes before forwarding", async () => {
  let releaseHandshake!: () => void
  const handshake = new Promise<void>((resolve) => { releaseHandshake = resolve })
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0, verifyClient: (_info, done) => { void handshake.then(() => done(true)) } })
  await waitForListening(upstream)
  const upstreamAddress = upstream.address()
  if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("UPSTREAM_ADDRESS_UNAVAILABLE")
  const runtime = runtimeSession()
  runtime.leases.desktop!.proxy!.executor.url = `http://127.0.0.1:${upstreamAddress.port}/`
  const app = Fastify()
  await app.register(websocket)
  await proxyRoutes(app, {
    runtimeBroker: { get: (id: string) => id === runtime.id ? runtime : undefined },
    workspaces: { get: () => ({ workspaceId: "workspace-a", provider: "e2b-self-hosted" }) },
    handsPlacement: { authorizeUse: async () => undefined },
  } as any)
  globalThis.fetch = (async () => Response.json(runtime.principal)) as unknown as typeof fetch
  let client: WebSocket | undefined
  try {
    await app.listen({ host: "127.0.0.1", port: 0 })
    const address = app.server.address()
    if (!address || typeof address === "string") throw new Error("PROXY_ADDRESS_UNAVAILABLE")
    const received = new Promise<string[]>((resolve) => upstream.once("connection", (socket) => {
      const frames: string[] = []
      socket.on("message", (data) => {
        frames.push(data.toString())
        if (frames.length === 2) resolve(frames)
      })
    }))
    client = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/executor/${runtime.id}?tier=desktop`, { headers: { authorization: "Bearer actor" } })
      socket.once("open", () => resolve(socket))
      socket.once("error", reject)
    })
    const browserPeer = [...app.websocketServer.clients].find((socket) => socket.readyState === WebSocket.OPEN)
    expect(browserPeer).toBeDefined()
    const ingested = new Promise<void>((resolve) => browserPeer!.once("message", () => resolve()))
    const networkPayload = JSON.stringify({ id: 1, method: "environment/info", params: { text: "network" } })
    const shimPayload = JSON.stringify({ id: 2, method: "environment/info", params: { text: "界" } })
    client.send(networkPayload)
    await ingested
    browserPeer!.emit("message", shimPayload, false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.readyState).toBe(WebSocket.OPEN)
    releaseHandshake()
    expect(await received).toEqual([networkPayload, shimPayload])
    expect(client.readyState).toBe(WebSocket.OPEN)
    const oversized = "界".repeat(Math.floor(8 * 1024 * 1024 / 3) + 1)
    expect(oversized.length).toBeLessThan(8 * 1024 * 1024)
    const closed = waitForClose(client)
    browserPeer!.emit("message", oversized, false)
    expect(await closed).toBe(1009)
  } finally {
    releaseHandshake()
    client?.terminate()
    globalThis.fetch = originalFetch
    await app.close()
    for (const socket of upstream.clients) socket.terminate()
    await closeWebSocket(upstream)
  }
})

function rawProxyRequest(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ statusCode: number | undefined; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      response.once("error", reject)
      response.once("end", () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }))
    })
    request.once("error", reject)
    request.setTimeout(5_000, () => request.destroy(new Error("PROXY_REQUEST_TIMEOUT")))
    request.end(options.body)
  })
}

test("proxy /v1/* anchors raw absolute request targets to the configured platform", async () => {
  const previousOrigin = process.env.GENIO_ONE_PLATFORM_ORIGIN
  process.env.GENIO_ONE_PLATFORM_ORIGIN = "http://platform.example:58082/configured?discard=1#configured"
  const app = Fastify()
  const rawTargets: string[] = []
  app.addHook("onRequest", async (request) => { rawTargets.push(request.raw.url!) })
  await proxyRoutes(app, {} as any)
  const calls: Array<{ target: string; authorization: string | null }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ target: String(input), authorization: new Headers(init?.headers).get("authorization") })
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })
  }) as typeof fetch

  try {
    await app.listen({ host: "127.0.0.1", port: 0 })
    const address = app.server.address()
    if (!address || typeof address === "string") throw new Error("PROXY_ADDRESS_UNAVAILABLE")
    const publicTarget = "http://attacker.example/v1/identity/browser-configuration?return=https%3A%2F%2Fattacker.example"
    const privateTarget = "https://attacker.example/v1/private?tenant=one&item=a%2Fb"
    expect((await rawProxyRequest(address.port, publicTarget)).statusCode).toBe(200)
    expect((await rawProxyRequest(address.port, privateTarget, { headers: { authorization: "Bearer private-token" } })).statusCode).toBe(200)
    expect(rawTargets).toEqual([publicTarget, privateTarget])
    expect(calls).toEqual([
      { target: "http://platform.example:58082/v1/identity/browser-configuration?return=https%3A%2F%2Fattacker.example", authorization: null },
      { target: "http://platform.example:58082/v1/private?tenant=one&item=a%2Fb", authorization: "Bearer private-token" },
    ])
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
    if (previousOrigin === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
    else process.env.GENIO_ONE_PLATFORM_ORIGIN = previousOrigin
  }
})

test("proxy /v1/* rejects normalized authority paths and encoded malformed paths before forwarding bearer tokens", async () => {
  const app = Fastify()
  const rawTargets: string[] = []
  app.addHook("onRequest", async (request) => { rawTargets.push(request.raw.url!) })
  await proxyRoutes(app, {} as any)
  const calls: string[] = []
  globalThis.fetch = (async (input) => {
    calls.push(String(input))
    return new Response("unexpected forwarding")
  }) as typeof fetch
  const targets = [
    "/v1/..//attacker.example/v1/private",
    "/v1/%2e%2e//attacker.example/v1/private",
    "/v1/.%2e//attacker.example/v1/private",
    "http://attacker.example/v1/..//attacker.example/v1/private",
    "/v1/%2f%2fattacker.example/v1/private",
    "/v1/%5cattacker.example/v1/private",
    "/v1/private%00",
    "/v1/private%09",
    "/v1/private%0a",
    "/v1/private%7f",
  ]
  try {
    await app.listen({ host: "127.0.0.1", port: 0 })
    const address = app.server.address()
    if (!address || typeof address === "string") throw new Error("PROXY_ADDRESS_UNAVAILABLE")
    for (const target of targets) {
      const response = await rawProxyRequest(address.port, target, { headers: { authorization: "Bearer private-token" } })
      expect(response.statusCode).toBe(400)
      expect(JSON.parse(response.body)).toEqual({ error: "INVALID_PATH" })
    }
    expect(rawTargets).toEqual(targets)
    expect(calls).toEqual([])
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
  }
})

test("proxy /v1/* preserves public GET, private authentication, request bodies, query strings, and hop header filtering", async () => {
  const previousOrigin = process.env.GENIO_ONE_PLATFORM_ORIGIN
  process.env.GENIO_ONE_PLATFORM_ORIGIN = "http://platform.example:58082"
  const app = Fastify()
  await proxyRoutes(app, {} as any)
  const calls: Array<{ target: string; method: string | undefined; headers: Headers; body: BodyInit | null | undefined }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ target: String(input), method: init?.method, headers: new Headers(init?.headers), body: init?.body })
    if (String(input).includes("/empty")) return new Response(null, { status: 204 })
    return new Response("platform-result", { status: 201, headers: { "content-type": "text/plain", "x-platform-result": "retained", connection: "close", "keep-alive": "timeout=5" } })
  }) as typeof fetch
  try {
    await app.listen({ host: "127.0.0.1", port: 0 })
    const address = app.server.address()
    if (!address || typeof address === "string") throw new Error("PROXY_ADDRESS_UNAVAILABLE")
    for (const path of ["/v1/identity/browser-configuration", "/v1/identity/login-branding"]) {
      expect((await rawProxyRequest(address.port, path)).statusCode).toBe(201)
    }
    const publicCallCount = calls.length
    for (const options of [{}, { headers: { authorization: "Basic invalid" } }, { headers: { authorization: "Bearer " } }]) {
      expect((await rawProxyRequest(address.port, "/v1/private", options)).statusCode).toBe(401)
    }
    expect((await rawProxyRequest(address.port, "/v1/identity/login-branding", { method: "POST" })).statusCode).toBe(401)
    expect(calls).toHaveLength(publicCallCount)
    const response = await rawProxyRequest(address.port, "/v1/private?item=a%2Fb&return=https%3A%2F%2Fattacker.example", {
      method: "POST",
      headers: { authorization: "Bearer private-token", "content-type": "application/json", connection: "close, x-private-hop", "x-private-hop": "removed", "proxy-authorization": "removed", "x-client-header": "retained" },
      body: JSON.stringify({ action: "save" }),
    })
    const call = calls.at(-1)!
    expect(call.target).toBe("http://platform.example:58082/v1/private?item=a%2Fb&return=https%3A%2F%2Fattacker.example")
    expect(call.method).toBe("POST")
    expect(call.body).toBe(JSON.stringify({ action: "save" }))
    expect(call.headers.get("authorization")).toBe("Bearer private-token")
    expect(call.headers.get("x-client-header")).toBe("retained")
    for (const name of ["host", "connection", "content-length", "x-private-hop", "proxy-authorization"]) expect(call.headers.has(name)).toBe(false)
    expect(response.statusCode).toBe(201)
    expect(response.body).toBe("platform-result")
    expect(response.headers["x-platform-result"]).toBe("retained")
    expect(response.headers["keep-alive"]).toBeUndefined()
    expect((await rawProxyRequest(address.port, "/v1/empty", { headers: { authorization: "Bearer private-token" } })).statusCode).toBe(204)
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
    if (previousOrigin === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
    else process.env.GENIO_ONE_PLATFORM_ORIGIN = previousOrigin
  }
})

test("proxy /v1/* sends the first response chunk before the upstream stream completes", async () => {
  const app = Fastify()
  await proxyRoutes(app, {} as any)
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let upstreamCompleted = false
  const encoder = new TextEncoder()
  globalThis.fetch = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController
      controller.enqueue(encoder.encode("first-chunk"))
    },
  }), { headers: { "content-type": "text/event-stream" } }), { preconnect: () => {} })
  let request: ReturnType<typeof httpRequest> | undefined
  let resolveFirst!: (value: string) => void
  let rejectFirst!: (error: Error) => void
  const firstChunk = new Promise<string>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject })
  try {
    await app.listen({ host: "127.0.0.1", port: 0 })
    const address = app.server.address()
    if (!address || typeof address === "string") throw new Error("PROXY_ADDRESS_UNAVAILABLE")
    const completed = new Promise<string>((resolve, reject) => {
      request = httpRequest({ hostname: "127.0.0.1", port: address.port, path: "/v1/events", headers: { authorization: "Bearer private-token" } }, (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk) => { chunks.push(Buffer.from(chunk)); resolveFirst(Buffer.from(chunk).toString()) })
        response.once("error", (error) => { rejectFirst(error); reject(error) })
        response.once("end", () => resolve(Buffer.concat(chunks).toString()))
      })
      request.once("error", (error) => { rejectFirst(error); reject(error) })
      request.setTimeout(5_000, () => request!.destroy(new Error("PROXY_STREAM_TIMEOUT")))
      request.end()
    })
    void completed.catch(() => undefined)
    expect(await firstChunk).toBe("first-chunk")
    expect(upstreamCompleted).toBe(false)
    controller.enqueue(encoder.encode("last-chunk"))
    controller.close()
    upstreamCompleted = true
    expect(await completed).toBe("first-chunklast-chunk")
  } finally {
    if (controller && !upstreamCompleted) controller.close()
    request?.destroy()
    globalThis.fetch = originalFetch
    await app.close()
  }
}, 10_000)
