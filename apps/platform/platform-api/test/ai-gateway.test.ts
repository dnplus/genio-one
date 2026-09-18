import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

async function createTestManagementApi() {
  const modules = createInMemoryPlatformModules()
  const reportPublicKeyPem = generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "pem" })
    .toString()
  await modules.runtimeControl.registerGatewayRuntime({
    tenantId: "tenant-acme",
    runtimeId: "gateway-local-runtime",
    targetId: "ai-gateway-local",
    oidcClientId: "gateway-local-client",
    reportKeyId: "gateway-local-report-key",
    reportPublicKeyPem,
  })
  await modules.gatewayAggregateRuntimeControl!.store.saveCapabilities({
    tenantId: "tenant-acme",
    runtimeId: "gateway-local-runtime",
    protocolVersions: ["genio.one.runtime.v1"],
    preferredProtocolVersion: "genio.one.runtime.v1",
    deliveryMode: "AGGREGATE_RELEASE",
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "test-token": {
        tenant_id: "tenant-acme",
        subject_id: "person-1",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: ["organization-commerce", "organization-ai"],
        client_id: "application-1",
      },
    }),
    entitlementResolver: modules.entitlements,
  })
  return { app, modules }
}

async function jsonResponse(
  app: Awaited<ReturnType<typeof createManagementApi>>,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
) {
  const response = (await app.inject({
    method,
    url,
    headers: { authorization: "Bearer test-token" },
    ...(body === undefined ? {} : { payload: body as object }),
  } as never)) as unknown as {
    statusCode: number
    body: string
    json: () => unknown
  }
  return { response, body: response.body ? (response.json() as any) : null }
}

const jwtAuthentication = {
  schema_version: "genio.one.auth.jwt.v1",
  provider: "keycloak",
  issuer: "https://identity.example.test/realms/acme",
  audiences: ["genio-one"],
  remote_jwks_uri:
    "https://identity.example.test/realms/acme/protocol/openid-connect/certs",
  subject_claim: "sub",
  client_claim: "azp",
}

function enforcementSteps() {
  return [
    {
      step_id: "authenticate",
      kind: "AUTHENTICATE",
      phase: "REQUEST",
      implementation: "NATIVE",
      config: jwtAuthentication,
    },
    {
      step_id: "authorize",
      kind: "AUTHORIZE",
      phase: "REQUEST",
      implementation: "EXT_AUTH",
      depends_on: ["authenticate"],
    },
    {
      step_id: "route",
      kind: "ROUTE",
      phase: "ROUTING",
      implementation: "AIGW_NATIVE",
      depends_on: ["authorize"],
    },
  ]
}

test("provider profiles preserve OpenAI, OMLX, and Ollama capability differences", { timeout: 30_000 }, async () => {
  const { app } = await createTestManagementApi()
  const result = await jsonResponse(
    app,
    "GET",
    "/v1/tenants/tenant-acme/providers/profiles",
  )
  assert.equal(result.response.statusCode, 200)
  const profiles = result.body as Array<{
    provider_type: string
    protocol: string
    capabilities: string[]
    credential_required: boolean
  }>
  const generic = profiles.find((profile) => profile.provider_type === "GENERIC_OPENAI_COMPATIBLE")
  const openAi = profiles.find((profile) => profile.provider_type === "OPENAI")
  const omlx = profiles.find((profile) => profile.provider_type === "OMLX")
  const ollama = profiles.find((profile) => profile.provider_type === "OLLAMA")
  assert.equal(generic?.protocol, "OPENAI_COMPATIBLE")
  assert.equal(generic?.credential_required, false)
  assert.deepEqual(generic?.capabilities, ["CHAT", "STREAMING"])
  assert.equal(openAi?.protocol, "OPENAI_COMPATIBLE")
  assert.equal(openAi?.credential_required, true)
  assert.ok(openAi?.capabilities.includes("REASONING"))
  assert.equal(omlx?.credential_required, false)
  assert.equal(ollama?.protocol, "OPENAI_COMPATIBLE")
  assert.ok(ollama?.capabilities.includes("EMBEDDINGS"))
  await app.close()
})

test("generic OpenAI-compatible Connection does not claim a known Provider identity", { timeout: 30_000 }, async () => {
  const { app } = await createTestManagementApi()
  const organizationResult = await jsonResponse(
    app,
    "POST",
    "/v1/tenants/tenant-acme/organizations",
    { display_name: "AI Platform", slug: "ai-platform" },
  )
  assert.equal(organizationResult.response.statusCode, 201)
  const organization = organizationResult.body as { organization_id: string }
  const resourceResult = await jsonResponse(
    app,
    "POST",
    "/v1/tenants/tenant-acme/resources",
    {
      display_name: "Compatible AI",
      kind: "LLM",
      owner_organization_id: organization.organization_id,
      authentication_strategy: "OAUTH",
      environment_id: "local",
      version: "1.0.0",
      capabilities: [{ capability_id: "chat", display_name: "Chat" }],
      enforcement_point_id: "ai-gateway-local",
    },
  )
  assert.equal(resourceResult.response.statusCode, 201)
  const resource = resourceResult.body as { resource_id: string }
  const connectionResult = await jsonResponse(
    app,
    "POST",
    `/v1/tenants/tenant-acme/resources/${resource.resource_id}/connections`,
    {
      display_name: "Compatible endpoint",
      provider_type: "GENERIC_OPENAI_COMPATIBLE",
      endpoint: "https://llm.example.test/v1",
    },
  )
  assert.equal(connectionResult.response.statusCode, 201, JSON.stringify(connectionResult.body))
  assert.equal(connectionResult.body.provider_type, "GENERIC_OPENAI_COMPATIBLE")
  assert.equal(connectionResult.body.provider_profile_id, "provider-generic-openai-compatible")
  await app.close()
})

