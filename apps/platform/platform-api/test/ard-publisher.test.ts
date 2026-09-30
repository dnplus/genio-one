import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

import { createManagementApi } from "../src/app"
import {
  ardPublisherConfigFromEnvironment,
  createArdPublisher,
  type ArdPublisher,
} from "../src/capabilities/ard-publisher/module"
import { PlatformApiError } from "../src/capabilities/errors"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import type { GatewayProjectionSnapshot } from "../src/capabilities/gateway-projection/contract"
import type { AiResourcePublicationWorkflow } from "../src/capabilities/publications/module"
import type { ResourceRegistration } from "../src/capabilities/resources/contract"
import type { ResourceCatalog } from "../src/capabilities/resources/module"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

const tenantId = "tenant-ard"
const publicOrigin = "https://ard.example.test"

async function schemaValidators() {
  const [ardSchemaText, cardSchemaText] = await Promise.all([
    readFile(new URL("./fixtures/ard-publisher/ard-entry.schema.json", import.meta.url), "utf8"),
    readFile(new URL("./fixtures/ard-publisher/mcp-server-card.schema.json", import.meta.url), "utf8"),
  ])
  const ardSchema = JSON.parse(ardSchemaText) as { $id: string }
  const cardSchema = JSON.parse(cardSchemaText) as object
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv)
  ajv.addSchema(ardSchema)
  ajv.addSchema(cardSchema, "mcp-server-card")
  const validateManifest = ajv.getSchema(`${ardSchema.$id}#/$defs/ArdManifest`)
  const validateCard = ajv.getSchema("mcp-server-card#/$defs/ServerCard")
  assert.ok(validateManifest)
  assert.ok(validateCard)
  return { validateManifest, validateCard }
}

function descriptorKeyFromUrl(value: string): string {
  const parts = new URL(value).pathname.split("/").filter(Boolean)
  return `${parts.at(-2)!}.${parts.at(-1)!}`
}

function config(resourceIds: string[]) {
  return ardPublisherConfigFromEnvironment({
    GENIO_ONE_ARD_PUBLISHER_JSON: JSON.stringify({
      tenant_id: tenantId,
      public_origin: publicOrigin,
      namespace: "genioone",
      resource_ids: resourceIds,
    }),
  })!
}

function resource(input: {
  resourceId: string
  tenant?: string
  kind?: ResourceRegistration["kind"]
  lifecycle?: ResourceRegistration["lifecycle"]
  displayName?: string
  operationalState?: ResourceRegistration["operational_state"]
}): ResourceRegistration {
  return {
    tenant_id: input.tenant ?? tenantId,
    resource_id: input.resourceId,
    documentation: "private documentation must never be published",
    display_name: input.displayName ?? "Current resource name",
    kind: input.kind ?? "MCP",
    owner_organization_id: "org-ard",
    authentication_strategy: "OAUTH",
    environment_id: "production",
    version: "99.99.99",
    lifecycle: input.lifecycle ?? "PUBLISHED",
    publication_endpoint: null,
    publication_request: null,
    operational_state: input.operationalState ?? "DEGRADED",
    capabilities: [{ capability_id: "mcp.invoke", display_name: "Private capability" }],
    api: null,
    extension_metadata: null,
    enforcement_point_id: "gateway-ard",
    created_at: 1,
  } as ResourceRegistration
}

function snapshot(input: {
  resourceId: string
  tenant?: string
  kind?: ResourceRegistration["kind"]
  visibility?: "PRIVATE" | "REQUEST" | "PUBLIC"
  hostname?: string
  basePath?: string
  displayName?: string
  version?: string
}): GatewayProjectionSnapshot {
  const resourceId = input.resourceId
  return {
    tenant_id: input.tenant ?? tenantId,
    publication_id: `publication-${resourceId}`,
    request_id: `request-${resourceId}`,
    resource_id: resourceId,
    capability_id: "mcp.invoke",
    endpoint_revision: 1,
    resource_revision: 1,
    policy_revision: 1,
    resource_digest: "a".repeat(64),
    snapshot_digest: "b".repeat(64),
    resource: {
      tenant_id: input.tenant ?? tenantId,
      resource_id: resourceId,
      documentation: "private documentation must never be published",
      display_name: input.displayName ?? "Reviewed MCP resource",
      kind: input.kind ?? "MCP",
      owner_organization_id: "org-ard",
      authentication_strategy: "OAUTH",
      environment_id: "production",
      version: input.version ?? "1.2.3",
      lifecycle: "DRAFT",
      publication_endpoint: null,
      publication_request: null,
      operational_state: "UNKNOWN",
      capabilities: [{ capability_id: "mcp.invoke", display_name: "Private capability" }],
      api: null,
      extension_metadata: null,
      enforcement_point_id: "gateway-ard",
      created_at: 1,
    },
    publication_endpoint: {
      gateway_id: "gateway-ard",
      hostname: input.hostname ?? "mcp.example.test",
      base_path: input.basePath ?? "/approved-mcp",
      visibility: input.visibility ?? "PUBLIC",
      dns_management: "EXTERNAL",
      dns_verification: "VERIFIED",
      dns_target: null,
    },
    one_policy_chain: {},
    connections: [{ endpoint: "http://10.0.0.7/private-mcp", credential_ref: "secret-credential" }],
    models: [],
    model_mappings: [],
  } as unknown as GatewayProjectionSnapshot
}

