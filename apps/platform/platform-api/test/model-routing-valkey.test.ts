import assert from "node:assert/strict"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import type { ConnectionModelMapping, PublicModel } from "../src/capabilities/models/contract"
import type { PublicModelCatalog } from "../src/capabilities/models/module"
import {
  createValkeyModelRouter,
  valkeyModelRouteLeaseKey,
  type ValkeySessionLeaseClient,
} from "../src/capabilities/model-routing/valkey"
import type { ModelRoutingDecisionProvider } from "../src/capabilities/model-routing/decision-provider"

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
      throw new Error("not used in Valkey model-routing tests")
    },
    async addMapping() {
      throw new Error("not used in Valkey model-routing tests")
    },
  }
}

class FakeValkey implements ValkeySessionLeaseClient {
  readonly values = new Map<string, string>()
  readonly setCalls: Array<{
    key: string
    value: string
    options: { NX: true; EX: number }
  }> = []
  failReads = false
  failWrites = false

  async get(key: string): Promise<string | null> {
    if (this.failReads) throw new Error("valkey unavailable")
    return this.values.get(key) ?? null
  }

  async set(
    key: string,
    value: string,
    options: { NX: true; EX: number },
  ): Promise<"OK" | null> {
    if (this.failWrites) throw new Error("valkey unavailable")
    this.setCalls.push({ key, value, options })
    if (this.values.has(key)) return null
    this.values.set(key, value)
    return "OK"
  }
}

function baseInput() {
  return {
    subject_id: "subject-1",
    client_id: "client-1",
    public_model_id: "public-chat",
    session_id: "session-1",
    entitled_public_model_ids: ["model-a", "model-b"],
  }
}

function router(client: FakeValkey, now = 100, decisionProvider?: ModelRoutingDecisionProvider) {
  return createValkeyModelRouter({
    client,
    models: modelCatalog([publicModel("model-a"), publicModel("model-b")]),
    now: () => now,
    idFactory: () => "lease-fixed",
    decisionProvider,
    decisionMinimumConfidence: 0.6,
  })
}

test("Valkey stores and reuses the semantic decision receipt without re-evaluating", async () => {
  const client = new FakeValkey()
  let calls = 0
  const modelRouter = router(client, 100, {
    provider_id: "test-system-one",
    requested_model: "decision-v1",
    async decide() {
      calls += 1
      return {
        resolved_model: "decision-v1",
        suggested_public_model_id: "model-b",
        confidence: 0.9,
        probabilities: { "model-a": 0.1, "model-b": 0.9 },
        annotations: {
          task_kind: "TOOL_USE",
          task_kind_confidence: 0.93,
          complexity_score: 1.4,
          complexity_confidence: 0.8,
          requires_tools_probability: 0.98,
        },
        usage: { input_tokens: 180, output_tokens: 16 },
      }
    },
  })
  const value = {
    ...baseInput(),
    semantic_routing: { task: "Use the browser to inspect a deployed application" },
  }
  const first = await modelRouter.resolve({ tenantId, value })
  const reused = await modelRouter.resolve({ tenantId, value })
  assert.equal(first.selected_public_model_id, "model-b")
  assert.equal(first.decision_receipt?.annotations.task_kind, "TOOL_USE")
  assert.deepEqual(reused.decision_receipt, first.decision_receipt)
  assert.equal(reused.reused, true)
  assert.equal(calls, 1)
})

test("stateless resolution is deterministic and never touches Valkey", async () => {
  const client = new FakeValkey()
  client.failReads = true
  client.failWrites = true
  const modelRouter = router(client)

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
  assert.equal(client.setCalls.length, 0)
})

