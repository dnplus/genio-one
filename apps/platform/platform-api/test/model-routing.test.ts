import assert from "node:assert/strict"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import type { ConnectionModelMapping, PublicModel } from "../src/capabilities/models/contract"
import type { PublicModelCatalog } from "../src/capabilities/models/module"
import { createModelMemoryState } from "../src/capabilities/models/state"
import { createInMemoryModelRouter } from "../src/capabilities/model-routing/memory"
import type { ModelRoutingDecisionProvider } from "../src/capabilities/model-routing/decision-provider"
import { createInMemoryProviderProfileCatalog } from "../src/capabilities/providers/memory"

const tenantId = "tenant-acme"

function publicModel(modelId: string): PublicModel {
  return {
    tenant_id: tenantId,
    model_id: modelId,
    model_name: modelId,
    display_name: modelId,
    resource_id: `${modelId}-resource`,
    visibility: "PUBLIC",
    lifecycle: "PUBLISHED",
    capabilities: ["CHAT"],
    created_at: 1,
  }
}

function modelCatalog(models: PublicModel[]): PublicModelCatalog {
  const mappings: ConnectionModelMapping[] = models.map((model) => ({
    tenant_id: tenantId,
    mapping_id: `${model.model_id}-mapping`,
    public_model_id: model.model_id,
    resource_id: model.resource_id,
    connection_id: `${model.model_id}-connection`,
    provider_model: `${model.model_id}-provider`,
    mapping_revision: 1,
    created_at: 1,
  }))
  return {
    async list(input) {
      return models.filter((model) => model.tenant_id === input.tenantId)
    },
    async get(input) {
      const model = models.find(
        (candidate) =>
          candidate.tenant_id === input.tenantId && candidate.model_id === input.modelId,
      )
      if (!model) throw new PlatformApiError("MODEL_NOT_FOUND", 404)
      return model
    },
    async listMappings(input) {
      return mappings.filter(
        (mapping) =>
          mapping.tenant_id === input.tenantId &&
          (input.resourceId === undefined || mapping.resource_id === input.resourceId) &&
          (input.publicModelId === undefined || mapping.public_model_id === input.publicModelId),
      )
    },
    async create() {
      throw new Error("not used in model-routing tests")
    },
    async addMapping() {
      throw new Error("not used in model-routing tests")
    },
  }
}

function router(decisionProvider?: ModelRoutingDecisionProvider) {
  const state = createModelMemoryState()
  const modelRouter = createInMemoryModelRouter({
    state,
    models: modelCatalog([publicModel("model-a"), publicModel("model-b")]),
    decisionProvider,
    decisionMinimumConfidence: 0.6,
  })
  return { state, modelRouter }
}

test("semantic routing creates one sticky model and annotation receipt without widening entitlement", async () => {
  let calls = 0
  const { modelRouter } = router({
    provider_id: "test-system-one",
    requested_model: "decision-v1",
    async decide() {
      calls += 1
      return {
        resolved_model: "decision-v1.2",
        suggested_public_model_id: "model-b",
        confidence: 0.92,
        probabilities: { "model-a": 0.08, "model-b": 0.92 },
        annotations: {
          task_kind: "REASONING",
          task_kind_confidence: 0.9,
          complexity_score: 1.8,
          complexity_confidence: 0.84,
          requires_tools_probability: 0.71,
        },
        usage: { input_tokens: 200, output_tokens: 20 },
      }
    },
  })
  const value = {
    subject_id: "subject-1",
    client_id: "client-1",
    public_model_id: "public-chat",
    session_id: "semantic-session",
    entitled_public_model_ids: ["model-a", "model-b"],
    semantic_routing: { task: "Investigate a failed deployment" },
  }
  const first = await modelRouter.resolve({ tenantId, value })
  const reused = await modelRouter.resolve({
    tenantId,
    value: { ...value, semantic_routing: { task: "A changed prompt cannot reroute the session" } },
  })
  assert.equal(first.selected_public_model_id, "model-b")
  assert.equal(first.decision_receipt?.provider_id, "test-system-one")
  assert.equal(first.decision_receipt?.resolved_model, "decision-v1.2")
  assert.equal(first.decision_receipt?.annotations.task_kind, "REASONING")
  assert.equal(reused.selected_public_model_id, "model-b")
  assert.equal(reused.reused, true)
  assert.deepEqual(reused.decision_receipt, first.decision_receipt)
  assert.equal(calls, 1)
})

test("semantic routing requires a configured provider and unambiguous input", async () => {
  const { modelRouter } = router()
  const value = {
    subject_id: "subject-1",
    client_id: "client-1",
    public_model_id: "public-chat",
    session_id: "semantic-session",
    entitled_public_model_ids: ["model-a", "model-b"],
    semantic_routing: { task: "Route this task" },
  }
  await assert.rejects(
    modelRouter.resolve({ tenantId, value }),
    { code: "MODEL_ROUTING_DECISION_UNAVAILABLE" },
  )
  await assert.rejects(
    modelRouter.resolve({
      tenantId,
      value: {
        ...value,
        classifier_result: { mode: "ORDER" as const, public_model_ids: ["model-b"] },
      },
    }),
    { code: "SEMANTIC_ROUTING_INPUT_CONFLICT" },
  )
  await assert.rejects(
    modelRouter.resolve({
      tenantId,
      value: { ...value, requested_public_model_id: "model-a" },
    }),
    { code: "SEMANTIC_ROUTING_INPUT_CONFLICT" },
  )
})

