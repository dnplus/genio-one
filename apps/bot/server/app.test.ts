import { describe, expect, it } from "bun:test"
import { createBotApp } from "./app"
import { BotRegistry } from "./bot-registry"
import { RuntimeBroker } from "./runtime-broker"

describe("createBotApp factory", () => {
  it("initializes Fastify app with healthz and api/runtime routes", async () => {
    const registry = new BotRegistry(":memory:")
    try {
      const app = await createBotApp({ botRegistry: registry })
      try {
        const healthRes = await app.inject({ method: "GET", url: "/healthz" })
        expect(healthRes.statusCode).toBe(200)
        const healthJson = healthRes.json()
        expect(healthJson.status).toBe("ok")
        expect(healthJson.component).toBe("genio-one-bot")
        expect(healthJson.configured).toBeDefined()
        expect(healthJson.capabilityGate).toBeDefined()
        expect(healthJson.modelDirectory).toBe("one-policy")
        expect(Object.keys(healthJson).sort()).toEqual(["capabilityGate", "component", "configured", "modelDirectory", "status"])

        const runtimeRes = await app.inject({ method: "GET", url: "/api/runtime" })
        expect(runtimeRes.statusCode).toBe(401)
        expect(runtimeRes.json().error).toBe("GENIO_ONE_SESSION_TOKEN_REQUIRED")
      } finally {
        await app.close()
      }
    } finally {
      registry.close()
    }
  })

  it("returns only the authenticated owner's sanitized runtime status", async () => {
    const registry = new BotRegistry(":memory:")
    const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
    const owner = { tenant_id: "tenant-secret", subject_id: "subject-secret", acting_client_id: "client-secret", scopes: [] }
    const other = { tenant_id: "other-tenant", subject_id: "other-subject", acting_client_id: "other-client", scopes: [] }
    const originalFetch = globalThis.fetch
    try {
      const ownerSession = await broker.start(owner, { onMessage() {}, onExit() {} })
      ownerSession.details = {
        kind: "endpoint",
        tier: "desktop",
        cwd: "/tenant-secret/workspace-secret",
        desktopUrl: "https://desktop-secret.example/session-secret",
        sandboxId: "sandbox-secret",
        environmentId: "environment-secret",
        execServerUrl: "wss://executor-secret.example/session-secret",
        execReady: true,
        botId: "bot-secret",
        workspaceId: "workspace-secret",
        leaseId: "lease-secret",
        endpoint: { botId: "bot-secret", hostname: "host-secret.example", expiresAt: Date.now() + 60_000 },
      }
      const otherSession = await broker.start(other, { onMessage() {}, onExit() {} })
      otherSession.details = {
        kind: "cloudflare-hands",
        tier: "headless",
        cwd: "/other-private-workspace",
        desktopUrl: null,
        sandboxId: null,
        environmentId: "other-environment-secret",
        execServerUrl: "wss://other-executor-secret.example",
        execReady: true,
      }
      const app = await createBotApp({ botRegistry: registry, runtimeBroker: broker })
      const principals = new Map([
        ["owner-token", owner],
        ["other-token", other],
        ["tenant-mismatch-token", { ...owner, tenant_id: "wrong-tenant" }],
        ["subject-mismatch-token", { ...owner, subject_id: "wrong-subject" }],
        ["client-mismatch-token", { ...owner, acting_client_id: "wrong-client" }],
      ])
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (new URL(String(input)).pathname !== "/v1/identity/session") throw new Error("unexpected fetch")
        const token = new Headers(init?.headers).get("authorization")?.slice("Bearer ".length)
        if (token === "platform-unavailable-token") return new Response(null, { status: 503 })
        if (token === "network-error-token") throw new TypeError("identity connection failed")
        const principal = token ? principals.get(token) : null
        return principal ? Response.json(principal) : new Response(null, { status: 401 })
      }) as typeof fetch
      try {
        const health = await app.inject({ method: "GET", url: "/healthz" })
        expect(health.statusCode).toBe(200)
        const anonymous = await app.inject({ method: "GET", url: "/api/runtime" })
        expect(anonymous.statusCode).toBe(401)
        expect(anonymous.body).not.toContain("sandbox-secret")
        const rejected = await app.inject({ method: "GET", url: "/api/runtime", headers: { authorization: "Bearer rejected-token" } })
        expect(rejected.statusCode).toBe(401)
        for (const token of ["platform-unavailable-token", "network-error-token"]) {
          const unavailable = await app.inject({ method: "GET", url: "/api/runtime", headers: { authorization: `Bearer ${token}` } })
          expect(unavailable.statusCode).toBe(503)
          expect(unavailable.json().error).toBe("GENIO_ONE_SESSION_UNAVAILABLE")
        }
        const response = await app.inject({ method: "GET", url: "/api/runtime", headers: { authorization: "Bearer owner-token" } })
        expect(response.statusCode).toBe(200)
        expect(response.headers["cache-control"]).toBe("no-store")
        expect(Object.keys(response.json()).sort()).toEqual(["active", "capabilityGate", "configured", "modelDirectory"])
        expect(response.json().active).toEqual({ kind: "endpoint", tier: "desktop", execReady: true, hasEnvironment: true, hasSandbox: true, hasDesktop: true })
        for (const secret of ["tenant-secret", "subject-secret", "client-secret", "desktop-secret", "sandbox-secret", "environment-secret", "executor-secret", "bot-secret", "workspace-secret", "lease-secret", "host-secret", "session-secret"]) {
          expect(response.body).not.toContain(secret)
          expect(health.body).not.toContain(secret)
        }
        const otherResponse = await app.inject({ method: "GET", url: "/api/runtime", headers: { authorization: "Bearer other-token" } })
        expect(otherResponse.statusCode).toBe(200)
        expect(otherResponse.json().active).toEqual({ kind: "cloudflare-hands", tier: "headless", execReady: true, hasEnvironment: true, hasSandbox: false, hasDesktop: false })
        expect(otherResponse.body).not.toContain("other-environment-secret")
        expect(otherResponse.body).not.toContain("other-executor-secret")
        for (const token of ["tenant-mismatch-token", "subject-mismatch-token", "client-mismatch-token"]) {
          const result = await app.inject({ method: "GET", url: "/api/runtime", headers: { authorization: `Bearer ${token}` } })
          expect(result.statusCode).toBe(200)
          expect(result.json().active).toBeNull()
        }
      } finally {
        globalThis.fetch = originalFetch
        await app.close()
      }
    } finally {
      globalThis.fetch = originalFetch
      await broker.close()
      registry.close()
    }
  })

  it("fails closed on unauthenticated /api/bots request", async () => {
    const registry = new BotRegistry(":memory:")
    try {
      const app = await createBotApp({ botRegistry: registry })
      try {
        const res = await app.inject({ method: "GET", url: "/api/bots" })
        expect(res.statusCode).toBe(401)
        expect(res.json().error).toBe("GENIO_ONE_SESSION_TOKEN_REQUIRED")
      } finally {
        await app.close()
      }
    } finally {
      registry.close()
    }
  })
})
