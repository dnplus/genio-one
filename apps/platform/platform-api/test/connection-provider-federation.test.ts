import assert from "node:assert/strict"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import { canonicalizeConnectionRegistrationInput } from "../src/capabilities/connections/registration"
import type { ConnectionRegistration } from "../src/capabilities/connections/contract"
import { createInMemoryProviderProfileCatalog } from "../src/capabilities/providers/memory"
import { createInMemoryProviderCredentialProfileStore } from "../src/capabilities/provider-credentials/memory"
import { createHttpConnectionVerifier } from "../src/local-slice-verifiers"

const providerCredentialProfileIdentity = {
  mode: "SERVICE" as const,
  authentication: "PROVIDER_CREDENTIAL_PROFILE" as const,
}

test("Provider Credential Profile is the generic outbound identity authority", () => {
  const result = canonicalizeConnectionRegistrationInput({
    display_name: "Vertex production",
    connection_kind: "LLM",
    provider_type: "GCP_VERTEX_AI",
    provider_profile_id: "provider-gcp-vertex-ai",
    endpoint: "https://us-central1-aiplatform.googleapis.com/v1",
    provider_credential_profile: {
      profile_id: "provider-credential-vertex",
      revision: 3,
    },
  })
  assert.deepEqual(result.downstreamIdentity, providerCredentialProfileIdentity)
  assert.throws(
    () => canonicalizeConnectionRegistrationInput({
      display_name: "Conflicting Vertex identity",
      connection_kind: "LLM",
      provider_type: "GCP_VERTEX_AI",
      provider_profile_id: "provider-gcp-vertex-ai",
      endpoint: "https://us-central1-aiplatform.googleapis.com/v1",
      provider_credential_profile: {
        profile_id: "provider-credential-vertex",
        revision: 3,
      },
      downstream_identity: {
        mode: "SERVICE",
        authentication: "GCP_WORKLOAD_IDENTITY",
      },
    } as never),
    (error: unknown) => error instanceof PlatformApiError && error.code === "MCP_IDENTITY_CONFIGURATION_INVALID",
  )
  assert.throws(
    () => canonicalizeConnectionRegistrationInput({
      display_name: "Missing profile",
      connection_kind: "LLM",
      provider_type: "OPENAI",
      endpoint: "https://api.openai.com/v1",
      downstream_identity: providerCredentialProfileIdentity,
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "PROVIDER_CREDENTIAL_PROFILE_BINDING_REQUIRED",
  )
})

test("Google Vertex AI is a built-in provider profile with native protocol", async () => {
  const profiles = await createInMemoryProviderProfileCatalog().list({ tenantId: "tenant-acme" })
  const profile = profiles.find((candidate) => candidate.profile_id === "provider-gcp-vertex-ai")
  assert.deepEqual(profile, {
    tenant_id: "tenant-acme",
    profile_id: "provider-gcp-vertex-ai",
    display_name: "Google Vertex AI",
    provider_type: "GCP_VERTEX_AI",
    protocol: "GCP_VERTEX_AI",
    capabilities: ["CHAT", "STREAMING", "TOOL_CALLING", "VISION", "REASONING", "EMBEDDINGS"],
    model_discovery: "PROVIDER_API",
    endpoint_required: true,
    credential_required: true,
    built_in: true,
  })
})

test("GCP Vertex profile verification binds the endpoint hostname to the Connection region", async () => {
  const verifier = createHttpConnectionVerifier({ allowedHosts: ["localhost"] })
  const connection = {
    tenant_id: "tenant-acme",
    connection_id: "connection-gcp-adc",
    resource_id: "resource-ai",
    display_name: "Vertex ADC",
    connection_kind: "LLM",
    provider_type: "GCP_VERTEX_AI",
    provider_profile_id: "provider-gcp-vertex-ai",
    endpoint: "https://us-central1-aiplatform.googleapis.com/v1",
    provider_credential_profile: {
      profile_id: "provider-credential-gcp-adc",
      revision: 1,
      strategy_digest: "a".repeat(64),
    },
    downstream_identity: providerCredentialProfileIdentity,
    request_mapping: null,
    mcp_tool_namespace: null,
    mcp_selected_tools: [],
    mcp_tool_selection_operation_id: null,
    status: "DRAFT",
    configuration_revision: 1,
    lifecycle: "DRAFT",
    verification_state: "UNVERIFIED",
    health_state: "UNKNOWN",
    health_observed_at: null,
    health_source_revision: null,
    routing_priority: 0,
    region: "us-central1",
    supported_obligations: [],
    created_at: 1,
  } satisfies ConnectionRegistration
  assert.equal(await verifier.verify({ connection }), true)
  assert.equal(await verifier.verify({ connection: { ...connection, region: null }, providerCredentialProfile: { strategy: { kind: "RUNTIME_IDENTITY", adapter: "GCP_APPLICATION_DEFAULT", parameters: { project_name: "project", region: "us-central1" } } } as any }), true)
  assert.equal(await verifier.verify({ connection: { ...connection, endpoint: "https://europe-west1-aiplatform.googleapis.com/v1" } }), false)
})

test("Generic OpenAI-compatible verification uses the bound static Gemini key", async () => {
  const profiles = createInMemoryProviderCredentialProfileStore({ now: () => 1_000 })
  const profile = await profiles.create({
    tenantId: "tenant-acme",
    createdBySubjectId: "person-admin",
    value: {
      profile_id: "provider-credential-gemini-primary",
      owner_organization_id: "organization-ai-platform",
      display_name: "Gemini API key (primary)",
      strategy: {
        kind: "STATIC_SECRET_REFERENCE",
        secret_ref: "gemini-api-key-primary",
      },
    },
  })
  const requests: Request[] = []
  const verifier = createHttpConnectionVerifier({
    allowedHosts: ["generativelanguage.googleapis.com"],
    credentials: { "gemini-api-key-primary": "test-only-secret" },
    fetcher: async (input, init) => {
      requests.push(new Request(input, init))
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  const connection = {
    tenant_id: "tenant-acme",
    connection_id: "connection-gemini-primary",
    resource_id: "resource-ai",
    display_name: "Gemini API key primary",
    connection_kind: "LLM",
    provider_type: "GENERIC_OPENAI_COMPATIBLE",
    provider_profile_id: "provider-generic-openai-compatible",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    provider_credential_profile: {
      profile_id: profile.profile_id,
      revision: profile.revision,
      strategy_digest: profile.strategy_digest,
    },
    downstream_identity: providerCredentialProfileIdentity,
    request_mapping: null,
    mcp_tool_namespace: null,
    mcp_selected_tools: [],
    mcp_tool_selection_operation_id: null,
    status: "DRAFT",
    configuration_revision: 1,
    lifecycle: "DRAFT",
    verification_state: "UNVERIFIED",
    health_state: "UNKNOWN",
    health_observed_at: null,
    health_source_revision: null,
    routing_priority: 0,
    region: null,
    supported_obligations: [],
    created_at: 1,
  } satisfies ConnectionRegistration
  assert.equal(await verifier.verify({ connection, providerCredentialProfile: profile }), true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, "https://generativelanguage.googleapis.com/v1beta/openai/models")
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer test-only-secret")
  const missingSecretVerifier = createHttpConnectionVerifier({
    allowedHosts: ["generativelanguage.googleapis.com"],
    fetcher: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  })
  assert.equal(await missingSecretVerifier.verify({ connection, providerCredentialProfile: profile }), false)
})
