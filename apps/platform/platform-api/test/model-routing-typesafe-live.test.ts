import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createInMemoryModelRouter } from "../src/capabilities/model-routing/memory"
import { typeSafeModelRoutingFromEnvironment } from "../src/capabilities/model-routing/typesafe-decision-provider"
import type { PublicModelCatalog } from "../src/capabilities/models/module"
import { createModelMemoryState } from "../src/capabilities/models/state"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

test("live TypeSafe decision returns a versioned route and labels through the Platform API", {
  skip: process.env.GENIO_ONE_TYPESAFE_LIVE_TEST !== "1",
  timeout: 30_000,
}, async () => {
  const configured = typeSafeModelRoutingFromEnvironment(process.env)
  assert.ok(configured)
  const tenantId = "tenant-typesafe-live"
  const models = [
    {
      tenant_id: tenantId,
      model_id: "standard-chat",
      model_name: "standard-chat",
      display_name: "Standard Chat",
      resource_id: "routed-models",
      visibility: "PUBLIC" as const,
      lifecycle: "PUBLISHED" as const,
      capabilities: ["CHAT", "STREAMING"] as const,
      created_at: 1,
    },
    {
      tenant_id: tenantId,
      model_id: "reasoning-tools",
      model_name: "reasoning-tools",
      display_name: "Reasoning and Tools",
      resource_id: "routed-models",
      visibility: "PUBLIC" as const,
      lifecycle: "PUBLISHED" as const,
      capabilities: ["CHAT", "REASONING", "TOOL_CALLING"] as const,
      created_at: 1,
    },
  ]
  const mappings = models.map((model) => ({
    tenant_id: tenantId,
    mapping_id: `mapping-${model.model_id}`,
    public_model_id: model.model_id,
    resource_id: model.resource_id,
    connection_id: `connection-${model.model_id}`,
    provider_model: `provider-${model.model_id}`,
    mapping_revision: 1,
    created_at: 1,
  }))
  const catalog: PublicModelCatalog = {
    list: async () => models.map((model) => ({ ...model, capabilities: [...model.capabilities] })),
    async get({ modelId }) {
      const model = models.find((candidate) => candidate.model_id === modelId)
      if (!model) throw new Error("MODEL_NOT_FOUND")
      return { ...model, capabilities: [...model.capabilities] }
    },
    listMappings: async () => mappings,
    create: async () => { throw new Error("not used") },
    addMapping: async () => { throw new Error("not used") },
  }
  const modules = createInMemoryPlatformModules()
  modules.modelRouter = createInMemoryModelRouter({
    state: createModelMemoryState(),
    models: catalog,
    decisionProvider: configured.provider,
    decisionMinimumConfidence: configured.minimumConfidence,
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "live-token": {
        tenant_id: tenantId,
        subject_id: "person-typesafe-live",
        client_id: "application-typesafe-live",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
      },
    }),
    entitlementResolver: {
      resolve: () => models.map((model) => model.model_id),
    },
  })
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/model-routing/resolve`,
      headers: { authorization: "Bearer live-token" },
      payload: {
        public_model_id: "automatic-route",
        session_id: "typesafe-live-session",
        entitled_public_model_ids: ["caller-injected-model"],
        semantic_routing: {
          task: "Inspect a failed deployment, use tools to gather evidence, and propose a safe repair.",
        },
      },
    })
    assert.equal(response.statusCode, 200, response.body)
    const route = response.json() as {
      selected_public_model_id: string
      decision_receipt: {
        requested_model: string
        resolved_model: string
        suggested_public_model_id: string
        confidence: number
        annotations: {
          task_kind: string
          complexity_score: number
          requires_tools_probability: number
        }
        usage: { input_tokens: number; output_tokens: number }
      }
    }
    assert.ok(models.some((model) => model.model_id === route.selected_public_model_id))
    assert.ok(models.some((model) => model.model_id === route.decision_receipt.suggested_public_model_id))
    assert.equal(route.decision_receipt.resolved_model, "jev-1.13.0")
    assert.ok(route.decision_receipt.confidence >= 0 && route.decision_receipt.confidence <= 1)
    console.info(JSON.stringify({
      event: "model-routing.typesafe.live",
      selected_public_model_id: route.selected_public_model_id,
      ...route.decision_receipt,
    }))
  } finally {
    await app.close()
  }
})
