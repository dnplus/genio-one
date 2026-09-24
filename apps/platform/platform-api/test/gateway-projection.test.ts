import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { Check } from "typebox/value"

import { PlatformApiError } from "../src/capabilities/errors"
import type { ResourceRegistration } from "../src/capabilities/resources/contract"
import type {
  GatewayProjectionRequest,
  GatewayProjectionSnapshot,
  GatewayProjectionRendererOptions,
} from "../src/capabilities/gateway-projection/contract"
import { GatewayProjectionSchema } from "../src/capabilities/gateway-projection/contract"
import type {
  CompiledEnforcementChain,
  EnforcementStep,
} from "../src/capabilities/enforcement/contract"
import {
  canonicalGatewayProjectionJson,
  createInMemoryGatewayProjector,
} from "../src/capabilities/gateway-projection/memory"
import { parseConnectionCertificate } from "../src/capabilities/connections/certificate"
import { createDurableEd25519Signer } from "../src/capabilities/gateway-projection/signer"
import { mcpOAuthHeaderName } from "../../../../runtimes/gateway/services/shared/mcp-oauth-handoff"

// Generate the fixture at runtime so release secret scanners do not mistake a
// test-only PEM literal for a product credential.
const TEST_PROJECTION_PRIVATE_KEY = generateKeyPairSync("ed25519").privateKey.export({
  format: "pem",
  type: "pkcs8",
}).toString()
const testProjectionSigner = createDurableEd25519Signer({
  privateKeyPem: TEST_PROJECTION_PRIVATE_KEY,
  keyId: "typescript-projection-fixture",
})
const canonicalJsonFixture = JSON.parse(readFileSync(
  new URL("./fixtures/canonical-json-adversarial.json", import.meta.url),
  "utf8",
))

test("projection canonical JSON uses locale-independent UTF-8 key ordering", () => {
  assert.equal(
    canonicalGatewayProjectionJson(canonicalJsonFixture.input),
    canonicalJsonFixture.canonical,
  )
})

const chain = {
  chain_id: "chain-resource-ai-7",
  tenant_id: "tenant-acme",
  resource_id: "resource-ai",
  capability_id: "chat",
  eligible_connection_ids: ["connection-openai", "connection-omlx"],
  one_policy_revision: 7,
  request_filter_order: ["authz", "token-vault"],
  response_filter_order: ["token-vault"],
  steps: [
    {
      step_id: "authn",
      kind: "AUTHENTICATE",
      phase: "REQUEST",
      implementation: "NATIVE",
      config: {
        schema_version: "genio.one.auth.jwt.v1",
        provider: "keycloak",
        issuer: "https://identity.example.test/realms/acme",
        audiences: ["genio-one"],
        remote_jwks_uri: "https://identity.example.test/realms/acme/protocol/openid-connect/certs",
        subject_claim: "sub",
        client_claim: "azp",
      },
    },
    {
      step_id: "authz",
      kind: "AUTHORIZE",
      phase: "REQUEST",
      implementation: "EXT_AUTH",
    },
    {
      step_id: "token-vault",
      kind: "PROCESS",
      implementation: "PROCESSOR",
      hooks: {
        request: {
          action: "TOKENIZE",
          // Deliberately nested: projection policy data must not carry
          // credentials or token material, even when an action is extended.
          config: {
            paths: ["json-paths"],
            metadata: { scope: "request" },
          },
        },
        response: { action: "RESTORE", config: { response_paths: ["response-paths"] } },
      },
    },
    {
      step_id: "route",
      kind: "ROUTE",
      phase: "ROUTING",
      implementation: "AIGW_NATIVE",
    },
  ],
} as CompiledEnforcementChain

const resource: ResourceRegistration = {
  tenant_id: "tenant-acme",
  resource_id: "resource-ai",
  display_name: "Corporate AI",
  kind: "LLM",
  owner_organization_id: "org-ai",
  authentication_strategy: "OAUTH",
  environment_id: "local",
  version: "1.0.0",
  lifecycle: "DRAFT",
  publication_endpoint: {
    gateway_id: "ai-gateway",
    hostname: "ai.example.test",
    base_path: "/v1",
    visibility: "PRIVATE",
    dns_management: "PLATFORM_MANAGED",
    dns_verification: "VERIFIED",
  },
  publication_request: null,
  operational_state: "HEALTHY",
  capabilities: [{ capability_id: "chat", display_name: "Chat" }],
  enforcement_point_id: "ai-gateway",
  created_at: 1,
}

const connections = [
  {
    tenant_id: "tenant-acme",
    connection_id: "connection-openai",
    resource_id: "resource-ai",
    display_name: "OpenAI primary",
    provider_type: "OPENAI",
    provider_profile_id: "provider-openai",
    endpoint: "https://api.openai.example/v1",
    credential_ref: "openai-api-key",
    status: "READY",
    configuration_revision: 1,
    lifecycle: "ENABLED",
    verification_state: "VERIFIED",
    health_state: "HEALTHY",
    health_observed_at: 1,
    health_source_revision: 1,
    routing_priority: 0,
    region: null,
    supported_obligations: ["REDACT", "RESTORE", "TOKENIZE"],
    created_at: 1,
  },
  {
    tenant_id: "tenant-acme",
    connection_id: "connection-omlx",
    resource_id: "resource-ai",
    display_name: "OMLX local",
    provider_type: "GENERIC_OPENAI_COMPATIBLE",
    provider_profile_id: "provider-generic-openai-compatible",
    endpoint: "http://127.0.0.1:8000",
    credential_ref: null,
    status: "READY",
    configuration_revision: 1,
    lifecycle: "ENABLED",
    verification_state: "VERIFIED",
    health_state: "HEALTHY",
    health_observed_at: 2,
    health_source_revision: 1,
    routing_priority: 10,
    region: null,
    supported_obligations: ["REDACT", "RESTORE", "TOKENIZE"],
    created_at: 2,
  },
] as never

const models = [
  {
    tenant_id: "tenant-acme",
    model_id: "model-gpt",
    model_name: "corporate-gpt",
    display_name: "Corporate GPT",
    resource_id: "resource-ai",
    visibility: "PUBLIC",
    lifecycle: "PUBLISHED",
    capabilities: ["CHAT", "STREAMING"],
    created_at: 1,
  },
  {
    tenant_id: "tenant-acme",
    model_id: "model-omlx",
    model_name: "local-omlx",
    display_name: "Local OMLX",
    resource_id: "resource-ai",
    visibility: "PUBLIC",
    lifecycle: "PUBLISHED",
    capabilities: ["CHAT", "STREAMING"],
    created_at: 2,
  },
] as never

const modelMappings = [
  {
    tenant_id: "tenant-acme",
    mapping_id: "mapping-gpt-openai",
    public_model_id: "model-gpt",
    resource_id: "resource-ai",
    connection_id: "connection-openai",
    provider_model: "gpt-4.1",
    mapping_revision: 1,
    created_at: 1,
  },
  {
    tenant_id: "tenant-acme",
    mapping_id: "mapping-gpt-omlx",
    public_model_id: "model-gpt",
    resource_id: "resource-ai",
    connection_id: "connection-omlx",
    provider_model: "mlx-community/Qwen3-8B",
    mapping_revision: 1,
    created_at: 1,
  },
  {
    tenant_id: "tenant-acme",
    mapping_id: "mapping-local-openai",
    public_model_id: "model-omlx",
    resource_id: "resource-ai",
    connection_id: "connection-openai",
    provider_model: "gpt-4.1-mini",
    mapping_revision: 1,
    created_at: 2,
  },
  {
    tenant_id: "tenant-acme",
    mapping_id: "mapping-local-omlx",
    public_model_id: "model-omlx",
    resource_id: "resource-ai",
    connection_id: "connection-omlx",
    provider_model: "mlx-community/Llama-3.1-8B",
    mapping_revision: 1,
    created_at: 2,
  },
] as GatewayProjectionSnapshot["model_mappings"]