function publisherFixture(extraCatalogResources = 0) {
  const resources = [
    resource({ resourceId: "approved", displayName: "Current unpublished mutation" }),
    resource({ resourceId: "not-opted-in" }),
    resource({ resourceId: "wrong-kind", kind: "LLM" }),
    resource({ resourceId: "wrong-tenant", tenant: "tenant-other" }),
    resource({ resourceId: "request-only" }),
  ]
  for (let index = 0; index < extraCatalogResources; index += 1) {
    resources.push(resource({ resourceId: `catalog-resource-${index}` }))
  }
  const snapshots = new Map<string, GatewayProjectionSnapshot>([
    ["approved", snapshot({ resourceId: "approved" })],
    ["not-opted-in", snapshot({ resourceId: "not-opted-in" })],
    ["wrong-kind", snapshot({ resourceId: "wrong-kind", kind: "LLM" })],
    ["wrong-tenant", snapshot({ resourceId: "wrong-tenant", tenant: "tenant-other" })],
    ["request-only", snapshot({ resourceId: "request-only", visibility: "REQUEST" })],
  ])
  const calls = { listResources: 0, getResource: 0, getPublishedSnapshot: 0 }
  let listResourcesFailure: Error | null = null
  let getResourceFailure: Error | null = null
  const catalog: ResourceCatalog = {
    async listResources() {
      calls.listResources += 1
      if (listResourcesFailure) throw listResourcesFailure
      return resources
    },
    async getResource({ resourceId }) {
      calls.getResource += 1
      if (getResourceFailure) throw getResourceFailure
      const found = resources.find((candidate) => candidate.resource_id === resourceId)
      if (!found) throw new PlatformApiError("RESOURCE_NOT_FOUND", 404)
      return found
    },
  }
  const publications: Pick<AiResourcePublicationWorkflow, "getPublishedSnapshot"> = {
    async getPublishedSnapshot({ resourceId }) {
      calls.getPublishedSnapshot += 1
      return snapshots.get(resourceId) ?? null
    },
  }
  return {
    publisher: createArdPublisher({
      config: config(["approved", "wrong-kind", "wrong-tenant", "request-only"]),
      resources: catalog,
      publications,
    }),
    snapshots,
    resources,
    calls,
    resetCalls() {
      calls.listResources = 0
      calls.getResource = 0
      calls.getPublishedSnapshot = 0
    },
    setListResourcesFailure(value: Error | null) {
      listResourcesFailure = value
    },
    setGetResourceFailure(value: Error | null) {
      getResourceFailure = value
    },
  }
}

async function appWithPublisher(publisher?: ArdPublisher) {
  const modules = createInMemoryPlatformModules()
  return createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({}),
    ...(publisher ? { ardPublisher: publisher } : {}),
  })
}

test("ARD publisher is default-off and invalid configuration fails before API startup", async () => {
  const app = await appWithPublisher()
  const missing = await app.inject({ method: "GET", url: "/.well-known/ard.json" })
  assert.equal(missing.statusCode, 404)
  await app.close()

  assert.equal(ardPublisherConfigFromEnvironment({}), undefined)
  assert.equal(ardPublisherConfigFromEnvironment({ GENIO_ONE_ARD_PUBLISHER_JSON: "" }), undefined)
  assert.throws(
    () => ardPublisherConfigFromEnvironment({
      GENIO_ONE_ARD_PUBLISHER_JSON: JSON.stringify({
        tenant_id: tenantId,
        public_origin: "http://ard.example.test",
        namespace: "genioone",
        resource_ids: [],
      }),
    }),
    /HTTPS FQDN origin/,
  )
  assert.throws(
    () => ardPublisherConfigFromEnvironment({
      GENIO_ONE_ARD_PUBLISHER_JSON: JSON.stringify({
        tenant_id: tenantId,
        public_origin: publicOrigin,
        namespace: "genioone",
        resource_ids: ["approved", "approved"],
      }),
    }),
    /must be unique/,
  )
})

