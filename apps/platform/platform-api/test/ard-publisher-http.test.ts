import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"

import { createManagementApi } from "../src/app"
import {
  type ArdPublisher,
  ardPublisherConfigFromEnvironment,
  createArdPublisher,
} from "../src/capabilities/ard-publisher/module"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

const tenantId = "tenant-ard-http"
const resourceId = "ard-http-mcp"
const gatewayId = "ard-http-gateway"
const runtimeId = "ard-http-runtime"
const adminToken = "ard-http-admin-token"
const runtimeToken = "ard-http-runtime-token"
const publicOrigin = "https://ard.example.test"
const capabilityId = "mcp.invoke"
const privateDocumentation = "PRIVATE-DOCUMENT-ARD-HTTP"
const privateEndpoint = "https://upstream.example.test/private-mcp"
const privateCredentialRef = "private-credential-ard-http"

type JsonRecord = Record<string, any>

function json(value: unknown): string {
  return JSON.stringify(value)
}

async function request(
  origin: string,
  path: string,
  init: RequestInit = {},
  token: string | null = adminToken,
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (token) headers.set("authorization", `Bearer ${token}`)
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  return fetch(new URL(path, origin), { ...init, headers })
}

async function jsonRequest(
  origin: string,
  path: string,
  init: RequestInit = {},
  token: string | null = adminToken,
): Promise<{ response: Response; body: JsonRecord }> {
  const response = await request(origin, path, init, token)
  const body = await response.json() as JsonRecord
  return { response, body }
}

async function expectJson(
  origin: string,
  path: string,
  init: RequestInit = {},
  expectedStatus: number,
  token: string | null = adminToken,
): Promise<JsonRecord> {
  const result = await jsonRequest(origin, path, init, token)
  assert.equal(result.response.status, expectedStatus, json(result.body))
  return result.body
}

test("ARD publisher preserves public headers when a document lookup fails", async () => {
  const modules = createInMemoryPlatformModules()
  const publisher: ArdPublisher = {
    async manifest() {
      throw new Error("ARD_PUBLISHER_FAILURE")
    },
    async descriptor() {
      throw new Error("ARD_PUBLISHER_FAILURE")
    },
  }
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    ardPublisher: publisher,
    principalAuthenticator: createStaticPrincipalAuthenticator({}),
  })

  try {
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/.well-known/ard.json" }),
      app.inject({ method: "GET", url: "/.well-known/ard/mcp/resource/content" }),
    ])
    for (const response of responses) {
      assert.equal(response.statusCode, 500)
      assert.equal(response.headers["cache-control"], "no-store")
      assert.equal(response.headers["access-control-allow-origin"], "*")
      assert.equal(response.headers["access-control-expose-headers"], "ETag")
    }
  } finally {
    await app.close()
  }
})