function publicationSnapshot(
  overrides: Partial<GatewayProjectionSnapshot> = {},
): GatewayProjectionSnapshot {
  return {
    tenant_id: "tenant-acme",
    publication_id: "publication-ai-1",
    request_id: "publication-request-1",
    resource_id: "resource-ai",
    capability_id: "chat",
    endpoint_revision: 1,
    resource_revision: 1,
    policy_revision: 7,
    resource_digest: "resource-digest",
    snapshot_digest: "snapshot-digest",
    resource,
    publication_endpoint: resource.publication_endpoint!,
    one_policy_chain: chain,
    connections,
    models,
    model_mappings: modelMappings,
    ...overrides,
  }
}

function projector(
  snapshot = publicationSnapshot(),
  aigwRootPrefix = snapshot.publication_endpoint?.base_path ?? "/",
  rendererOptions: Pick<GatewayProjectionRendererOptions, "telemetry" | "signer"> = {},
) {
  return createInMemoryGatewayProjector({
    source: {
      async getSnapshot({ tenantId, publicationId }) {
        return tenantId === snapshot.tenant_id && publicationId === snapshot.publication_id
          ? snapshot
          : null
      },
    },
    aigwRootPrefix,
    extAuth: { name: "genio-one-authorizer", port: 8081 },
    processor: { name: "genio-one-processor-http", port: 8182 },
    ...rendererOptions,
    signer: rendererOptions.signer ?? testProjectionSigner,
  })
}

const request = {
  publication_id: "publication-ai-1",
} satisfies GatewayProjectionRequest

test("LLM public routes use bounded timeouts by model capability", async () => {
  for (const transcription of [false, true]) {
    const snapshot = publicationSnapshot({
      models: publicationSnapshot().models.map((model) => ({ ...model, capabilities: transcription ? ["TRANSCRIPTION"] : model.capabilities })),
    })
    const projection = await projector(snapshot).compile({ tenantId: "tenant-acme", value: request })
    const route = projection.resources.find((value) => value.kind === "HTTPRoute" && value.metadata.name === "resource-ai-chat")!
    const rule = (route.spec.rules as Array<Record<string, unknown>>)[0]!
    assert.deepEqual(
      rule.timeouts,
      transcription
        ? { request: "120s", backendRequest: "120s" }
        : { request: "60s", backendRequest: "60s" },
    )
  }
})

