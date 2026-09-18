import assert from "node:assert/strict"
import { generateKeyPairSync, sign as signPayload } from "node:crypto"
import test from "node:test"

import {
  verifyCompactEdDsaJws,
  type VerificationKeyRing,
} from "../../../../packages/protocol/src/compact-jws"
import {
  validateProcessorPolicyBundle,
  type ProcessorPolicy,
  type ProcessorPolicyBundle,
} from "../../../../runtimes/gateway/services/processor/contract"
import type {
  CompactJwsSigner,
  GatewayPolicyReleaseInput,
} from "../src/capabilities/gateway-policy-release/contract"
import { planGatewayPolicyRelease } from "../src/capabilities/gateway-policy-release/planner"

function signer(keyId: string): CompactJwsSigner & { publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  return {
    algorithm: "EdDSA",
    keyId,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sign(payload) {
      return signPayload(null, Buffer.from(payload), privateKey).toString("base64url")
    },
  }
}

const artifactSigner = signer("artifact-key")
const rootSigner = signer("release-root-key")
const verificationKeyRing: VerificationKeyRing = {
  schema_version: 1,
  // Deliberately unsorted: the planner owns canonical ordering.
  keys: [
    { key_id: "z-unused", public_key_pem: artifactSigner.publicKeyPem },
    { key_id: artifactSigner.keyId, public_key_pem: artifactSigner.publicKeyPem },
  ],
}

const policy = (revision: string, action: ProcessorPolicy["action"]): ProcessorPolicy => ({
  schema_version: 1,
  revision,
  action,
  token_ttl_seconds: 600,
  patterns: [
    {
      name: "EMAIL",
      expression: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
    },
  ],
})

const processStep = (stepId: string, request: ProcessorPolicy, response?: ProcessorPolicy): ProcessorPolicyBundle["scopes"][number]["steps"][number] => ({
  step_id: stepId,
  hooks: {
    request: {
      action: request.action,
      config: { patterns: request.patterns, token_ttl_seconds: request.token_ttl_seconds },
    },
    ...(response
      ? {
          response: {
            action: response.action,
            config: { patterns: response.patterns, token_ttl_seconds: response.token_ttl_seconds },
          },
        }
      : {}),
  },
})

function baseInput(): GatewayPolicyReleaseInput {
  return {
    target: {
      tenant_id: "tenant-acme",
      runtime_id: "gateway-runtime-1",
      gateway_id: "ai-gateway",
    },
    issued_at: 1_800_000_000,
    expires_at: 1_800_000_600,
    // Deliberately reversed to prove the closed set is canonicalized.
    projections: [
      {
        publication_id: "pub-z",
        projection_id: "projection-z",
        revision: 3,
        digest: "b".repeat(64),
      },
      {
        publication_id: "pub-a",
        projection_id: "projection-a",
        revision: 4,
        digest: "a".repeat(64),
      },
    ],
    authorization_bundle: {
      schema_version: 1,
      tenant_id: "tenant-acme",
      revision: "gateway-revision-7",
      policy_version: "policy-7",
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_600,
      revoked_entitlement_ids: ["entitlement-revoked"],
      rules: [],
    },
    processor_policy: {
      schema_version: 1,
      tenant_id: "tenant-acme",
      revision: "gateway-revision-7",
      policy_version: "policy-7",
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_600,
      scopes: [
        {
          resource_id: "resource-z",
          capability_id: "chat",
          steps: [processStep("redact", policy("gateway-revision-7", "REDACT"))],
        },
        {
          resource_id: "resource-a",
          capability_id: "chat",
          steps: [processStep(
            "tokenize",
            policy("gateway-revision-7", "TOKENIZE"),
            policy("gateway-revision-7", "RESTORE"),
          )],
        },
      ],
    },
    gateway_routing_artifact: {
      schema_version: "genio.one.gateway-routing.v1",
      tenant_id: "tenant-acme",
      gateway_id: "ai-gateway",
      revision: "gateway-revision-7",
      policy_version: "policy-7",
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_600,
      scopes: [],
    },
    enforcement_verification_keys: verificationKeyRing,
    artifact_signer: artifactSigner,
    release_root_signer: rootSigner,
  }
}

function decodeJwsPayload(bytes: Uint8Array): unknown {
  const [, encodedPayload] = Buffer.from(bytes).toString("utf8").split(".")
  return JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as unknown
}