test("AI Gateway vertical slice publishes only a signed immutable snapshot", { timeout: 30_000 }, async () => {
  const { app, modules } = await createTestManagementApi()

  const organizationResult = await jsonResponse(
    app,
    "POST",
    "/v1/tenants/tenant-acme/organizations",
    { display_name: "Commerce", slug: "commerce" },
  )
  assert.equal(organizationResult.response.statusCode, 201)
  const organization = organizationResult.body as { organization_id: string }

  const resourceResult = await jsonResponse(
    app,
    "POST",
    "/v1/tenants/tenant-acme/resources",
    {
      display_name: "Corporate AI",
      kind: "LLM",
      owner_organization_id: organization.organization_id,
      authentication_strategy: "OAUTH",
      environment_id: "local",
      version: "1.0.0",
      capabilities: [{ capability_id: "chat", display_name: "Chat" }],
      enforcement_point_id: "ai-gateway-local",
    },
  )
  assert.equal(resourceResult.response.statusCode, 201)
  const resource = resourceResult.body as { resource_id: string; lifecycle: string }
  assert.equal(resource.lifecycle, "DRAFT")

  const connectionResult = await jsonResponse(
    app,
    "POST",
    `/v1/tenants/tenant-acme/resources/${resource.resource_id}/connections`,
    {
      display_name: "Local Ollama",
      provider_type: "OLLAMA",
      endpoint: "http://127.0.0.1:11434",
    },
  )
  assert.equal(connectionResult.response.statusCode, 201)
  const connection = connectionResult.body as { connection_id: string }

  const verified = await jsonResponse(
    app,
    "POST",
    `/v1/tenants/tenant-acme/resources/${resource.resource_id}/connections/${connection.connection_id}/verify`,
  )
  assert.equal(verified.response.statusCode, 200, JSON.stringify(verified.body))
  assert.equal(verified.body.status, "READY")

  const modelResult = await jsonResponse(
    app,
    "POST",
    `/v1/tenants/tenant-acme/resources/${resource.resource_id}/models`,
    {
      model_name: "corporate-chat",
      display_name: "Corporate Chat",
      mappings: [
        {
          connection_id: connection.connection_id,
          provider_model: "llama3.2:3b",
        },
      ],
      capabilities: ["CHAT", "STREAMING", "TOOL_CALLING"],
      visibility: "PUBLIC",
    },
  )
  assert.equal(modelResult.response.statusCode, 201, JSON.stringify(modelResult.body))
  const model = modelResult.body as { model_id: string }

  const routingPolicy = await jsonResponse(
    app,
    "PUT",
    `/v1/tenants/tenant-acme/resources/${resource.resource_id}/capabilities/chat/model-routing-policy`,
    {
      routing_revision: 1,
      mode: "SESSION_LEASE",
      candidate_public_model_ids: [model.model_id],
      default_public_model_id: model.model_id,
      session_lease_seconds: 3_600,
    },
  )
  assert.equal(routingPolicy.response.statusCode, 200, JSON.stringify(routingPolicy.body))

  const chainResult = await jsonResponse(
    app,
    "POST",
    `/v1/tenants/tenant-acme/resources/${resource.resource_id}/capabilities/chat/enforcement-chain`,
    { one_policy_revision: 1, steps: enforcementSteps() },
  )
  assert.equal(chainResult.response.statusCode, 200, JSON.stringify(chainResult.body))
  assert.deepEqual(chainResult.body.chain.eligible_connection_ids, [
    connection.connection_id,
  ])

  const endpointResult = await jsonResponse(
    app,
    "PUT",
    `/v1/tenants/tenant-acme/resources/${resource.resource_id}/publication-endpoint`,
    {
      gateway_id: "ai-gateway-local",
      hostname: "ai.example.test",
      base_path: "/",
      visibility: "PUBLIC",
      dns_management: "PLATFORM_MANAGED",
      dns_verification: "VERIFIED",
    },
  )
  assert.equal(endpointResult.response.statusCode, 200, JSON.stringify(endpointResult.body))

  const grant = await jsonResponse(
    app,
    "POST",
    "/v1/tenants/tenant-acme/entitlements",
    {
      resource_id: resource.resource_id,
      subject_id: "person-1",
      client_id: "application-1",
      capability_id: "chat",
      public_model_id: model.model_id,
    },
  )
  assert.equal(grant.response.statusCode, 201, JSON.stringify(grant.body))

  const publicationResult = await jsonResponse(
    app,
    "POST",
    `/v1/tenants/tenant-acme/resources/${resource.resource_id}/publication-requests`,
    {},
  )
  assert.equal(
    publicationResult.response.statusCode,
    201,
    JSON.stringify(publicationResult.body),
  )
  const publication = publicationResult.body as {
    publication_id: string
    request_id: string
    state: string
    publication_state: string
  }
  assert.equal(publication.state, "PENDING")
  assert.equal(publication.publication_state, "PENDING_REVIEW")
  assert.ok(publication.publication_id)

  const pendingResource = await jsonResponse(
    app,
    "GET",
    `/v1/tenants/tenant-acme/resources/${resource.resource_id}`,
  )
  assert.equal(pendingResource.body.lifecycle, "DRAFT")

  const reviewed = await jsonResponse(
    app,
    "POST",
    `/v1/tenants/tenant-acme/resources/${resource.resource_id}/publication-requests/${publication.request_id}/review`,
    { decision: "APPROVE" },
  )
  assert.equal(reviewed.response.statusCode, 200, JSON.stringify(reviewed.body))
  assert.equal(reviewed.body.lifecycle, "PUBLISHED")
  assert.equal(reviewed.body.publication_request.publication_state, "READY")
  const commands = await modules.gatewayAggregateRuntimeControl!.store
    .listPendingGatewayReleaseCommands({
      tenantId: "tenant-acme",
      runtimeKind: "GATEWAY",
      runtimeId: "gateway-local-runtime",
    })
  assert.equal(commands.length, 1)
  const desiredRelease = commands[0]!.command.desired_release
  assert.equal(desiredRelease.projection_count, 1)
  const releasePackage = await modules.gatewayAggregateRuntimeControl!.packages.getPackage({
    tenantId: "tenant-acme",
    runtimeId: "gateway-local-runtime",
    releaseId: desiredRelease.release_id,
    headRevision: desiredRelease.head_revision,
  })
  assert.ok(releasePackage)
  assert.equal(releasePackage.projections.length, 1)

  const firstProjection = await jsonResponse(
    app,
    "POST",
    "/v1/tenants/tenant-acme/ai-gateway/projections",
    { publication_id: publication.publication_id },
  )
  const secondProjection = await jsonResponse(
    app,
    "POST",
    "/v1/tenants/tenant-acme/ai-gateway/projections",
    { publication_id: publication.publication_id },
  )
  assert.equal(firstProjection.response.statusCode, 200, JSON.stringify(firstProjection.body))
  assert.equal(secondProjection.response.statusCode, 200, JSON.stringify(secondProjection.body))
  assert.equal(firstProjection.body.digest, secondProjection.body.digest)
  assert.equal(firstProjection.body.signature.algorithm, "Ed25519")
  assert.equal(firstProjection.body.publication_id, publication.publication_id)
  const kinds = firstProjection.body.resources.map((entry: { kind: string }) => entry.kind)
  assert.ok(kinds.includes("AIGatewayRoute"))
  assert.ok(kinds.includes("SecurityPolicy"))

  const firstRoute = await jsonResponse(
    app,
    "POST",
    "/v1/tenants/tenant-acme/model-routing/resolve",
    {
      public_model_id: model.model_id,
      requested_public_model_id: model.model_id,
      session_id: "session-1",
      // Untrusted caller input is stripped and replaced by the resolver.
      entitled_public_model_ids: ["caller-injected-model"],
    },
  )
  const secondRoute = await jsonResponse(
    app,
    "POST",
    "/v1/tenants/tenant-acme/model-routing/resolve",
    {
      public_model_id: model.model_id,
      requested_public_model_id: model.model_id,
      session_id: "session-1",
    },
  )
  assert.equal(firstRoute.response.statusCode, 200, JSON.stringify(firstRoute.body))
  assert.equal(secondRoute.response.statusCode, 200, JSON.stringify(secondRoute.body))
  assert.equal(firstRoute.body.selected_public_model_id, model.model_id)
  assert.equal(firstRoute.body.provider_model, "llama3.2:3b")
  assert.equal(secondRoute.body.lease_id, firstRoute.body.lease_id)
  assert.equal(secondRoute.body.reused, true)

  const blockedUpdate = await jsonResponse(
    app,
    "PATCH",
    `/v1/tenants/tenant-acme/resources/${resource.resource_id}`,
    { display_name: "Should be immutable" },
  )
  assert.equal(blockedUpdate.response.statusCode, 409)

  const blockedConnectionDelete = await jsonResponse(
    app,
    "DELETE",
    `/v1/tenants/tenant-acme/resources/${resource.resource_id}/connections/${connection.connection_id}`,
  )
  assert.equal(blockedConnectionDelete.response.statusCode, 409)

  await app.close()
})