test("projection emits native CRD shapes and a signed, secret-free policy bundle", async () => {
  const gatewayProjector = projector()
  const first = await gatewayProjector.compile({ tenantId: "tenant-acme", value: request })
  const second = await gatewayProjector.compile({ tenantId: "tenant-acme", value: request })

  assert.equal(first.digest, second.digest)
  assert.equal(first.signature.algorithm, "Ed25519")
  assert.equal(first.signature.key_id, second.signature.key_id)
  assert.equal(first.signature.value, second.signature.value)
  assert.equal(Check(GatewayProjectionSchema, first), true)
  assert.equal(
    Check(GatewayProjectionSchema, { ...first, operation: "APPLY", resources: [] }),
    false,
  )
  assert.equal(
    Check(GatewayProjectionSchema, { ...first, operation: "DELETE", resources: [] }),
    true,
  )
  assert.equal(
    Check(GatewayProjectionSchema, { ...first, operation: "DELETE" }),
    false,
  )
  assert.ok(first.signature.value.length > 20)
  assert.deepEqual(first.publication_endpoint, {
    gateway_id: "ai-gateway",
    hostname: "ai.example.test",
    base_path: "/v1",
  })

  const kinds = first.resources.map((resource) => resource.kind)
  assert.equal(first.operation, "APPLY")
  assert.ok(kinds.includes("AIGatewayRoute"))
  assert.ok(kinds.includes("AIServiceBackend"))
  assert.ok(kinds.includes("Backend"))
  assert.ok(kinds.includes("BackendSecurityPolicy"))
  assert.ok(kinds.includes("BackendTrafficPolicy"))
  assert.ok(kinds.includes("SecurityPolicy"))
  assert.ok(kinds.includes("EnvoyExtensionPolicy"))
  assert.ok(kinds.includes("EnvoyProxy"))
  assert.ok(kinds.includes("ClientTrafficPolicy"))
  const gatewayConfig = first.resources.find((resource) => resource.kind === "GatewayConfig")!
  assert.equal(gatewayConfig.apiVersion, "aigateway.envoyproxy.io/v1beta1")
  assert.equal(gatewayConfig.metadata.name, "ai-gateway-config")
  assert.equal(gatewayConfig.metadata.labels?.["app.kubernetes.io/managed-by"], undefined)
  assert.deepEqual(gatewayConfig.spec, {
    extProc: {
      kubernetes: {
        env: [
          { name: "AI_GATEWAY_TRACING_SEMCONV", value: "gen_ai" },
          {
            name: "OTEL_RESOURCE_ATTRIBUTES",
            value: "genio.tenant.id=tenant-acme",
          },
          {
            name: "OTEL_AIGW_SPAN_REQUEST_HEADER_ATTRIBUTES",
            value: "x-request-id:genio.correlation.id,x-genio-correlation-id:genio.correlation.id,x-genio-trusted-tenant-id:genio.tenant.id",
          },
          {
            name: "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
            value: "true",
          },
        ],
      },
    },
  })
  const sharedBackends = first.resources.filter(
    (resource) => resource.kind === "Backend" && resource.metadata.labels?.["genio.one/shared-component"],
  )
  assert.deepEqual(
    sharedBackends.map((resource) => resource.metadata.labels?.["genio.one/shared-component"]).sort(),
    [
      "genio-one-authorizer",
      "genio-one-processor",
      "genio-one-processor-http",
    ],
  )
  assert.equal(JSON.stringify(first).includes("api_version"), false)
  assert.equal(JSON.stringify(first).includes("json-paths"), true)

  const route = first.resources.find((resource) => resource.kind === "AIGatewayRoute")!
  assert.equal(route.apiVersion, "aigateway.envoyproxy.io/v1beta1")
  assert.deepEqual(Object.keys(route.spec).sort(), [
    "hostnames",
    "llmRequestCosts",
    "parentRefs",
    "rules",
  ])
  assert.equal(route.metadata.name, "resource-ai-chat-aigw")
  assert.equal(
    route.metadata.annotations?.["genio.one/generated-httproute-name"],
    "resource-ai-chat-aigw",
  )
  assert.equal(route.metadata.annotations?.["genio.one/base-path"], undefined)
  assert.equal((route.spec.parentRefs as Array<{ name: string }>)[0].name, "ai-gateway")
  assert.equal(
    (route.spec.parentRefs as Array<{ sectionName: string }>)[0].sectionName,
    "internal",
  )
  assert.deepEqual(route.spec.hostnames, ["resource-ai-chat-aigw.internal.localhost"])
  assert.equal((route.spec.rules as Array<unknown>).length, 2)
  const routePriorities = (route.spec.rules as Array<{ backendRefs: Array<{ priority: number }> }>)
    .flatMap((rule) => rule.backendRefs.map((reference) => reference.priority))
  assert.deepEqual(routePriorities, [0, 10, 0, 10])
  const retryPolicy = first.resources.find((resource) => resource.kind === "BackendTrafficPolicy")!
  assert.equal((retryPolicy.spec.retry as { numRetries: number }).numRetries, 2)

  const publicRoute = first.resources.find(
    (resource) => resource.kind === "HTTPRoute" && resource.metadata.name === "resource-ai-chat",
  )!
  assert.deepEqual(publicRoute.spec.hostnames, ["ai.example.test"])
  assert.equal(
    (publicRoute.spec.parentRefs as Array<{ sectionName: string }>)[0].sectionName,
    "http",
  )
  const publicRule = (publicRoute.spec.rules as Array<{
    matches: Array<{ path: { value: string } }>
    filters: Array<Record<string, unknown>>
    backendRefs: Array<{ name: string; port: number }>
  }>)[0]
  assert.equal(publicRule.matches[0].path.value, "/v1")
  assert.deepEqual(publicRule.backendRefs, [{
    group: "",
    kind: "Service",
    name: "genio-one-aigw-internal",
    namespace: "default",
    port: 1976,
  }])
  assert.equal(JSON.stringify(publicRule.filters).includes("authorization"), true)
  assert.equal(JSON.stringify(publicRule.filters).includes("resource-ai-chat-aigw.internal.localhost"), true)

  const aiBackends = first.resources.filter((resource) => resource.kind === "AIServiceBackend")
  assert.equal(aiBackends.length, 2)
  for (const aiBackend of aiBackends) {
    assert.equal(aiBackend.apiVersion, "aigateway.envoyproxy.io/v1beta1")
    assert.deepEqual(Object.keys(aiBackend.spec).sort(), ["backendRef", "schema"])
    assert.equal((aiBackend.spec.schema as { name: string }).name, "OpenAI")
    assert.equal((aiBackend.spec.backendRef as { kind: string; group: string }).kind, "Backend")
    assert.equal((aiBackend.spec.backendRef as { kind: string; group: string }).group, "gateway.envoyproxy.io")
  }

  const httpsBackend = first.resources.find(
    (resource) => resource.kind === "Backend" && resource.metadata.name.includes("connection-openai"),
  )!
  assert.equal(httpsBackend.apiVersion, "gateway.envoyproxy.io/v1alpha1")
  assert.ok(httpsBackend.spec.tls)
  assert.deepEqual((httpsBackend.spec.endpoints as Array<unknown>)[0], {
    fqdn: { hostname: "api.openai.example", port: 443 },
  })
  const httpsTls = httpsBackend.spec.tls as {
    ecdhCurves: string[]
    wellKnownCACertificates: string
  }
  assert.deepEqual(httpsTls.ecdhCurves, ["X25519", "P-256", "P-384"])
  assert.equal(httpsTls.wellKnownCACertificates, "System")
  assert.equal("insecureSkipVerify" in httpsTls, false)

  const credentialPolicy = first.resources.find((resource) => resource.kind === "BackendSecurityPolicy")!
  assert.deepEqual(credentialPolicy.spec.apiKey, {
    secretRef: { name: "openai-api-key", kind: "Secret" },
  })
  assert.equal(JSON.stringify(credentialPolicy).includes("OPENAI"), false)

  const authorization = first.resources.find((resource) => resource.kind === "SecurityPolicy")!
  assert.equal(authorization.apiVersion, "gateway.envoyproxy.io/v1alpha1")
  assert.equal((authorization.spec.extAuth as { failOpen: boolean }).failOpen, false)
  const extAuth = authorization.spec.extAuth as {
    grpc: { backendRefs: unknown[] }
    headersToExtAuth: string[]
    headersToBackend?: string[]
    bodyToExtAuth?: { maxRequestBytes: number }
    contextExtensions: Array<{ name: string; type: string; value: string }>
    includeRouteMetadata: boolean
    http?: unknown
  }
  assert.equal(extAuth.grpc.backendRefs.length, 1)
  assert.equal(extAuth.http, undefined)
  assert.equal(extAuth.includeRouteMetadata, true)
  assert.deepEqual(extAuth.headersToExtAuth, [
      "content-type",
    "x-genio-verified-subject",
    "x-genio-verified-client",
    "x-request-id",
    "x-genio-correlation-id",
    "x-genio-organization-id",
    "x-genio-use-case-id",
    "x-genio-on-behalf-of-subject-id",
    "x-genio-execution-grant-id",
    "x-genio-trusted-tenant-id",
    "x-genio-trusted-subject-id",
    "x-genio-trusted-client-id",
    "x-genio-trusted-resource-id",
    "x-genio-trusted-capability-id",
    "x-genio-trusted-correlation-id",
  ])
  assert.equal(extAuth.headersToBackend, undefined)
  assert.deepEqual(extAuth.bodyToExtAuth, { maxRequestBytes: 4_194_304 })
  assert.deepEqual(extAuth.contextExtensions, [
    { name: "tenant_id", type: "Value", value: "tenant-acme" },
    { name: "resource_id", type: "Value", value: "resource-ai" },
    { name: "capability_id", type: "Value", value: "chat" },
    { name: "request_protocol", type: "Value", value: "LLM" },
    { name: "enforcement_chain_id", type: "Value", value: "chain-resource-ai-7" },
  ])
  assert.equal(JSON.stringify(extAuth).includes("authorization"), false)
  assert.equal(JSON.stringify(extAuth).includes("x-genio-tenant-id"), false)
  assert.equal((authorization.spec.targetRefs as Array<{ kind: string; name: string }>)[0].kind, "HTTPRoute")
  assert.deepEqual(authorization.spec.jwt, {
    optional: false,
    providers: [
      {
        name: "keycloak",
        issuer: "https://identity.example.test/realms/acme",
        audiences: ["genio-one"],
        remoteJWKS: {
          uri: "https://identity.example.test/realms/acme/protocol/openid-connect/certs",
        },
        claimToHeaders: [
          { claim: "sub", header: "x-genio-verified-subject" },
          { claim: "azp", header: "x-genio-verified-client" },
        ],
      },
    ],
  })
  assert.equal(JSON.stringify(authorization.spec.jwt).includes("x-genio-tenant-id"), false)

  const envoyProxy = first.resources.find((resource) => resource.kind === "EnvoyProxy")!
  assert.equal(envoyProxy.apiVersion, "gateway.envoyproxy.io/v1alpha1")
  assert.equal(envoyProxy.metadata.name, "ai-gateway")
  assert.equal(envoyProxy.metadata.labels?.["app.kubernetes.io/managed-by"], undefined)
  assert.deepEqual(envoyProxy.spec.filterOrder, [
    {
      name: "envoy.filters.http.ext_authz",
      after: "envoy.filters.http.jwt_authn",
    },
    {
      name: "envoy.filters.http.lua",
      after: "envoy.filters.http.ext_authz",
    },
    {
      name: "envoy.filters.http.ext_proc",
      after: "envoy.filters.http.lua",
    },
  ])
  const accessLogJson = envoyProxy.spec.telemetry.accessLog.settings[0].format.json
  assert.equal(
    accessLogJson["genio.subject.id"],
    "%DYNAMIC_METADATA(genio.one.processor:x-genio-trusted-subject-id)%",
  )
  assert.equal(
    accessLogJson["genio.client.id"],
    "%DYNAMIC_METADATA(genio.one.processor:x-genio-trusted-client-id)%",
  )
  const correlationPolicy = first.resources.find(
    (resource) => resource.kind === "ClientTrafficPolicy",
  )!
  assert.equal(correlationPolicy.apiVersion, "gateway.envoyproxy.io/v1alpha1")
  assert.deepEqual(correlationPolicy.spec.connection, { bufferLimit: "4Mi" })
  assert.deepEqual(correlationPolicy.spec.targetRefs, [{
    group: "gateway.networking.k8s.io",
    kind: "Gateway",
    name: "ai-gateway",
  }])
  assert.deepEqual(correlationPolicy.spec.headers, {
    requestID: "PreserveOrGenerate",
  })

  const processing = first.resources.find((resource) => resource.kind === "EnvoyExtensionPolicy")!
  const lua = processing.spec.lua as Array<{ type: string; inline: string }>
  assert.equal(lua.length, 1)
  assert.equal(lua[0].type, "Inline")
  assert.equal(lua[0].inline.includes("/v1/process/request"), true)
  assert.equal(lua[0].inline.includes('handle:headers():get("x-genio-trusted-correlation-id")'), true)
  assert.equal(lua[0].inline.includes('handle:headers():remove("x-genio-correlation-id")'), true)
  assert.equal(lua[0].inline.includes('handle:headers():add("x-genio-correlation-id", correlation)'), true)
  assert.equal(lua[0].inline.includes("handle:headers():remove(safety_decisions_header)"), true)
  assert.equal(lua[0].inline.includes("handle:headers():replace(name, value)"), true)
  assert.equal(lua[0].inline.includes('transformed = transformed or ""'), true)
  assert.equal(lua[0].inline.includes("/v1/process/response"), false)
  assert.equal(processing.spec.extProc[0].messageTimeout, "35s")
  assert.equal(lua[0].inline.includes("    35000\n"), true)
  assert.deepEqual(processing.spec.extProc[0].processingMode, {
    allowModeOverride: true,
    request: {},
    response: { body: "Streamed" },
  })
  assert.equal(lua[0].inline.includes("handle:body(true):setBytes(transformed)"), true)
  assert.equal(processing.metadata.annotations?.["genio.one/process-steps"], "token-vault")

  assert.equal(first.policy_bundle.enforcement_chain.steps.length, 4)
  assert.equal(JSON.stringify(first.policy_bundle).includes("apiKey"), false)
  assert.equal(JSON.stringify(first.policy_bundle).includes("privateKey"), false)
})

