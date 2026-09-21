import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import type { RoutableModel } from "../src/capabilities/model-routing/candidates"
import { applySemanticModelDecision } from "../src/capabilities/model-routing/decision-provider"
import { createTypeSafeModelRoutingDecisionProvider } from "../src/capabilities/model-routing/typesafe-decision-provider"

function candidate(id: string, capabilities: RoutableModel["model"]["capabilities"]): RoutableModel {
  return {
    model: {
      tenant_id: "tenant",
      model_id: id,
      model_name: id,
      display_name: id.toUpperCase(),
      resource_id: "resource",
      visibility: "PUBLIC",
      lifecycle: "PUBLISHED",
      capabilities,
      created_at: 1,
    },
    mapping: {
      tenant_id: "tenant",
      mapping_id: `mapping-${id}`,
      public_model_id: id,
      resource_id: "resource",
      connection_id: `connection-${id}`,
      provider_model: `provider-${id}`,
      mapping_revision: 1,
      created_at: 1,
    },
  }
}

function evaluator(confidence: number) {
  return {
    async evaluate() {
      return {
        model: "jev-1.13.0",
        route: {
          choice: "model-b",
          confidence,
          probabilities: { "model-a": 0.1, "model-b": 0.9 },
        },
        task_kind: { choice: "REASONING" as const, confidence: 0.88 },
        complexity: { score: 1.7, confidence: 0.81 },
        requires_tools: { noul: 0.73 },
        usage: { input_tokens: 321, output_tokens: 17 },
      }
    },
  }
}

test("TypeSafe decision provider returns a model-versioned route and task annotations", async () => {
  const provider = createTypeSafeModelRoutingDecisionProvider({
    model: "jev-1.13.0",
    evaluator: evaluator(0.9),
  })
  const result = await provider.decide({
    task: "Investigate a failing deployment and propose a safe repair",
    candidates: [
      {
        public_model_id: "model-a",
        model_name: "model-a",
        display_name: "Model A",
        capabilities: ["CHAT"],
      },
      {
        public_model_id: "model-b",
        model_name: "model-b",
        display_name: "Model B",
        capabilities: ["CHAT", "REASONING", "TOOL_CALLING"],
      },
    ],
  })
  assert.equal(result.resolved_model, "jev-1.13.0")
  assert.equal(result.suggested_public_model_id, "model-b")
  assert.deepEqual(result.annotations, {
    task_kind: "REASONING",
    task_kind_confidence: 0.88,
    complexity_score: 1.7,
    complexity_confidence: 0.81,
    requires_tools_probability: 0.73,
  })
})

test("high-confidence semantic routing reorders only eligible candidates and records the receipt", async () => {
  const provider = createTypeSafeModelRoutingDecisionProvider({
    model: "jev-1.13.0",
    evaluator: evaluator(0.9),
  })
  const result = await applySemanticModelDecision({
    request: { task: "Investigate a failing deployment and propose a safe repair" },
    provider,
    minimumConfidence: 0.6,
    candidates: [candidate("model-a", ["CHAT"]), candidate("model-b", ["CHAT", "REASONING"])],
    decidedAt: 100,
  })
  assert.equal(result.candidates[0]?.model.model_id, "model-b")
  assert.deepEqual(result.receipt, {
    provider_id: "typesafe-system-one",
    requested_model: "jev-1.13.0",
    resolved_model: "jev-1.13.0",
    suggested_public_model_id: "model-b",
    selected_public_model_id: "model-b",
    task_digest: createHash("sha256")
      .update("Investigate a failing deployment and propose a safe repair")
      .digest("hex"),
    applied: true,
    confidence: 0.9,
    probabilities: [
      { public_model_id: "model-a", probability: 0.1 },
      { public_model_id: "model-b", probability: 0.9 },
    ],
    annotations: {
      task_kind: "REASONING",
      task_kind_confidence: 0.88,
      complexity_score: 1.7,
      complexity_confidence: 0.81,
      requires_tools_probability: 0.73,
    },
    usage: { input_tokens: 321, output_tokens: 17 },
    decided_at: 100,
  })
})

test("low-confidence semantic routing preserves policy order while retaining the suggestion", async () => {
  const provider = createTypeSafeModelRoutingDecisionProvider({
    model: "jev-preview",
    evaluator: evaluator(0.4),
  })
  const result = await applySemanticModelDecision({
    request: { task: "Ambiguous request" },
    provider,
    minimumConfidence: 0.6,
    candidates: [candidate("model-a", ["CHAT"]), candidate("model-b", ["CHAT", "REASONING"])],
    decidedAt: 100,
  })
  assert.equal(result.candidates[0]?.model.model_id, "model-a")
  assert.equal(result.receipt?.suggested_public_model_id, "model-b")
  assert.equal(result.receipt?.selected_public_model_id, "model-a")
  assert.equal(result.receipt?.applied, false)
  assert.equal(result.receipt?.requested_model, "jev-preview")
})

test("semantic routing fails closed when the provider selects outside the eligible set", async () => {
  const provider = createTypeSafeModelRoutingDecisionProvider({
    evaluator: {
      async evaluate() {
        return {
          ...await evaluator(0.9).evaluate(),
          route: {
            choice: "model-c",
            confidence: 0.9,
            probabilities: { "model-a": 0.5, "model-b": 0.5 },
          },
        }
      },
    },
  })
  await assert.rejects(
    applySemanticModelDecision({
      request: { task: "Route me" },
      provider,
      minimumConfidence: 0.6,
      candidates: [candidate("model-a", ["CHAT"]), candidate("model-b", ["CHAT"])],
      decidedAt: 100,
    }),
    { code: "MODEL_ROUTING_DECISION_INVALID" },
  )
})