test("stateless model resolution is deterministic and does not create a lease", async () => {
  const { state, modelRouter } = router()

  const result = await modelRouter.resolve({
    tenantId,
    value: {
      subject_id: "subject-1",
      client_id: "client-1",
      public_model_id: "public-chat",
      entitled_public_model_ids: ["model-b", "model-a"],
    },
  })

  assert.equal(result.selected_public_model_id, "model-a")
  assert.equal(result.route_mode, "DETERMINISTIC")
  assert.equal(result.lease_id, undefined)
  assert.equal(result.session_id, undefined)
  assert.equal(result.expires_at, undefined)
  assert.equal(state.leases.size, 0)
})

test("session leases are scoped by tenant, subject, client, public model, and session", async () => {
  const { state, modelRouter } = router()
  const base = {
    subject_id: "subject-1",
    client_id: "client-1",
    public_model_id: "public-chat",
    session_id: "session-1",
    entitled_public_model_ids: ["model-a", "model-b"],
  }

  const first = await modelRouter.resolve({ tenantId, value: base })
  const reused = await modelRouter.resolve({
    tenantId,
    value: { ...base, requested_public_model_id: first.selected_public_model_id },
  })
  assert.equal(first.route_mode, "SESSION_LEASE")
  assert.equal(reused.lease_id, first.lease_id)
  assert.equal(reused.reused, true)

  const differentSubject = await modelRouter.resolve({
    tenantId,
    value: { ...base, subject_id: "subject-2" },
  })
  const differentClient = await modelRouter.resolve({
    tenantId,
    value: { ...base, client_id: "client-2" },
  })
  const differentPublicModel = await modelRouter.resolve({
    tenantId,
    value: { ...base, public_model_id: "public-reasoning" },
  })

  assert.equal(differentSubject.reused, false)
  assert.equal(differentClient.reused, false)
  assert.equal(differentPublicModel.reused, false)
  assert.equal(state.leases.size, 4)
  assert.equal(new Set([
    first.lease_id,
    differentSubject.lease_id,
    differentClient.lease_id,
    differentPublicModel.lease_id,
  ]).size, 4)
})

test("classifier can filter or order only entitled candidates", async () => {
  const { modelRouter } = router()

  await assert.rejects(
    modelRouter.resolve({
      tenantId,
      value: {
        subject_id: "subject-1",
        client_id: "client-1",
        public_model_id: "public-chat",
        entitled_public_model_ids: ["model-a", "model-b"],
        classifier_result: { mode: "FILTER", public_model_ids: ["model-b"] },
      },
    }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "SEMANTIC_ROUTING_REQUIRES_SESSION",
  )

  const sessionScope = {
    subject_id: "subject-1",
    client_id: "client-1",
    public_model_id: "public-chat",
  }

  const filtered = await modelRouter.resolve({
    tenantId,
    value: {
      ...sessionScope,
      session_id: "session-filter",
      entitled_public_model_ids: ["model-a", "model-b"],
      classifier_result: { mode: "FILTER", public_model_ids: ["model-b"] },
    },
  })
  assert.equal(filtered.selected_public_model_id, "model-b")

  const ordered = await modelRouter.resolve({
    tenantId,
    value: {
      ...sessionScope,
      session_id: "session-order",
      entitled_public_model_ids: ["model-a", "model-b"],
      classifier_result: { mode: "ORDER", public_model_ids: ["model-b"] },
    },
  })
  assert.equal(ordered.selected_public_model_id, "model-b")

  await assert.rejects(
    modelRouter.resolve({
      tenantId,
      value: {
        ...sessionScope,
        session_id: "session-invalid",
        entitled_public_model_ids: ["model-a", "model-b"],
        classifier_result: { mode: "FILTER", public_model_ids: ["model-not-entitled"] },
      },
    }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "CLASSIFIER_CANDIDATE_NOT_ENTITLED" &&
      error.statusCode === 403,
  )
})

test("built-in Ollama uses the OpenAI-compatible management protocol", async () => {
  const catalog = createInMemoryProviderProfileCatalog()
  const profiles = await catalog.list({ tenantId })
  const ollama = profiles.find((profile) => profile.provider_type === "OLLAMA")
  const omlx = profiles.find((profile) => profile.provider_type === "OMLX")

  assert.equal(ollama?.protocol, "OPENAI_COMPATIBLE")
  assert.equal(omlx?.protocol, "OPENAI_COMPATIBLE")
  assert.equal(ollama?.model_discovery, "PROVIDER_API")
  assert.equal(omlx?.model_discovery, "MANUAL")

  await assert.rejects(
    catalog.create({
      tenantId,
      value: {
        display_name: "Invalid OpenAI native profile",
        provider_type: "OPENAI",
        protocol: "OLLAMA_NATIVE",
      },
    }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "PROVIDER_PROTOCOL_NOT_SUPPORTED",
  )
})