test("ARD publisher projects only opted-in approved MCP snapshots without sensitive fields", async () => {
  const fixture = publisherFixture()
  const app = await appWithPublisher(fixture.publisher)
  const manifestResponse = await app.inject({ method: "GET", url: "/.well-known/ard.json" })
  assert.equal(manifestResponse.statusCode, 200)
  assert.equal(manifestResponse.headers["cache-control"], "no-store")
  assert.equal(manifestResponse.headers["access-control-allow-origin"], "*")
  assert.equal(manifestResponse.headers["access-control-expose-headers"], "ETag")
  const preflight = await app.inject({ method: "OPTIONS", url: "/.well-known/ard.json" })
  assert.equal(preflight.statusCode, 204)
  assert.equal(preflight.headers["access-control-allow-methods"], "GET, HEAD, OPTIONS")
  assert.equal(preflight.headers["access-control-allow-headers"], "If-None-Match, Content-Type")
  const manifest = manifestResponse.json() as { entries: Array<{ identifier: string; displayName: string; type: string; url: string }> }
  assert.equal(manifest.entries.length, 1)
  const entry = manifest.entries[0]!
  assert.match(entry.identifier, /^urn:air:ard\.example\.test:genioone:resource-[a-f0-9]{64}$/)
  assert.equal(entry.displayName, "Reviewed MCP resource")
  assert.equal(entry.type, "application/mcp-server-card+json")
  assert.equal(entry.url.startsWith(`${publicOrigin}/.well-known/ard/mcp/`), true)
  assert.equal(JSON.stringify(manifest).includes("private documentation"), false)
  assert.equal(JSON.stringify(manifest).includes("secret-credential"), false)
  assert.equal(JSON.stringify(manifest).includes("10.0.0.7"), false)

  const cardResponse = await app.inject({ method: "GET", url: new URL(entry.url).pathname })
  assert.equal(cardResponse.statusCode, 200)
  assert.match(cardResponse.headers["content-type"] ?? "", /^application\/mcp-server-card\+json/)
  const card = cardResponse.json() as {
    $schema: string
    name: string
    version: string
    description: string
    remotes: Array<{ type: string; url: string }>
  }
  assert.equal(card.$schema, "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json")
  assert.match(card.name, /^test\.example\.ard\/genioone-[a-f0-9]{64}$/)
  assert.equal(card.version, "1.2.3")
  assert.equal(card.description, "GenioOne MCP server")
  assert.deepEqual(card.remotes, [{ type: "streamable-http", url: "https://mcp.example.test/approved-mcp" }])
  assert.equal(JSON.stringify(card).includes("private documentation"), false)
  assert.equal(JSON.stringify(card).includes("secret-credential"), false)
  assert.equal(JSON.stringify(card).includes("10.0.0.7"), false)
  const { validateManifest, validateCard } = await schemaValidators()
  assert.equal(validateManifest(manifest), true, JSON.stringify(validateManifest.errors))
  assert.equal(validateCard(card), true, JSON.stringify(validateCard.errors))
  await app.close()
})