test("projection binds an imported custom CA to a deterministic ConfigMap reference", async () => {
  const certificate = parseConnectionCertificate({
    mode: "CUSTOM_CA",
    certificate_pem: readFileSync(new URL("../../tests/fixtures/client-auth/test-client-ca.pem", import.meta.url), "utf8"),
  })
  const connectionValues = connections as unknown as Array<Record<string, unknown>>
  const snapshot = publicationSnapshot({
    connections: connectionValues.map((connection) => connection.connection_id === "connection-openai"
      ? { ...connection, certificate }
      : connection),
  } as never)
  const projection = await projector(snapshot).compile({ tenantId: "tenant-acme", value: request })
  const backend = projection.resources.find((resource) => resource.kind === "Backend" && resource.metadata.name.includes("connection-openai"))!
  const tls = backend.spec.tls as {
    caCertificateRefs: Array<{ group: string; kind: string; name: string }>
    ecdhCurves: string[]
    sni: string
  }
  assert.deepEqual(tls.ecdhCurves, ["X25519", "P-256", "P-384"])
  assert.equal(tls.sni, "api.openai.example")
  assert.equal("insecureSkipVerify" in tls, false)
  assert.deepEqual(tls.caCertificateRefs, [{
    group: "",
    kind: "ConfigMap",
    name: `${backend.metadata.name}-ca`,
  }])
  const bundle = projection.resources.find((resource) => resource.kind === "ConfigMap")!
  assert.equal((bundle as unknown as { data: { "ca.crt": string } }).data["ca.crt"], certificate.certificate_pem)
  assert.equal(Check(GatewayProjectionSchema, projection), true)
})

test("selected GCP Vertex Connection projects exact credential profile strategies without credential material", async () => {
  const gcpConnection = {
    tenant_id: "tenant-acme",
    connection_id: "connection-gcp",
    resource_id: "resource-ai",
    display_name: "Vertex production",
    connection_kind: "LLM",
    provider_type: "GCP_VERTEX_AI",
    provider_profile_id: "provider-gcp-vertex-ai",
    endpoint: "https://us-central1-aiplatform.googleapis.com/v1",
    provider_credential_profile: {
      profile_id: "provider-credential-gcp-wif",
      revision: 1,
      strategy_digest: "b".repeat(64),
    },
    downstream_identity: {
      mode: "SERVICE",
      authentication: "PROVIDER_CREDENTIAL_PROFILE",
    },
    request_mapping: null,
    mcp_tool_namespace: null,
    mcp_selected_tools: [],
    mcp_tool_selection_operation_id: null,
    status: "READY",
    configuration_revision: 3,
    lifecycle: "ENABLED",
    verification_state: "VERIFIED",
    health_state: "HEALTHY",
    health_observed_at: 10,
    health_source_revision: 3,
    routing_priority: 0,
    region: "us-central1",
    supported_obligations: ["REDACT", "RESTORE", "TOKENIZE"],
    created_at: 1,
  } as GatewayProjectionSnapshot["connections"][number]
  const gcpModel = {
    tenant_id: "tenant-acme",
    model_id: "model-gemini",
    model_name: "corporate-gemini",
    display_name: "Corporate Gemini",
    resource_id: "resource-ai",
    visibility: "PUBLIC",
    lifecycle: "PUBLISHED",
    capabilities: ["CHAT", "STREAMING"],
    created_at: 1,
  } as GatewayProjectionSnapshot["models"][number]
  const gcpMapping = {
    tenant_id: "tenant-acme",
    mapping_id: "mapping-gemini-gcp",
    public_model_id: gcpModel.model_id,
    resource_id: "resource-ai",
    connection_id: gcpConnection.connection_id,
    provider_model: "gemini-2.5-flash",
    mapping_revision: 1,
    created_at: 1,
  } as GatewayProjectionSnapshot["model_mappings"][number]
  const gcpChain = {
    ...chain,
    eligible_connection_ids: [gcpConnection.connection_id],
  } as CompiledEnforcementChain
  const projection = await projector(publicationSnapshot({
    connections: [gcpConnection],
    provider_credential_profiles: [{
      tenant_id: "tenant-acme",
      profile_id: "provider-credential-gcp-wif",
      revision: 1,
      owner_organization_id: "organization-ai-platform",
      display_name: "Vertex WIF",
      adapter_family: "GCP",
      strategy: {
        kind: "OIDC_FEDERATION",
        source: {
          issuer: "https://identity.example.test/realms/genio-one",
          client_id: "genio-gateway",
          client_secret_ref: "vertex-oidc-client",
          audience: "gcp-sts",
        },
        exchange: {
          adapter: "GCP_STS",
          project_name: "genio-production",
          region: "us-central1",
          project_id: "123456789",
          workload_identity_pool_name: "genio-pool",
          workload_identity_provider_name: "genio-oidc",
          service_account_name: "genio-runtime",
        },
      },
      strategy_digest: "b".repeat(64),
      state: "ACTIVE",
      created_by_subject_id: "person-admin",
      created_at: 1,
    }],
    models: [gcpModel],
    model_mappings: [gcpMapping],
    one_policy_chain: gcpChain,
  })).compile({ tenantId: "tenant-acme", value: request })
  const backend = projection.resources.find((item) => item.kind === "AIServiceBackend")!
  assert.equal((backend.spec.schema as { name: string }).name, "GCPVertexAI")
  assert.equal(backend.metadata.annotations?.["genio.one/provider-credential-profile-id"], "provider-credential-gcp-wif")
  assert.equal(backend.metadata.annotations?.["genio.one/provider-credential-profile-revision"], "1")
  assert.equal(backend.metadata.annotations?.["genio.one/provider-credential-strategy-digest"], "b".repeat(64))
  const policy = projection.resources.find((item) => item.kind === "BackendSecurityPolicy")!
  assert.equal(policy.spec.type, "GCPCredentials")
  assert.deepEqual(policy.spec.gcpCredentials, {
    projectName: "genio-production",
    region: "us-central1",
    workloadIdentityFederationConfig: {
      projectID: "123456789",
      workloadIdentityPoolName: "genio-pool",
      workloadIdentityProviderName: "genio-oidc",
      serviceAccountImpersonation: { serviceAccountName: "genio-runtime" },
      oidcExchangeToken: {
        oidc: {
          provider: { issuer: "https://identity.example.test/realms/genio-one" },
          clientID: "genio-gateway",
          clientSecret: { name: "vertex-oidc-client", namespace: "default" },
        },
        aud: "gcp-sts",
      },
    },
  })
  assert.equal(JSON.stringify(projection).includes("client-secret-value"), false)

  const adcConnection = {
    ...gcpConnection,
    connection_id: "connection-gcp-adc",
    display_name: "Vertex ADC",
    credential_ref: undefined,
    provider_credential_profile: {
      profile_id: "provider-credential-gcp-adc",
      revision: 1,
      strategy_digest: "a".repeat(64),
    },
    downstream_identity: {
      mode: "SERVICE",
      authentication: "PROVIDER_CREDENTIAL_PROFILE",
    },
  } as GatewayProjectionSnapshot["connections"][number]
  const adcProjection = await projector(publicationSnapshot({
    connections: [adcConnection],
    provider_credential_profiles: [{
      tenant_id: "tenant-acme",
      profile_id: "provider-credential-gcp-adc",
      revision: 1,
      owner_organization_id: "organization-ai-platform",
      display_name: "Vertex ADC",
      credential_configured: true,
      adapter_family: "GCP",
      strategy: {
        kind: "RUNTIME_IDENTITY",
        adapter: "GCP_APPLICATION_DEFAULT",
        parameters: { project_name: "genio-production", region: "us-central1" },
      },
      strategy_digest: "a".repeat(64),
      state: "ACTIVE",
      created_by_subject_id: "person-admin",
      created_at: 1,
    }],
    models: [gcpModel],
    model_mappings: [{ ...gcpMapping, connection_id: adcConnection.connection_id }],
    one_policy_chain: {
      ...chain,
      eligible_connection_ids: [adcConnection.connection_id],
    } as CompiledEnforcementChain,
  })).compile({ tenantId: "tenant-acme", value: request })
  const adcPolicy = adcProjection.resources.find((item) => item.kind === "BackendSecurityPolicy")!
  assert.equal(adcPolicy.spec.type, "GCPCredentials")
  assert.equal(adcPolicy.spec.gcpCredentials.projectName, "genio-production")
  assert.equal(adcPolicy.spec.gcpCredentials.region, "us-central1")
  assert.match(adcPolicy.spec.gcpCredentials.credentialsFile.secretRef.name, /^genio-provider-[a-f0-9]{32}$/)
  assert.equal(adcPolicy.metadata.annotations?.["genio.one/credential-material-profile"], "provider-credential-gcp-adc")
  assert.equal(adcPolicy.metadata.annotations?.["genio.one/credential-material-revision"], "1")
  assert.equal(adcProjection.resources.some((item) => item.kind === "Secret"), false)
})

