import { afterEach, expect, test } from "bun:test"
import Fastify from "fastify"
import websocket from "@fastify/websocket"
import WebSocket, { WebSocketServer } from "ws"

import { desktopBrowserGrants, DESKTOP_BROWSER_GRANT_QUERY } from "../desktop-proxy"
import { proxyRoutes } from "./proxy"
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
  let active = true
  const runtimeBroker = { get: (id: string) => active && id === runtime.id ? runtime : undefined } as any
  const app = Fastify()
  await app.register(websocket)
  await proxyRoutes(app, { runtimeBroker } as any)
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
