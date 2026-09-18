import { describe, expect, test } from "bun:test"

import { createBotModelDirectory, selectPublicModel } from "./model-directory"
import type { GenioPrincipal } from "./runtime-broker"

const principal: GenioPrincipal = {
  tenant_id: "tenant-keycloak-local",
  subject_id: "person-platform-admin",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

describe("BotModelDirectory", () => {
  test("defaults to a replaceable Codex subscription adapter", async () => {
    const directory = createBotModelDirectory({})
    const plans = await directory.resolve(principal, "bot-default")
    expect(directory.availableRoutes()).toEqual(["codex-subscription"])
    expect(plans).toEqual([{
      publicModelId: "*",
      displayName: "Codex subscription catalog",
      route: { kind: "codex-subscription" },
    }])
    expect(selectPublicModel(plans, "any-dev-model")).toBe("any-dev-model")
  })

  test("uses One Policy as the route selector and keeps gateway configuration as an adapter", async () => {
    const directory = createBotModelDirectory({
      GENIO_ONE_MODEL_GATEWAY_BASE_URL: "http://gateway.test/v1",
      GENIO_BOT_GENIO_GATEWAY_MODELS_JSON: JSON.stringify([{ publicModelId: "genio-standard", displayName: "Genio Standard" }]),
    }, {
      platformOrigin: "http://platform.test",
      fetcher: async (input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer user-token")
        if (String(input) === "http://platform.test/v1/tenants/tenant-keycloak-local/me/models") {
          return new Response(JSON.stringify([{
            model_id: "public-model-vertex",
            model_name: "genio-standard",
            display_name: "Genio Standard",
            resource_id: "company-model",
            lifecycle: "PUBLISHED",
          }]), { status: 200, headers: { "content-type": "application/json" } })
        }
        expect(String(input)).toBe("http://platform.test/v1/tenants/tenant-keycloak-local/catalog")
        return new Response(JSON.stringify({ capabilities: [{
          resource_id: "company-model",
          capability_id: "model.invoke",
          connection_status: "READY",
          access: "ENTITLED",
          hub_status: "CONNECTED",
        }] }), { status: 200, headers: { "content-type": "application/json" } })
      },
    })
    expect(directory.availableRoutes()).toEqual(["codex-subscription", "genio-gateway"])
    expect(directory.supports({ kind: "genio-gateway", modelProvider: "genio_one" })).toBe(true)
    expect(await directory.resolve(principal, undefined, { kind: "genio-gateway", modelProvider: "genio_one" }, "user-token")).toEqual([{
      publicModelId: "genio-standard",
      displayName: "Genio Standard",
      route: { kind: "genio-gateway", modelProvider: "genio_one" },
    }])
  })

  test("requires a user token before returning a company model", async () => {
    const directory = createBotModelDirectory({
      GENIO_ONE_MODEL_GATEWAY_BASE_URL: "http://gateway.test/v1",
      GENIO_BOT_GENIO_GATEWAY_MODELS_JSON: JSON.stringify([{ publicModelId: "uat-vertex", displayName: "GCP Vertex Model API" }]),
    })
    await expect(directory.resolve(principal, undefined, { kind: "genio-gateway", modelProvider: "genio_one" })).rejects.toThrow("BOT_MODEL_ENTITLEMENT_REQUIRED")
  })

  test("does not return a company model when the principal is not entitled or connected", async () => {
    const directory = createBotModelDirectory({
      GENIO_ONE_MODEL_GATEWAY_BASE_URL: "http://gateway.test/v1",
      GENIO_BOT_GENIO_GATEWAY_MODELS_JSON: JSON.stringify([{ publicModelId: "uat-vertex", displayName: "GCP Vertex Model API" }]),
    }, {
      fetcher: async (input) => String(input).includes("/me/models")
        ? new Response(JSON.stringify([{
          model_id: "public-model-vertex",
          model_name: "uat-vertex",
          display_name: "GCP Vertex Model API",
          resource_id: "company-model",
          lifecycle: "PUBLISHED",
        }]), { status: 200 })
        : new Response(JSON.stringify({ capabilities: [{
          resource_id: "company-model",
          capability_id: "model.invoke",
          connection_status: "READY",
          access: "REQUEST",
          hub_status: "REQUEST_ACCESS",
        }] }), { status: 200 }),
    })
    await expect(directory.resolve(principal, undefined, { kind: "genio-gateway", modelProvider: "genio_one" }, "user-token")).rejects.toThrow("BOT_MODEL_NOT_ENTITLED")
  })

  test("does not use a same-named capability on another resource", async () => {
    const directory = createBotModelDirectory({
      GENIO_ONE_MODEL_GATEWAY_BASE_URL: "http://gateway.test/v1",
      GENIO_BOT_GENIO_GATEWAY_MODELS_JSON: JSON.stringify([{ publicModelId: "uat-vertex", displayName: "GCP Vertex Model API" }]),
    }, {
      fetcher: async (input) => String(input).includes("/me/models")
        ? new Response(JSON.stringify([{
          model_id: "public-model-vertex",
          model_name: "uat-vertex",
          display_name: "GCP Vertex Model API",
          resource_id: "vertex-resource",
          lifecycle: "PUBLISHED",
        }]), { status: 200 })
        : new Response(JSON.stringify({ capabilities: [{
          resource_id: "other-resource",
          capability_id: "model.invoke",
          connection_status: "READY",
          access: "ENTITLED",
          hub_status: "CONNECTED",
        }] }), { status: 200 }),
    })
    await expect(directory.resolve(principal, undefined, { kind: "genio-gateway", modelProvider: "genio_one" }, "user-token")).rejects.toThrow("BOT_MODEL_NOT_ENTITLED")
  })
})