test("projection emits native GatewayConfig with message capture enabled for complete telemetry", async () => {
  const gatewayProjector = projector(publicationSnapshot(), "/v1", {
    telemetry: {
      name: "genio-one-otel-collector",
      host: "genio-one-otel-collector.default.svc.cluster.local",
      port: 4317,
    },
  })
  const projection = await gatewayProjector.compile({ tenantId: "tenant-acme", value: request })
  const config = projection.resources.find((resource) => resource.kind === "GatewayConfig")!
  assert.deepEqual(config.spec, {
    extProc: {
      kubernetes: {
        env: [
          { name: "AI_GATEWAY_TRACING_SEMCONV", value: "gen_ai" },
          {
            name: "OTEL_RESOURCE_ATTRIBUTES",
            value: "genio.tenant.id=tenant-acme",
          },
          {
            name: "OTEL_AIGW_SPAN_REQUEST_HEADER_ATTRIBUTES",
            value: "x-request-id:genio.correlation.id,x-genio-correlation-id:genio.correlation.id,x-genio-trusted-tenant-id:genio.tenant.id",
          },
          {
            name: "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
            value: "true",
          },
          {
            name: "OTEL_EXPORTER_OTLP_ENDPOINT",
            value: "http://genio-one-otel-collector.default.svc.cluster.local:4318",
          },
          {
            name: "OTEL_TRACES_EXPORTER",
            value: "otlp",
          },
          {
            name: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            value: "http://genio-one-otel-collector.default.svc.cluster.local:4318/v1/traces",
          },
          {
            name: "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
            value: "http/protobuf",
          },
          {
            name: "OTEL_EXPORTER_OTLP_PROTOCOL",
            value: "http/protobuf",
          },
        ],
      },
    },
  })
})