test("plans one deterministic Gateway release with a sorted closed projection set", async () => {
  const first = await planGatewayPolicyRelease(baseInput())
  const second = await planGatewayPolicyRelease(baseInput())

  assert.equal(first.release_id, second.release_id)
  assert.equal(first.release_directory, `releases/${first.release_id}`)
  assert.deepEqual(first.manifest.gateway_projections.map((item) => item.publication_id), [
    "pub-a",
    "pub-z",
  ])
  assert.deepEqual(first.manifest.gateway_projections.map((item) => item.projection_id), [
    "projection-a",
    "projection-z",
  ])
  assert.deepEqual(first.manifest.enforcement_verification_keys.key_ids, [
    "artifact-key",
    "z-unused",
  ])
  assert.deepEqual(first.authorization_bundle.bytes, second.authorization_bundle.bytes)
  assert.deepEqual(
    (decodeJwsPayload(first.authorization_bundle.bytes) as { revoked_entitlement_ids: string[] }).revoked_entitlement_ids,
    ["entitlement-revoked"],
  )
  assert.deepEqual(first.processor_policy.bytes, second.processor_policy.bytes)
  assert.deepEqual(first.manifest_jws.bytes, second.manifest_jws.bytes)
  assert.equal(first.manifest.authorization_bundle.sha256, first.authorization_bundle.sha256)
  assert.equal(first.manifest.processor_policy.sha256, first.processor_policy.sha256)
  assert.equal(
    first.manifest.enforcement_verification_keys.sha256,
    first.enforcement_verification_keys.sha256,
  )

  const rootKeyRing: VerificationKeyRing = {
    schema_version: 1,
    keys: [{ key_id: rootSigner.keyId, public_key_pem: rootSigner.publicKeyPem }],
  }
  assert.deepEqual(
    verifyCompactEdDsaJws(Buffer.from(first.manifest_jws.bytes).toString("utf8"), rootKeyRing),
    first.manifest,
  )
  assert.deepEqual(
    verifyCompactEdDsaJws(
      Buffer.from(first.authorization_bundle.bytes).toString("utf8"),
      verificationKeyRing,
    ),
    baseInput().authorization_bundle,
  )
  assert.deepEqual(
    validateProcessorPolicyBundle(
      verifyCompactEdDsaJws(
        Buffer.from(first.processor_policy.bytes).toString("utf8"),
        verificationKeyRing,
      ),
    ).scopes.map((scope) => `${scope.resource_id}/${scope.capability_id}`),
    ["resource-a/chat", "resource-z/chat"],
  )
  const decodedProcessor = decodeJwsPayload(first.processor_policy.bytes) as ProcessorPolicyBundle
  assert.deepEqual(decodedProcessor.scopes.map((scope) => scope.resource_id), [
    "resource-a",
    "resource-z",
  ])
})

test("release identity is runtime-independent while the signed manifest binds its target", async () => {
  const first = await planGatewayPolicyRelease(baseInput())
  const alternate = await planGatewayPolicyRelease({
    ...baseInput(),
    target: {
      tenant_id: "tenant-acme",
      runtime_id: "gateway-runtime-2",
      gateway_id: "ai-gateway",
    },
  })
  assert.equal(first.release_id, alternate.release_id)
  assert.notDeepEqual(first.manifest_jws.bytes, alternate.manifest_jws.bytes)
  assert.equal(alternate.manifest.runtime_id, "gateway-runtime-2")
  assert.equal(alternate.manifest.gateway_id, "ai-gateway")

  const differentGateway = await planGatewayPolicyRelease({
    ...baseInput(),
    target: {
      tenant_id: "tenant-acme",
      runtime_id: "gateway-runtime-1",
      gateway_id: "api-gateway",
    },
    gateway_routing_artifact: {
      ...baseInput().gateway_routing_artifact,
      gateway_id: "api-gateway",
    },
  })
  assert.notEqual(first.release_id, differentGateway.release_id)
})

test("Gateway diagnostic capture changes the signed release identity", async () => {
  const disabled = await planGatewayPolicyRelease(baseInput())
  const enabled = await planGatewayPolicyRelease({
    ...baseInput(),
    gateway_configuration: { capture_message_content: true },
  })

  assert.deepEqual(disabled.manifest.gateway_configuration, {
    capture_message_content: false,
  })
  assert.deepEqual(enabled.manifest.gateway_configuration, {
    capture_message_content: true,
  })
  assert.notEqual(disabled.release_id, enabled.release_id)
})