test("ARD public routes remain anonymous while management tenant routes remain authenticated", async () => {
  const fixture = publisherFixture()
  const app = await appWithPublisher(fixture.publisher)
  const anonymousManifest = await app.inject({ method: "GET", url: "/.well-known/ard.json" })
  assert.equal(anonymousManifest.statusCode, 200)
  const protectedRoute = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/resources` })
  assert.equal(protectedRoute.statusCode, 401)
  await app.close()
})

test("ARD withdrawal changes ETag and immediately removes the old descriptor", async () => {
  const fixture = publisherFixture()
  const app = await appWithPublisher(fixture.publisher)
  const initial = await app.inject({ method: "GET", url: "/.well-known/ard.json" })
  assert.equal(initial.statusCode, 200)
  const initialEtag = initial.headers.etag
  assert.ok(initialEtag)
  const entry = (initial.json() as { entries: Array<{ url: string }> }).entries[0]!
  fixture.snapshots.delete("approved")

  const withdrawn = await app.inject({
    method: "GET",
    url: "/.well-known/ard.json",
    headers: { "if-none-match": initialEtag },
  })
  assert.equal(withdrawn.statusCode, 200)
  assert.notEqual(withdrawn.headers.etag, initialEtag)
  assert.deepEqual(withdrawn.json(), { entries: [] })
  const descriptor = await app.inject({ method: "GET", url: new URL(entry.url).pathname })
  assert.equal(descriptor.statusCode, 404)
  assert.equal(descriptor.headers["cache-control"], "no-store")
  const revalidated = await app.inject({
    method: "GET",
    url: "/.well-known/ard.json",
    headers: { "if-none-match": withdrawn.headers.etag! },
  })
  assert.equal(revalidated.statusCode, 304)
  await app.close()
})

test("ARD descriptor content changes its URL and invalidates the manifest ETag", async () => {
  const fixture = publisherFixture()
  const app = await appWithPublisher(fixture.publisher)
  const initial = await app.inject({ method: "GET", url: "/.well-known/ard.json" })
  assert.equal(initial.statusCode, 200)
  const initialEtag = initial.headers.etag!
  const initialEntry = (initial.json() as { entries: Array<{ url: string; identifier: string }> }).entries[0]!
  fixture.snapshots.set("approved", snapshot({ resourceId: "approved", version: "1.2.4" }))

  const changed = await app.inject({
    method: "GET",
    url: "/.well-known/ard.json",
    headers: { "if-none-match": initialEtag },
  })
  assert.equal(changed.statusCode, 200)
  assert.notEqual(changed.headers.etag, initialEtag)
  const changedEntry = (changed.json() as { entries: Array<{ url: string; identifier: string }> }).entries[0]!
  assert.equal(changedEntry.identifier, initialEntry.identifier)
  assert.notEqual(changedEntry.url, initialEntry.url)
  const oldCard = await app.inject({ method: "GET", url: new URL(initialEntry.url).pathname })
  assert.equal(oldCard.statusCode, 404)
  await app.close()
})

test("ARD descriptor lookup uses only the addressed allowlisted Resource", async () => {
  const fixture = publisherFixture(2_000)
  const manifest = await fixture.publisher.manifest()
  assert.equal(fixture.calls.listResources, 0)
  const entry = (manifest.body as { entries: Array<{ url: string }> }).entries[0]!
  const descriptorKey = descriptorKeyFromUrl(entry.url)
  assert.match(descriptorKey, /^[a-f0-9]{64}\.[a-f0-9]{64}$/)
  fixture.resetCalls()
  fixture.setListResourcesFailure(new Error("descriptor must not enumerate the catalog"))

  for (const value of ["malformed", `${"0".repeat(64)}.${"1".repeat(64)}`]) {
    assert.equal(await fixture.publisher.descriptor({ descriptorKey: value }), null)
    assert.deepEqual(fixture.calls, {
      listResources: 0,
      getResource: 0,
      getPublishedSnapshot: 0,
    })
  }

  const descriptor = await fixture.publisher.descriptor({ descriptorKey })
  assert.equal(descriptor?.contentType, "application/mcp-server-card+json; charset=utf-8")
  assert.deepEqual(fixture.calls, {
    listResources: 0,
    getResource: 1,
    getPublishedSnapshot: 1,
  })
})

test("ARD descriptor rejects stale, withdrawn, and missing targets without masking store errors", async () => {
  const fixture = publisherFixture()
  const initial = await fixture.publisher.manifest()
  const entry = (initial.body as { entries: Array<{ url: string }> }).entries[0]!
  const descriptorKey = descriptorKeyFromUrl(entry.url)

  fixture.snapshots.set("approved", snapshot({ resourceId: "approved", version: "1.2.4" }))
  fixture.resetCalls()
  assert.equal(await fixture.publisher.descriptor({ descriptorKey }), null)
  assert.deepEqual(fixture.calls, {
    listResources: 0,
    getResource: 1,
    getPublishedSnapshot: 1,
  })

  fixture.snapshots.delete("approved")
  fixture.resetCalls()
  assert.equal(await fixture.publisher.descriptor({ descriptorKey }), null)
  assert.deepEqual(fixture.calls, {
    listResources: 0,
    getResource: 1,
    getPublishedSnapshot: 1,
  })

  const missingFixture = publisherFixture()
  const missingManifest = await missingFixture.publisher.manifest()
  const missingEntry = (missingManifest.body as { entries: Array<{ url: string }> }).entries[0]!
  missingFixture.resources.splice(
    missingFixture.resources.findIndex((candidate) => candidate.resource_id === "approved"),
    1,
  )
  missingFixture.resetCalls()
  const app = await appWithPublisher(missingFixture.publisher)
  const missing = await app.inject({ method: "GET", url: new URL(missingEntry.url).pathname })
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(missingFixture.calls, {
    listResources: 0,
    getResource: 1,
    getPublishedSnapshot: 0,
  })
  await app.close()

  const failureFixture = publisherFixture()
  const failureManifest = await failureFixture.publisher.manifest()
  const failureEntry = (failureManifest.body as { entries: Array<{ url: string }> }).entries[0]!
  const failure = new PlatformApiError("RESOURCE_STORE_UNAVAILABLE", 503)
  failureFixture.setGetResourceFailure(failure)
  await assert.rejects(
    failureFixture.publisher.descriptor({
      descriptorKey: descriptorKeyFromUrl(failureEntry.url),
    }),
    (error: unknown) => error === failure,
  )
})