test("ARD publisher serves an HTTP manifest and MCP card through publication withdrawal", { timeout: 30_000 }, async () => {
  const modules = createInMemoryPlatformModules()
  const organization = await modules.organizations.create({
    tenantId,
    display_name: "ARD HTTP Test",
    slug: "ard-http-test",
  })
  await modules.resources.createResource({
    tenantId,
    resourceId,
    value: {
      display_name: "ARD HTTP MCP",
      kind: "MCP",
      owner_organization_id: organization.organization_id,
      authentication_strategy: "OAUTH",
      environment_id: "test",
      version: "1.0.0",
      capabilities: [{ capability_id: capabilityId, display_name: "Invoke" }],
      enforcement_point_id: gatewayId,
    },
  })

  const runtimeKey = generateKeyPairSync("ed25519")
  await modules.runtimeControl.registerGatewayRuntime({
    tenantId,
    runtimeId,
    targetId: gatewayId,
    oidcClientId: runtimeId,
    reportKeyId: "ard-http-report-key",
    reportPublicKeyPem: runtimeKey.publicKey.export({ type: "spki", format: "pem" }).toString(),
  })
  await modules.gatewayAggregateRuntimeControl!.store.saveCapabilities({
    tenantId,
    runtimeId,
    protocolVersions: ["genio.one.runtime.v1"],
    preferredProtocolVersion: "genio.one.runtime.v1",
    deliveryMode: "AGGREGATE_RELEASE",
  })

  const config = ardPublisherConfigFromEnvironment({
    GENIO_ONE_ARD_PUBLISHER_JSON: json({
      tenant_id: tenantId,
      public_origin: publicOrigin,
      namespace: "genioone",
      resource_ids: [resourceId],
    }),
  })
  assert.ok(config)
  const publisher = createArdPublisher({
    config,
    resources: modules.resources,
    publications: modules.publicationWorkflow,
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    ardPublisher: publisher,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      [adminToken]: {
        tenant_id: tenantId,
        subject_id: "ard-http-admin",
        client_id: "ard-http-admin-client",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [organization.organization_id],
        scopes: ["genioone-management"],
      },
      [runtimeToken]: {
        tenant_id: tenantId,
        subject_id: "ard-http-runtime",
        client_id: runtimeId,
        role: "USER",
        organization_ids: [],
        scopes: ["genioone-gateway-runtime"],
      },
    }),
  })

  try {
    const localOrigin = new URL(await app.listen({ host: "127.0.0.1", port: 0 })).origin
    const resourcePath = `/v1/tenants/${tenantId}/resources/${resourceId}`
    const connectionPath = `${resourcePath}/connections`

    await expectJson(localOrigin, resourcePath, {
      method: "PATCH",
      body: json({ documentation: privateDocumentation }),
    }, 200)

    const connection = await expectJson(localOrigin, connectionPath, {
      method: "POST",
      body: json({
        display_name: "ARD HTTP private upstream",
        connection_kind: "MCP",
        endpoint: privateEndpoint,
        credential_ref: privateCredentialRef,
        downstream_identity: { mode: "SERVICE", authentication: "API_KEY" },
      }),
    }, 201)
    const connectionId = connection.connection_id as string
    const connectionItemPath = `${connectionPath}/${connectionId}`
    const verified = await expectJson(localOrigin, `${connectionItemPath}/verify`, { method: "POST" }, 200)
    assert.equal(verified.status, "READY")
    assert.equal(verified.lifecycle, "ENABLED")

    const discovery = await expectJson(localOrigin, `${connectionItemPath}/mcp-discovery`, {
      method: "POST",
      body: json({ correlation_id: "ard-http-discovery" }),
    }, 202)
    const operationId = discovery.operation_id as string
    const claimed = await expectJson(
      localOrigin,
      `/v1/tenants/${tenantId}/runtime-control/GATEWAY/${runtimeId}/operations/mcp-discovery/next`,
      {},
      200,
      runtimeToken,
    )
    assert.equal(claimed.operation_id, operationId)
    const completed = await expectJson(
      localOrigin,
      `/v1/tenants/${tenantId}/runtime-control/GATEWAY/${runtimeId}/operations/mcp-discovery/${operationId}/result`,
      {
        method: "POST",
        body: json({
          state: "SUCCEEDED",
          observation: {
            protocol_version: "2025-11-25",
            server_name: "private-upstream",
            server_version: "1.0.0",
            tools: [{ name: "search", title: "Search", description: "Private search" }],
          },
        }),
      },
      200,
      runtimeToken,
    )
    const candidate = (completed.candidates as JsonRecord[])[0]!
    await expectJson(localOrigin, `${connectionItemPath}/mcp-discovery/candidates/${candidate.candidate_id}/decision`, {
      method: "POST",
      body: json({ expected_revision_digest: candidate.revision_digest, state: "PUBLISHED" }),
    }, 200)

    await expectJson(localOrigin, `${resourcePath}/publication-endpoint`, {
      method: "PUT",
      body: json({
        gateway_id: gatewayId,
        hostname: "mcp.example.test",
        base_path: "/approved-mcp",
        visibility: "PUBLIC",
        dns_management: "EXTERNAL",
        dns_verification: "VERIFIED",
        dns_target: null,
      }),
    }, 200)

    const definition = {
      one_policy_revision: 1,
      eligible_connection_ids: [connectionId],
      steps: [
        {
          step_id: "authenticate",
          kind: "AUTHENTICATE",
          phase: "REQUEST",
          implementation: "NATIVE",
          depends_on: [],
          config: {
            schema_version: "genio.one.auth.jwt.v1",
            provider: "ard-http-identity",
            issuer: "https://identity.example.test",
            audiences: ["genio-one"],
            remote_jwks_uri: "https://identity.example.test/jwks",
            subject_claim: "sub",
            client_claim: "azp",
          },
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
      ],
    }
    const policyPath = `${resourcePath}/capabilities/${capabilityId}/policy-draft`
    const savedDraft = await expectJson(localOrigin, policyPath, {
      method: "PUT",
      body: json({
        expected_version: 0,
        base_revision: 0,
        content: { kind: "RESOURCE_CAPABILITY", definition },
      }),
    }, 200)
    const validatedDraft = await expectJson(localOrigin, `${policyPath}/validate`, {
      method: "POST",
      body: json({ expected_version: savedDraft.version, expected_content_digest: savedDraft.content_digest }),
    }, 200)
    const reviewedDraft = await expectJson(localOrigin, `${policyPath}/review`, {
      method: "POST",
      body: json({ expected_version: validatedDraft.version, expected_content_digest: validatedDraft.content_digest }),
    }, 200)
    const publishedChain = await expectJson(localOrigin, `${policyPath}/publish`, {
      method: "POST",
      body: json({ expected_version: reviewedDraft.version, expected_content_digest: reviewedDraft.content_digest }),
    }, 200)
    assert.equal(publishedChain.one_policy_revision, 1)
    assert.deepEqual(publishedChain.chain.eligible_connection_ids, [connectionId])

    const publication = await expectJson(localOrigin, `${resourcePath}/publication-requests`, {
      method: "POST",
      body: json({}),
    }, 201)
    assert.equal(publication.state, "PENDING")
    assert.equal(publication.publication_state, "PENDING_REVIEW")
    const reviewed = await expectJson(localOrigin, `${resourcePath}/publication-requests/${publication.request_id}/review`, {
      method: "POST",
      body: json({ decision: "APPROVE" }),
    }, 200)
    assert.equal(reviewed.lifecycle, "PUBLISHED")
    assert.equal(reviewed.publication_request.publication_state, "READY")

    const projection = await expectJson(localOrigin, `/v1/tenants/${tenantId}/ai-gateway/projections`, {
      method: "POST",
      body: json({ publication_id: publication.publication_id }),
    }, 200)
    assert.equal(projection.signature.algorithm, "Ed25519")
    assert.equal(projection.publication_id, publication.publication_id)

    const anonymousManagement = await request(localOrigin, `/v1/tenants/${tenantId}/resources`, {}, null)
    assert.equal(anonymousManagement.status, 401)

    const manifestResponse = await request(localOrigin, "/.well-known/ard.json", {}, null)
    assert.equal(manifestResponse.status, 200)
    assert.equal(manifestResponse.headers.get("cache-control"), "no-store")
    assert.equal(manifestResponse.headers.get("access-control-allow-origin"), "*")
    assert.equal(manifestResponse.headers.get("access-control-expose-headers"), "ETag")
    const manifest = await manifestResponse.json() as { entries: Array<JsonRecord> }
    assert.equal(manifest.entries.length, 1)
    const entry = manifest.entries[0]!
    assert.deepEqual(Object.keys(entry).sort(), ["displayName", "identifier", "type", "url"])
    assert.equal(entry.displayName, "ARD HTTP MCP")
    assert.equal(entry.identifier.toString().startsWith("urn:air:ard.example.test:genioone:resource-"), true)
    assert.match(entry.identifier.toString(), /^urn:air:ard\.example\.test:genioone:resource-[a-f0-9]{64}$/)
    assert.equal(entry.type, "application/mcp-server-card+json")
    const entryUrl = new URL(entry.url.toString())
    assert.equal(entryUrl.origin, publicOrigin)
    assert.match(entryUrl.pathname, /^\/.well-known\/ard\/mcp\/[a-f0-9]{64}\/[a-f0-9]{64}$/)
    const initialEtag = manifestResponse.headers.get("etag")
    assert.ok(initialEtag)

    const cardResponse = await request(localOrigin, entryUrl.pathname, {}, null)
    assert.equal(cardResponse.status, 200)
    assert.match(cardResponse.headers.get("content-type") ?? "", /^application\/mcp-server-card\+json/)
    const card = await cardResponse.json() as JsonRecord
    assert.deepEqual(Object.keys(card).sort(), ["$schema", "description", "name", "remotes", "version"])
    assert.equal(card.$schema, "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json")
    assert.match(card.name, /^test\.example\.ard\/genioone-[a-f0-9]{64}$/)
    assert.equal(card.version, "1.0.0")
    assert.equal(card.description, "GenioOne MCP server")
    assert.deepEqual(card.remotes, [{ type: "streamable-http", url: "https://mcp.example.test/approved-mcp" }])
    const cardEtag = cardResponse.headers.get("etag")
    assert.ok(cardEtag)
    for (const body of [manifest, card]) {
      const serialized = JSON.stringify(body)
      assert.equal(serialized.includes(privateEndpoint), false)
      assert.equal(serialized.includes(privateCredentialRef), false)
      assert.equal(serialized.includes(privateDocumentation), false)
    }

    const withdrawn = await expectJson(localOrigin, `${resourcePath}/lifecycle`, {
      method: "POST",
      body: json({ lifecycle: "DEPRECATED" }),
    }, 200)
    assert.equal(withdrawn.lifecycle, "DEPRECATED")
    const withdrawnManifestResponse = await request(localOrigin, "/.well-known/ard.json", {
      headers: { "if-none-match": initialEtag },
    }, null)
    assert.equal(withdrawnManifestResponse.status, 200)
    assert.notEqual(withdrawnManifestResponse.headers.get("etag"), initialEtag)
    assert.deepEqual(await withdrawnManifestResponse.json(), { entries: [] })
    const withdrawnCardResponse = await request(localOrigin, entryUrl.pathname, {
      headers: { "if-none-match": cardEtag },
    }, null)
    assert.equal(withdrawnCardResponse.status, 404)
    assert.equal(withdrawnCardResponse.headers.get("cache-control"), "no-store")
  } finally {
    await app.close()
  }
})