test("API projection preserves unspecified parameters and compiles operation overrides without AI processor resources", async () => {
  const apiResource = {
    ...resource,
    resource_id: "resource-api",
    display_name: "Incident API",
    kind: "API",
    capabilities: [{ capability_id: "incident.list", display_name: "GET /incidents" }],
    publication_endpoint: {
      ...resource.publication_endpoint!,
      gateway_id: "api-gateway",
      hostname: "api.example.test",
      base_path: "/internal-api",
    },
    api: {
      api_product_id: "incident-api",
      openapi_version: "3.1.0",
      document_title: "Incident API",
      document_version: "1.0.0",
      public_path: "/internal-api",
      inbound_security: {
        type: "JWT",
        issuer: "https://identity.example.test/realms/acme",
        audience: "genio-one",
        jwks_url: "https://identity.example.test/realms/acme/protocol/openid-connect/certs",
      },
      request_schema_validation: true,
      operations: [{ operation_id: "incident.list", method: "GET", path: "/incidents" }],
    },
  } satisfies ResourceRegistration
  const apiChain = {
    ...chain,
    chain_id: "chain-resource-api-1",
    resource_id: apiResource.resource_id,
    capability_id: "incident.list",
    eligible_connection_ids: ["connection-api"],
    request_filter_order: ["authz"],
    response_filter_order: [],
    steps: chain.steps.filter((step) => step.kind !== "PROCESS"),
  }
  const apiConnection = {
    tenant_id: "tenant-acme",
    connection_id: "connection-api",
    resource_id: apiResource.resource_id,
    display_name: "Incident upstream",
    connection_kind: "API",
    provider_type: null,
    provider_profile_id: null,
    endpoint: "http://127.0.0.1:19005/v2",
    mcp_tool_namespace: null,
    mcp_selected_tools: [],
    mcp_tool_selection_operation_id: null,
    credential_ref: null,
    downstream_identity: { mode: "NONE" },
    request_mapping: {
      default_action: "PASSTHROUGH",
      rules: [
        {
          operation_id: "incident.list",
          location: "HEADER",
          name: "x-api-version",
          action: "SET",
          value: "2026-08",
        },
        {
          operation_id: "incident.list",
          location: "QUERY",
          name: "locale",
          action: "SET",
          value: "zh-TW",
        },
      ],
    },
    status: "READY",
    configuration_revision: 1,
    lifecycle: "ENABLED",
    verification_state: "VERIFIED",
    health_state: "HEALTHY",
    health_observed_at: 1,
    health_source_revision: 1,
    routing_priority: 0,
    region: null,
    supported_obligations: [],
    created_at: 1,
  } satisfies GatewayProjectionSnapshot["connections"][number]
  const projection = await projector(publicationSnapshot({
    resource_id: apiResource.resource_id,
    capability_id: "incident.list",
    resource: apiResource,
    publication_endpoint: apiResource.publication_endpoint!,
    one_policy_chain: apiChain,
    connections: [apiConnection],
    models: [],
    model_mappings: [],
  }) as GatewayProjectionSnapshot).compile({ tenantId: "tenant-acme", value: request })

  assert.equal(projection.resources.some((value) => value.kind === "GatewayConfig"), false)
  assert.equal(projection.resources.some((value) => value.kind === "AIGatewayRoute"), false)
  assert.equal(projection.resources.some((value) => value.kind === "AIServiceBackend"), false)
  assert.equal(projection.resources.some((value) => value.metadata.name.includes("processor-bridge")), false)
  assert.equal(projection.resources.some((value) => value.metadata.name === "genio-one-processor"), false)
  assert.equal(projection.resources.some((value) => value.metadata.name === "genio-one-processor-http"), false)

  const route = projection.resources.find((value) => value.kind === "HTTPRoute")!
  const rule = route.spec.rules[0]
  assert.deepEqual(rule.matches, [{
    path: { type: "Exact", value: "/internal-api/incidents" },
    method: "GET",
  }])
  assert.deepEqual(rule.filters, [
    {
      type: "URLRewrite",
      urlRewrite: {
        path: { type: "ReplaceFullPath", replaceFullPath: "/v2/incidents" },
      },
    },
    {
      type: "RequestHeaderModifier",
      requestHeaderModifier: {
        set: [{ name: "x-api-version", value: "2026-08" }],
      },
    },
  ])

  const processing = projection.resources.find((value) => value.kind === "EnvoyExtensionPolicy")!
  const inline = processing.spec.lua[0].inline as string
  assert.equal(inline.includes('name="locale",action="SET",value="zh-TW"'), true)
  assert.equal(inline.includes("httpCall"), false)
  assert.equal(processing.spec.extProc, undefined)

  const a2aResource = {
    ...apiResource,
    resource_id: "resource-a2a",
    display_name: "Refund Agent",
    capabilities: [{ capability_id: "refund.request", display_name: "Request refund" }],
    api: {
      ...apiResource.api,
      api_product_id: "refund-agent",
      public_path: "/agents/refund",
      operations: [{ operation_id: "refund.request", method: "POST", path: "/message:send" }],
      a2a: {
        protocol_version: "1.0",
        operation: "SEND_MESSAGE",
        target_agent_subject_id: "agent-refund",
      },
    },
  } satisfies ResourceRegistration
  const a2aChain = {
    ...apiChain,
    chain_id: "chain-resource-a2a-1",
    resource_id: a2aResource.resource_id,
    capability_id: "refund.request",
    eligible_connection_ids: ["connection-a2a"],
  }
  const a2aConnection = {
    ...apiConnection,
    connection_id: "connection-a2a",
    resource_id: a2aResource.resource_id,
    request_mapping: { default_action: "PASSTHROUGH" as const, rules: [] },
  }
  const a2aProjection = await projector(publicationSnapshot({
    resource_id: a2aResource.resource_id,
    capability_id: "refund.request",
    resource: a2aResource,
    publication_endpoint: {
      ...apiResource.publication_endpoint!,
      base_path: "/agents/refund",
    },
    one_policy_chain: a2aChain,
    connections: [a2aConnection],
    models: [],
    model_mappings: [],
  }) as GatewayProjectionSnapshot).compile({ tenantId: "tenant-acme", value: request })
  const a2aSecurity = a2aProjection.resources.find((value) =>
    value.kind === "SecurityPolicy" && value.metadata.name.endsWith("-authorization"))!
  assert.deepEqual(a2aSecurity.spec.extAuth.contextExtensions, [
    { name: "tenant_id", type: "Value", value: "tenant-acme" },
    { name: "resource_id", type: "Value", value: "resource-a2a" },
    { name: "capability_id", type: "Value", value: "refund.request" },
    { name: "request_protocol", type: "Value", value: "A2A" },
    { name: "a2a_operation", type: "Value", value: "SEND_MESSAGE" },
    { name: "target_agent_subject_id", type: "Value", value: "agent-refund" },
    { name: "enforcement_chain_id", type: "Value", value: "chain-resource-a2a-1" },
  ])
  await assert.rejects(
    projector(publicationSnapshot({
      resource_id: a2aResource.resource_id,
      capability_id: "refund.request",
      resource: {
        ...a2aResource,
        api: {
          ...a2aResource.api,
          operations: [{ operation_id: "refund.request", method: "POST", path: "/tasks" }],
        },
      },
      publication_endpoint: {
        ...apiResource.publication_endpoint!,
        base_path: "/agents/refund",
      },
      one_policy_chain: a2aChain,
      connections: [a2aConnection],
      models: [],
      model_mappings: [],
    }) as GatewayProjectionSnapshot).compile({ tenantId: "tenant-acme", value: request }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "A2A_OPERATION_MAPPING_INVALID",
  )
})

test("MCP projection delegates outbound identity to native backend policy", async () => {
  const mcpResource: ResourceRegistration = {
    ...resource,
    resource_id: "resource-mcp",
    display_name: "Engineering MCP",
    kind: "MCP",
    capabilities: [{ capability_id: "mcp.invoke", display_name: "Invoke MCP tools" }],
    publication_endpoint: {
      gateway_id: "ai-gateway",
      hostname: "mcp.example.test",
      base_path: "/mcp",
      visibility: "PRIVATE",
      dns_management: "PLATFORM_MANAGED",
      dns_verification: "VERIFIED",
    },
  }
  const mcpConnection = {
    tenant_id: "tenant-acme",
    connection_id: "connection-mcp",
    resource_id: "resource-mcp",
    display_name: "Jira MCP",
    connection_kind: "MCP",
    provider_type: null,
    provider_profile_id: null,
    endpoint: "https://mcp.example.test/mcp",
    mcp_tool_namespace: "jira",
    mcp_selected_tools: ["search_issues"],
    mcp_tool_selection_operation_id: "mcp-discovery-jira-1",
    credential_ref: null,
    downstream_identity: {
      mode: "USER_PASSTHROUGH",
      forward_headers: [{ name: "x-atlassian-token" }],
    },
    status: "READY",
    configuration_revision: 1,
    lifecycle: "ENABLED",
    verification_state: "VERIFIED",
    health_state: "HEALTHY",
    health_observed_at: 1,
    health_source_revision: 1,
    routing_priority: 0,
    region: null,
    supported_obligations: [],
    created_at: 1,
  }
  const authnStep = chain.steps.find(
    (step): step is Extract<EnforcementStep, { kind: "AUTHENTICATE" }> =>
      step.kind === "AUTHENTICATE",
  )!
  const mcpChain: CompiledEnforcementChain = {
    chain_id: "chain-resource-mcp-1",
    tenant_id: "tenant-acme",
    resource_id: "resource-mcp",
    capability_id: "mcp.invoke",
    eligible_connection_ids: ["connection-mcp"],
    one_policy_revision: 1,
    request_filter_order: ["authz"],
    response_filter_order: [],
    steps: [
      {
        step_id: "authn",
        kind: "AUTHENTICATE",
        phase: "REQUEST",
        implementation: "NATIVE",
        config: authnStep.config,
      },
      {
        step_id: "authz",
        kind: "AUTHORIZE",
        phase: "REQUEST",
        implementation: "EXT_AUTH",
        depends_on: ["authn"],
      },
      {
        step_id: "route",
        kind: "ROUTE",
        phase: "ROUTING",
        implementation: "AIGW_NATIVE",
        depends_on: ["authz"],
      },
    ],
  }
  const projection = await projector(
    publicationSnapshot({
      publication_id: "publication-mcp-1",
      resource_id: "resource-mcp",
      capability_id: "mcp.invoke",
      policy_revision: 1,
      resource: mcpResource,
      publication_endpoint: mcpResource.publication_endpoint!,
      one_policy_chain: mcpChain,
      connections: [mcpConnection] as never,
      models: [],
      model_mappings: [],
    }),
  ).compile({ tenantId: "tenant-acme", value: { publication_id: "publication-mcp-1" } })

  const route = projection.resources.find((candidate) => candidate.kind === "MCPRoute")!
  const backendRef = (route.spec.backendRefs as Array<Record<string, unknown>>)[0]!
  assert.deepEqual(route.spec.hostnames, ["mcp.example.test"])
  assert.equal(route.spec.path, "/mcp")
  assert.equal((route.spec.parentRefs as Array<{ sectionName: string }>)[0]?.sectionName, "http")
  assert.equal(backendRef.path, "/mcp")
  assert.deepEqual(backendRef.toolSelector, { include: ["search_issues"] })
  assert.deepEqual(backendRef.forwardHeaders, [
    { name: "x-request-id" },
    { name: "x-atlassian-token" },
  ])
  assert.equal(backendRef.name, "jira")
  const backend = projection.resources.find(
    (candidate) => candidate.kind === "Backend" && candidate.metadata.name === "jira",
  )!
  assert.equal(backend.metadata.name, "jira")
  const tls = backend.spec.tls as {
    ecdhCurves: string[]
    sni: string
    wellKnownCACertificates: string
  }
  assert.deepEqual(tls.ecdhCurves, ["X25519", "P-256", "P-384"])
  assert.equal(tls.sni, "mcp.example.test")
  assert.equal(tls.wellKnownCACertificates, "System")
  assert.equal("insecureSkipVerify" in tls, false)
  assert.equal("apiKey" in backendRef, false)
  assert.equal(JSON.stringify(backendRef).includes("authorization"), false)
  assert.equal(
    projection.resources.some(
      (candidate) => candidate.kind === "EnvoyExtensionPolicy" && candidate.metadata.name.includes("processing"),
    ),
    false,
  )

  for (const identityMode of ["USER_OAUTH", "USER_PASSWORD"] as const) {
  const oauthProjection = await projector(
    publicationSnapshot({
      publication_id: "publication-mcp-oauth-1",
      resource_id: "resource-mcp",
      capability_id: "mcp.invoke",
      policy_revision: 1,
      resource: mcpResource,
      publication_endpoint: mcpResource.publication_endpoint!,
      one_policy_chain: mcpChain,
      connections: [{
        ...mcpConnection,
        downstream_identity: { mode: identityMode },
      }] as never,
      models: [],
      model_mappings: [],
    }),
  ).compile({
    tenantId: "tenant-acme",
    value: { publication_id: "publication-mcp-oauth-1" },
  })
  const oauthRoute = oauthProjection.resources.find(
    (candidate) => candidate.kind === "MCPRoute",
  )!
  const oauthBackendRef = (oauthRoute.spec.backendRefs as Array<Record<string, unknown>>)[0]!
  assert.deepEqual(oauthBackendRef.forwardHeaders, [
    { name: "x-request-id" },
    {
      name: mcpOAuthHeaderName("connection-mcp"),
      backendHeader: "Authorization",
    },
  ])
  }
})

test("LLM routing keeps the request processor bridge when no PROCESS step exists", async () => {
  const chainWithoutProcessor = {
    ...chain,
    steps: chain.steps.filter((step) => step.kind !== "PROCESS"),
    request_filter_order: ["authz"],
    response_filter_order: [],
  } as CompiledEnforcementChain
  const projection = await projector(
    publicationSnapshot({ one_policy_chain: chainWithoutProcessor }),
  ).compile({ tenantId: "tenant-acme", value: request })
  const authorization = projection.resources.find(
    (resource) => resource.kind === "SecurityPolicy",
  )!
  const extAuth = authorization.spec.extAuth as Record<string, unknown>
  assert.equal(extAuth.headersToBackend, undefined)
  const processing = projection.resources.find(
    (resource) => resource.kind === "EnvoyExtensionPolicy",
  )!
  const lua = processing.spec.lua as Array<{ inline: string }>
  assert.equal(lua.length, 1)
  assert.equal(lua[0].inline.includes("/v1/process/request"), true)
  assert.equal(lua[0].inline.includes("envoy_on_response"), false)
  assert.equal(processing.metadata.annotations?.["genio.one/process-steps"], "")
})

test("projection mounts one processor bridge for the complete ordered process chain", async () => {
  const chainWithMultipleProcessors = {
    ...chain,
    request_filter_order: ["authz", "request-dlp", "token-vault"],
    response_filter_order: ["token-vault"],
    steps: [
      ...chain.steps.slice(0, 2),
      {
        step_id: "request-dlp",
        kind: "PROCESS",
        implementation: "PROCESSOR",
        hooks: {
          request: {
            action: "REDACT",
            config: { patterns: ["secret"] },
          },
        },
      },
      ...chain.steps.slice(2),
    ],
  } as CompiledEnforcementChain

  const projection = await projector(
    publicationSnapshot({ one_policy_chain: chainWithMultipleProcessors }),
  ).compile({ tenantId: "tenant-acme", value: request })
  const processing = projection.resources.find(
    (candidate) => candidate.kind === "EnvoyExtensionPolicy",
  )!
  const lua = processing.spec.lua as Array<{ type: string; inline: string }>

  assert.equal(lua.length, 1)
  assert.equal(lua[0].type, "Inline")
  assert.equal(lua[0].inline.includes("/v1/process/request"), true)
  assert.equal(lua[0].inline.includes("/v1/process/response"), false)
  assert.equal(processing.spec.extProc[0].messageTimeout, "35s")
  assert.equal(lua[0].inline.includes("    35000\n"), true)
  assert.deepEqual(processing.spec.extProc[0].processingMode, {
    allowModeOverride: true,
    request: {},
    response: { body: "Streamed" },
  })
  assert.equal(
    processing.metadata.annotations?.["genio.one/process-steps"],
    "request-dlp,token-vault",
  )
  const envoyProxy = projection.resources.find(
    (candidate) => candidate.kind === "EnvoyProxy",
  )!
  const accessLogJson = envoyProxy.spec.telemetry.accessLog.settings[0].format.json
  assert.equal(
    accessLogJson["genio.processor.request_steps"],
    "%DYNAMIC_METADATA(genio.one.processor:request_steps)%",
  )
  assert.equal(
    accessLogJson["genio.processor.data_classifications"],
    "%DYNAMIC_METADATA(genio.one.processor:data_classifications)%",
  )
  assert.equal(
    accessLogJson["genio.processor.safety_decisions"],
    "%DYNAMIC_METADATA(genio.one.processor:safety_decisions)%",
  )
})

test("response-only safety processing clears caller receipt handoff before ext_proc", async () => {
  const responseSafetyChain = {
    ...chain,
    request_filter_order: ["authz", "response-safety"],
    response_filter_order: ["response-safety"],
    steps: [
      ...chain.steps.slice(0, 2),
      {
        step_id: "response-safety",
        kind: "PROCESS",
        implementation: "PROCESSOR",
        hooks: {
          response: {
            action: "SAFETY_CHECK",
            config: {
              schema_version: 1,
              adapter_id: "semantic-safety",
              checks: [{ id: "policy", instructions: "Block unsafe content", threshold: 0.7 }],
              timeout_ms: 1_000,
            },
          },
        },
      },
      ...chain.steps.slice(3),
    ],
  } as CompiledEnforcementChain
  const projection = await projector(
    publicationSnapshot({
      one_policy_chain: responseSafetyChain,
      connections: (connections as Array<Record<string, unknown>>).map((connection) => ({
        ...connection,
        supported_obligations: [...connection.supported_obligations as string[], "SAFETY_CHECK"],
      })) as never,
    }),
  ).compile({ tenantId: "tenant-acme", value: request })
  const processing = projection.resources.find(
    (candidate) => candidate.kind === "EnvoyExtensionPolicy",
  )!
  const lua = (processing.spec.lua as Array<{ inline: string }>)[0]!.inline

  assert.equal(lua.includes("function envoy_on_request(handle)"), true)
  const receiptHeaderRemoval = lua.indexOf("handle:headers():remove(safety_decisions_header)")
  const requestBridge = lua.indexOf('/v1/process/request')
  assert.ok(receiptHeaderRemoval >= 0)
  assert.ok(requestBridge > receiptHeaderRemoval)
  assert.equal(processing.spec.extProc[0].processingMode.allowModeOverride, true)
})

test("projection accepts the versioned built-in processor pattern config", async () => {
  const configuredChain = {
    ...chain,
    steps: chain.steps.map((step) => step.kind === "PROCESS" ? {
      ...step,
      hooks: {
        request: {
          action: "TOKENIZE",
          config: {
            patterns: [{ name: "secret", expression: "secret", flags: "i" }],
            token_ttl_seconds: 600,
          },
        },
        response: {
          action: "RESTORE",
          config: {
            patterns: [{ name: "secret", expression: "secret", flags: "i" }],
            token_ttl_seconds: 600,
          },
        },
      },
    } : step),
  } as CompiledEnforcementChain
  const projection = await projector(
    publicationSnapshot({ one_policy_chain: configuredChain }),
  ).compile({ tenantId: "tenant-acme", value: request })

  const processStep = projection.policy_bundle.enforcement_chain.steps.find(
    (step) => step.kind === "PROCESS",
  )
  assert.equal(processStep?.kind, "PROCESS")
  assert.equal(processStep?.hooks.request?.config?.token_ttl_seconds, 600)

})

test("projection preserves Presidio and safety adapter policy config without credentials", async () => {
  const configuredChain = {
    ...chain,
    request_filter_order: ["authz", "token-vault", "safety"],
    response_filter_order: ["token-vault"],
    steps: [
      ...chain.steps.slice(0, 2),
      {
        ...chain.steps[2]!,
        hooks: {
          request: {
            action: "TOKENIZE",
            config: {
              patterns: [{ name: "PERSON", expression: "Ada Lovelace" }],
              token_ttl_seconds: 600,
              detector: {
                adapter_id: "presidio-primary",
                language: "en",
                entities: ["PERSON"],
                score_threshold: 0.5,
              },
            },
          },
          response: {
            action: "RESTORE",
            config: {
              patterns: [{ name: "PERSON", expression: "Ada Lovelace" }],
              token_ttl_seconds: 600,
            },
          },
        },
      },
      {
        step_id: "safety",
        kind: "PROCESS",
        implementation: "PROCESSOR",
        depends_on: ["token-vault"],
        hooks: {
          request: {
            action: "SAFETY_CHECK",
            config: {
              schema_version: 1,
              adapter_id: "jev-primary",
              checks: [{ id: "policy", instructions: "Block unsafe content", threshold: 0.7 }],
              timeout_ms: 1_000,
            },
          },
        },
      },
      {
        ...chain.steps[3]!,
        depends_on: ["safety"],
      },
    ],
  } as CompiledEnforcementChain
  const safetyConnections = (connections as Array<Record<string, unknown>>).map((connection) => ({
    ...connection,
    supported_obligations: [...connection.supported_obligations as string[], "SAFETY_CHECK"],
  }))

  const projection = await projector(
    publicationSnapshot({
      one_policy_chain: configuredChain,
      connections: safetyConnections as never,
    }),
  ).compile({ tenantId: "tenant-acme", value: request })
  const processorSteps = projection.policy_bundle.enforcement_chain.steps.filter(
    (step) => step.kind === "PROCESS",
  )
  assert.deepEqual(processorSteps[0]?.hooks.request?.config?.detector, {
    adapter_id: "presidio-primary",
    language: "en",
    entities: ["PERSON"],
    score_threshold: 0.5,
  })
  assert.deepEqual(processorSteps[1]?.hooks.request?.config, {
    schema_version: 1,
    adapter_id: "jev-primary",
    checks: [{ id: "policy", instructions: "Block unsafe content", threshold: 0.7 }],
    timeout_ms: 1_000,
  })

  const unsafeChain = {
    ...configuredChain,
    steps: configuredChain.steps.map((step) =>
      step.step_id === "token-vault"
        ? {
            ...step,
            hooks: {
              request: {
                action: "TOKENIZE",
                config: {
                  patterns: [{ name: "PERSON", expression: "Ada Lovelace" }],
                  token_ttl_seconds: 600,
                  detector: {
                    adapter_id: "presidio-primary",
                    language: "en",
                    entities: ["PERSON"],
                    score_threshold: 0.5,
                    credential_env: "must-not-ship",
                  },
                },
              },
              response: {
                action: "RESTORE",
                config: {
                  patterns: [{ name: "PERSON", expression: "Ada Lovelace" }],
                  token_ttl_seconds: 600,
                },
              },
            },
          }
        : step,
    ),
  } as unknown as CompiledEnforcementChain
  await assert.rejects(
    () => projector(
      publicationSnapshot({
        one_policy_chain: unsafeChain,
        connections: safetyConnections as never,
      }),
    ).compile({ tenantId: "tenant-acme", value: request }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "UNSAFE_POLICY_CONFIG_SECRET",
  )
})

test("projection preserves authorization obligations in the signed policy bundle", async () => {
  const configuredChain = {
    ...chain,
    steps: chain.steps.map((step) => step.kind === "AUTHORIZE" ? {
      ...step,
      config: { required_obligations: ["execution.confirmation"] },
    } : step),
  } as CompiledEnforcementChain

  const projection = await projector(
    publicationSnapshot({ one_policy_chain: configuredChain }),
  ).compile({ tenantId: "tenant-acme", value: request })
  const authorize = projection.policy_bundle.enforcement_chain.steps.find(
    (step) => step.kind === "AUTHORIZE",
  )

  assert.deepEqual(authorize?.config, {
    required_obligations: ["execution.confirmation"],
  })
})

test("projection fails closed when no Connection satisfies mandatory processing obligations", async () => {
  const unsupportedConnections = (connections as Array<Record<string, unknown>>).map((connection) => ({
    ...connection,
    supported_obligations: [],
  }))
  await assert.rejects(
    () => projector(publicationSnapshot({ connections: unsupportedConnections as never })).compile({
      tenantId: "tenant-acme",
      value: request,
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "CONNECTION_MANDATORY_OBLIGATION_UNSUPPORTED",
  )
})

test("projection rejects a structurally valid chain with stale derived filter order", async () => {
  const staleChain = {
    ...chain,
    request_filter_order: ["authz", "authn", "token-vault"],
  } as CompiledEnforcementChain

  await assert.rejects(
    () => projector(
      publicationSnapshot({ one_policy_chain: staleChain }),
    ).compile({ tenantId: "tenant-acme", value: request }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "ENFORCEMENT_REQUEST_FILTER_ORDER_INVALID",
  )
})

test("projection fails closed when a policy config contains secret-shaped data", async () => {
  const unsafeChain = {
      ...chain,
      steps: chain.steps.map((step) =>
        step.kind === "AUTHORIZE"
          ? { ...step, config: { api_key: "must-not-ship" } }
          : step,
      ),
    } as unknown as CompiledEnforcementChain
  await assert.rejects(
    () => projector(publicationSnapshot({ one_policy_chain: unsafeChain })).compile({ tenantId: "tenant-acme", value: request }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "UNSAFE_POLICY_CONFIG_SECRET",
  )
})

test("projection requires the versioned native JWT authentication config", async () => {
  const missingConfig = {
      ...chain,
      steps: chain.steps.map((step) =>
        step.kind === "AUTHENTICATE" ? { ...step, config: undefined } : step,
      ) as unknown as CompiledEnforcementChain["steps"],
    } as CompiledEnforcementChain
  await assert.rejects(
    () => projector(publicationSnapshot({ one_policy_chain: missingConfig })).compile({ tenantId: "tenant-acme", value: request }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "NATIVE_JWT_CONFIG_REQUIRED",
  )

  const invalidConfig = {
      ...chain,
      steps: chain.steps.map((step) =>
        step.kind === "AUTHENTICATE"
          ? {
              ...step,
              config: {
                ...step.config,
                schema_version: "genio.one.auth.jwt.v0",
              },
            }
          : step,
      ),
    } as unknown as CompiledEnforcementChain
  await assert.rejects(
    () => projector(publicationSnapshot({ one_policy_chain: invalidConfig })).compile({ tenantId: "tenant-acme", value: request }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "NATIVE_JWT_CONFIG_INVALID",
  )
})

test("projection rejects a chain from another tenant before emitting resources", async () => {
  const crossTenantChain = { ...chain, tenant_id: "tenant-other" }
  await assert.rejects(
    () => projector(publicationSnapshot({ one_policy_chain: crossTenantChain })).compile({ tenantId: "tenant-acme", value: request }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "ENFORCEMENT_TENANT_MISMATCH",
  )
})

test("projection rejects a Capability that is not owned by the Resource", async () => {
  await assert.rejects(
    () => projector(publicationSnapshot({ capability_id: "admin" })).compile({ tenantId: "tenant-acme", value: request }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "AI_GATEWAY_PUBLICATION_CAPABILITY_UNSUPPORTED",
  )
})

test("projection refuses to compile without a publication endpoint", async () => {
  await assert.rejects(
    () => projector(publicationSnapshot({ publication_endpoint: undefined as never })).compile({ tenantId: "tenant-acme", value: request }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "GATEWAY_PUBLICATION_ENDPOINT_REQUIRED",
  )
})

test("projection refuses a per-publication path that the native AI Gateway cannot represent", async () => {
  await assert.rejects(
    () => projector(publicationSnapshot(), "/api").compile({ tenantId: "tenant-acme", value: request }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "PUBLICATION_BASE_PATH_NOT_SUPPORTED_BY_AIGW",
  )
})

test("projection creation fails closed when an ephemeral signer is disabled", async () => {
  assert.throws(
    () =>
      createInMemoryGatewayProjector({
        source: { async getSnapshot() { return null } },
        allowEphemeralSigner: false,
      }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "GATEWAY_PROJECTION_SIGNER_REQUIRED",
  )
})

test("projection rejects a signer that does not return an Ed25519 signature", async () => {
  await assert.rejects(
    () => projector(publicationSnapshot(), "/v1", {
      signer: {
        algorithm: "Ed25519",
        keyId: "invalid-signature-fixture",
        sign: () => "not-an-ed25519-signature",
      },
    }).compile({ tenantId: "tenant-acme", value: request }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "GATEWAY_PROJECTION_SIGNATURE_FAILED",
  )
})
