import { describe, expect, it } from "bun:test"
import { createBotApp } from "./app"
import { BotRegistry } from "./bot-registry"

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

        const runtimeRes = await app.inject({ method: "GET", url: "/api/runtime" })
        expect(runtimeRes.statusCode).toBe(200)
        const runtimeJson = runtimeRes.json()
        expect(runtimeJson.configured).toBeDefined()
        expect(runtimeJson.capabilityGate).toBeDefined()
        expect(runtimeJson.modelDirectory).toBeDefined()
      } finally {
        await app.close()
      }
    } finally {
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
