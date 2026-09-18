import assert from "node:assert/strict"
import test from "node:test"

import { Check } from "typebox/value"

import {
  GatewayRoutingArtifactSchema,
  GatewayRoutingArtifactValidationError,
  gatewayRoutingCandidateSetDigest,
  isGatewayRoutingArtifact,
  validateGatewayRoutingArtifact,
  type GatewayRoutingArtifact,
  type GatewayRoutingPublicModelCandidate,
} from "./gateway-routing-artifact"

function candidates(): GatewayRoutingPublicModelCandidate[] {
  return [
    {
      order: 1,
      public_model_id: "pm_01",
      public_model_name: "genio-standard",
      mappings: [
        {
          order: 1,
          mapping_id: "mapping-openai",
          resource_id: "resource-chat",
          connection_id: "connection-openai",
          provider_model: "gpt-4.1",
          mapping_revision: 3,
        },
      ],
    },
    {
      order: 2,
      public_model_id: "pm_02",
      public_model_name: "genio-reasoning",
      mappings: [
        {
          order: 1,
          mapping_id: "mapping-ollama",
          resource_id: "resource-chat",
          connection_id: "connection-ollama",
          provider_model: "qwen3:8b",
          mapping_revision: 2,
        },
      ],
    },
  ]
}

function artifact(): GatewayRoutingArtifact {
  const routeCandidates = candidates()
  return {
    schema_version: "genio.one.gateway-routing.v1",
    tenant_id: "tenant-acme",
    gateway_id: "gateway-ai-primary",
    revision: "gateway-revision-11",
    policy_version: "policy-v9",
    issued_at: 100,
    expires_at: 1_000,
    scopes: [
      {
        owner_organization_id: "org-acme",
        resource_id: "resource-chat",
        capability_id: "capability-chat",
        routing_policy_id: "routing-chat",
        routing_revision: 4,
        one_policy_revision: 9,
        route_mode: "SESSION_LEASE",
        default_public_model_id: "pm_01",
        candidate_set_digest: gatewayRoutingCandidateSetDigest(routeCandidates),
        session_lease: {
          ttl_seconds: 900,
          key_scope: "TENANT_SUBJECT_CLIENT_RESOURCE_CAPABILITY_SESSION",
        },
        candidates: routeCandidates,
      },
    ],
  }
}

test("routing artifact keeps public ID, public alias, and provider model distinct", () => {
  const value = validateGatewayRoutingArtifact(artifact())
  const candidate = value.scopes[0]!.candidates[0]!
  assert.equal(candidate.public_model_id, "pm_01")
  assert.equal(candidate.public_model_name, "genio-standard")
  assert.equal(candidate.mappings[0]!.provider_model, "gpt-4.1")
  assert.equal(Check(GatewayRoutingArtifactSchema, value), true)
})

test("tenant partition and per-scope owner Organization are both required", () => {
  const value = artifact() as unknown as Record<string, unknown>
  delete value.tenant_id
  assert.equal(isGatewayRoutingArtifact(value), false)

  const missingOwner = structuredClone(artifact()) as unknown as {
    scopes: Array<Record<string, unknown>>
  }
  delete missingOwner.scopes[0]!.owner_organization_id
  assert.equal(isGatewayRoutingArtifact(missingOwner), false)
})

test("candidate and mapping order is explicit, contiguous, and digest-bound", () => {
  const candidateGap = artifact()
  candidateGap.scopes[0]!.candidates[1]!.order = 3
  assert.throws(
    () => validateGatewayRoutingArtifact(candidateGap),
    (error: unknown) =>
      error instanceof GatewayRoutingArtifactValidationError &&
      error.code === "INVALID_SEMANTICS",
  )

  const changedMapping = artifact()
  changedMapping.scopes[0]!.candidates[0]!.mappings[0]!.mapping_revision += 1
  assert.throws(
    () => validateGatewayRoutingArtifact(changedMapping),
    (error: unknown) =>
      error instanceof GatewayRoutingArtifactValidationError &&
      error.code === "CANDIDATE_SET_DIGEST_MISMATCH",
  )
})

test("session settings and route mode cannot disagree", () => {
  const deterministic = artifact()
  deterministic.scopes[0]!.route_mode = "DETERMINISTIC"
  assert.throws(
    () => validateGatewayRoutingArtifact(deterministic),
    (error: unknown) =>
      error instanceof GatewayRoutingArtifactValidationError &&
      error.code === "INVALID_SEMANTICS",
  )
})

test("unknown fields, credentials, and duplicate route identities fail closed", () => {
  const secret = artifact() as unknown as Record<string, unknown>
  secret.credentials = { api_key: "secret" }
  assert.equal(Check(GatewayRoutingArtifactSchema, secret), false)

  const duplicate = artifact()
  duplicate.scopes.push(structuredClone(duplicate.scopes[0]!))
  assert.throws(
    () => validateGatewayRoutingArtifact(duplicate),
    (error: unknown) =>
      error instanceof GatewayRoutingArtifactValidationError &&
      error.code === "INVALID_SEMANTICS",
  )
})

test("artifact payload has no circular release ID or duplicate signature envelope", () => {
  const value = artifact() as unknown as Record<string, unknown>
  assert.equal("release_id" in value, false)
  assert.equal("digest" in value, false)
  assert.equal("signature" in value, false)
})