test("supports an empty gateway projection set for a retiring release", async () => {
  const plan = await planGatewayPolicyRelease({ ...baseInput(), projections: [] })
  assert.deepEqual(plan.manifest.gateway_projections, [])
})

test("supports an empty processor scope set and scoped built-in configs", async () => {
  const empty = await planGatewayPolicyRelease({
    ...baseInput(),
    processor_policy: { ...baseInput().processor_policy, scopes: [] },
  })
  assert.deepEqual(
    validateProcessorPolicyBundle(decodeJwsPayload(empty.processor_policy.bytes)).scopes,
    [],
  )

  const scopeRevisionInput = baseInput()
  scopeRevisionInput.processor_policy = {
    ...scopeRevisionInput.processor_policy,
    scopes: scopeRevisionInput.processor_policy.scopes.map((scope) => ({
      ...scope,
      steps: scope.steps.map((step) => ({ ...step })),
    })),
  }
  await assert.doesNotReject(planGatewayPolicyRelease(scopeRevisionInput))
})

test("does not reject equal projection digests when publication and projection IDs differ", async () => {
  await assert.doesNotReject(
    planGatewayPolicyRelease({
      ...baseInput(),
      projections: baseInput().projections.map((projection) => ({
        ...projection,
        digest: "a".repeat(64),
      })),
    }),
  )
})

test("rejects processor releases that the target runtime cannot execute", async () => {
  const withSteps = (
    steps: ProcessorPolicyBundle["scopes"][number]["steps"],
  ): GatewayPolicyReleaseInput => {
    const value = baseInput()
    return {
      ...value,
      processor_policy: {
        ...value.processor_policy,
        scopes: [{ resource_id: "resource-a", capability_id: "chat", steps }],
      },
    }
  }

  await assert.rejects(
    planGatewayPolicyRelease(withSteps([
      { step_id: "token-vault", hooks: { request: { action: "TOKENIZE" } } },
    ])),
    /reversible tokenization must use request TOKENIZE and response RESTORE/,
  )
  await assert.rejects(
    planGatewayPolicyRelease(withSteps([
      { step_id: "restore-request", hooks: { request: { action: "RESTORE" } } },
    ])),
    /RESTORE is only valid on a processor response hook/,
  )
  await assert.rejects(
    planGatewayPolicyRelease(withSteps([
      { step_id: "tokenize-response", hooks: { response: { action: "TOKENIZE" } } },
    ])),
    /TOKENIZE is only valid on a processor request hook/,
  )
  await assert.rejects(
    planGatewayPolicyRelease(withSteps([
      {
        step_id: "redact",
        hooks: {
          request: {
            action: "REDACT",
            config: { patterns: [], token_ttl_seconds: 600, unexpected: true },
          },
        },
      },
    ])),
    /processor hook config is invalid/,
  )
})

test("rejects duplicate publication, projection, key, and mismatched targets", async () => {
  await assert.rejects(
    planGatewayPolicyRelease({
      ...baseInput(),
      projections: [baseInput().projections[0]!, baseInput().projections[0]!],
    }),
    /duplicate publication_id|duplicate projection_id/,
  )
  await assert.rejects(
    planGatewayPolicyRelease({
      ...baseInput(),
      enforcement_verification_keys: {
        schema_version: 1,
        keys: [...verificationKeyRing.keys, verificationKeyRing.keys[1]!],
      },
    }),
    /duplicate key ids/,
  )
  await assert.rejects(
    planGatewayPolicyRelease({
      ...baseInput(),
      target: { ...baseInput().target, tenant_id: "tenant-other" },
    }),
    /authorization bundle tenant does not match release target/,
  )
  await assert.rejects(
    planGatewayPolicyRelease({
      ...baseInput(),
      processor_policy: { ...baseInput().processor_policy, revision: "processor-other" },
    }),
    /policy artifact revisions do not match release|processor scope revision/,
  )
})

test("rejects control characters in release identifiers", async () => {
  await assert.rejects(
    planGatewayPolicyRelease({
      ...baseInput(),
      target: { ...baseInput().target, runtime_id: "gateway-runtime-1\nnext" },
    }),
    /release runtime_id must be a non-empty identifier/,
  )
})