test("session route uses the complete tuple key and atomic NX/EX lease", async () => {
  const client = new FakeValkey()
  const modelRouter = router(client)
  const first = await modelRouter.resolve({ tenantId, value: baseInput() })
  const reused = await modelRouter.resolve({
    tenantId,
    value: { ...baseInput(), requested_public_model_id: first.selected_public_model_id },
  })

  const expectedKey = valkeyModelRouteLeaseKey({
    tenantId,
    subjectId: "subject-1",
    clientId: "client-1",
    publicModelId: "public-chat",
    sessionId: "session-1",
  })
  assert.equal(first.route_mode, "SESSION_LEASE")
  assert.equal(first.lease_id, "lease-fixed")
  assert.equal(first.expires_at, 3_700)
  assert.equal(reused.lease_id, first.lease_id)
  assert.equal(reused.reused, true)
  assert.equal(client.setCalls.length, 1)
  assert.equal(client.setCalls[0]?.key, expectedKey)
  assert.deepEqual(client.setCalls[0]?.options, { NX: true, EX: 3_600 })
})

test("concurrent session resolution returns only the atomically stored winner", async () => {
  const client = new FakeValkey()
  let sequence = 0
  const modelRouter = createValkeyModelRouter({
    client,
    models: modelCatalog([publicModel("model-a"), publicModel("model-b")]),
    now: () => 100,
    idFactory: () => `lease-${++sequence}`,
  })

  const results = await Promise.all([
    modelRouter.resolve({ tenantId, value: baseInput() }),
    modelRouter.resolve({ tenantId, value: baseInput() }),
  ])

  assert.equal(client.setCalls.length, 2)
  assert.equal(new Set(results.map((result) => result.lease_id)).size, 1)
  assert.equal(results.filter((result) => result.reused).length, 1)
  assert.equal(results[0]?.lease_id, results[1]?.lease_id)
})

test("an existing lease must remain entitled and cannot switch requested model", async () => {
  const client = new FakeValkey()
  const modelRouter = router(client)
  const first = await modelRouter.resolve({ tenantId, value: baseInput() })

  await assert.rejects(
    modelRouter.resolve({
      tenantId,
      value: { ...baseInput(), entitled_public_model_ids: ["model-b"] },
    }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "SESSION_MODEL_ROUTE_CONFLICT" &&
      error.statusCode === 409,
  )

  await assert.rejects(
    modelRouter.resolve({
      tenantId,
      value: { ...baseInput(), requested_public_model_id: "model-b" },
    }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "SESSION_MODEL_LEASE_EXISTS" &&
      error.statusCode === 409,
  )

  assert.equal(first.selected_public_model_id, "model-a")
  assert.equal(client.setCalls.length, 1)
})

test("Valkey outages and malformed stored leases fail closed", async () => {
  const unavailableClient = new FakeValkey()
  unavailableClient.failReads = true
  await assert.rejects(
    router(unavailableClient).resolve({ tenantId, value: baseInput() }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "MODEL_ROUTE_LEASE_UNAVAILABLE" &&
      error.statusCode === 503,
  )

  const malformedClient = new FakeValkey()
  const key = valkeyModelRouteLeaseKey({
    tenantId,
    subjectId: "subject-1",
    clientId: "client-1",
    publicModelId: "public-chat",
    sessionId: "session-1",
  })
  malformedClient.values.set(key, "not-json")
  await assert.rejects(
    router(malformedClient).resolve({ tenantId, value: baseInput() }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "MODEL_ROUTE_LEASE_UNAVAILABLE" &&
      error.statusCode === 503,
  )
})

test("classifier can only filter or order the entitled candidate set", async () => {
  const client = new FakeValkey()
  const modelRouter = router(client)

  const filtered = await modelRouter.resolve({
    tenantId,
    value: {
      ...baseInput(),
      session_id: "session-filter",
      classifier_result: { mode: "FILTER", public_model_ids: ["model-b"] },
    },
  })
  assert.equal(filtered.selected_public_model_id, "model-b")

  await assert.rejects(
    modelRouter.resolve({
      tenantId,
      value: {
        ...baseInput(),
        session_id: "session-invalid",
        classifier_result: { mode: "FILTER", public_model_ids: ["model-not-entitled"] },
      },
    }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "CLASSIFIER_CANDIDATE_NOT_ENTITLED",
  )
})
