import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import type { ListResourcesInput, ResourceCatalog } from "../src/capabilities/resources/module"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import { resourceCreateFromOpenApi } from "../src/capabilities/resources/openapi"
import { createInMemoryResourceRegistry } from "../src/capabilities/resources/memory"
import { createResourceMemoryState } from "../src/capabilities/resources/state"

const resource = {
  tenant_id: "tenant-acme",
  resource_id: "resource-orders",
  display_name: "Orders API",
  kind: "API" as const,
  owner_organization_id: "organization-commerce",
  registered_by_subject_id: "person-owner",
  authentication_strategy: "OAUTH" as const,
  environment_id: "production",
  version: "1.0.0",
  lifecycle: "DRAFT" as const,
  operational_state: "HEALTHY" as const,
  capabilities: [{ capability_id: "list-orders", display_name: "List orders" }],
  enforcement_point_id: "api-gateway",
  created_at: 1_777_777_777,
}

test("Resources module exposes its validated route in OpenAPI", async () => {
  const inputs: ListResourcesInput[] = []
  const catalog: ResourceCatalog = {
    async listResources(input) {
      inputs.push(input)
      return [resource]
    },
    async getResource() {
      return resource
    },
  }
  const app = await createManagementApi({
    modules: createInMemoryPlatformModules(),
    resourceCatalog: catalog,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "test-token": {
        tenant_id: "tenant-acme",
        subject_id: "person-owner",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
        client_id: "application-1",
      },
    }),
  })

  const response = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/resources",
    headers: { authorization: "Bearer test-token" },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), [resource])
  assert.deepEqual(inputs, [
    { tenantId: "tenant-acme", authorization: "Bearer test-token" },
  ])

  const specification = await app.inject({ method: "GET", url: "/openapi.json" })
  assert.equal(specification.statusCode, 200)
  assert.equal(
    specification.json().paths["/v1/tenants/{tenant_id}/resources"].get.operationId,
    "listResources",
  )

  await app.close()
})

test("OpenAPI imports preserve searchable header and query parameters", () => {
  const input = resourceCreateFromOpenApi({
    document: {
      openapi: "3.1.0",
      info: { title: "Incident API", version: "1.0.0" },
      paths: {
        "/incidents": {
          parameters: [
            { in: "header", name: "x-api-version" },
            { in: "query", name: "locale" },
          ],
          get: {
            operationId: "incident.list",
            parameters: [
              { in: "header", name: "X-API-Version" },
              { in: "path", name: "incident_id" },
            ],
          },
        },
      },
    },
    owner_organization_id: "organization-platform",
    authentication_strategy: "OAUTH",
    environment_id: "development",
    version: "1.0.0",
    public_path: "/internal-api",
    inbound_security: { type: "KEYLESS" },
    request_schema_validation: false,
    enforcement_point_id: "api-gateway",
    a2a: {
      protocol_version: "1.0",
      operation: "SEND_MESSAGE",
      target_agent_subject_id: "agent-target",
    },
  })

  assert.deepEqual(input.api?.operations, [{
    operation_id: "incident.list",
    method: "GET",
    path: "/incidents",
    parameters: [
      { location: "HEADER", name: "X-API-Version" },
      { location: "QUERY", name: "locale" },
    ],
  }])
  assert.deepEqual(input.api?.a2a, {
    protocol_version: "1.0",
    operation: "SEND_MESSAGE",
    target_agent_subject_id: "agent-target",
  })
})

test("Bot packages use the existing EXTENSION Resource contract", async () => {
  const modules = createInMemoryPlatformModules()
  const organization = await modules.organizations.create({
    tenantId: "tenant-acme",
    display_name: "Platform",
  })
  const created = await modules.resources.createResource({
    tenantId: "tenant-acme",
    value: {
      display_name: "Service Desk Bot",
      kind: "EXTENSION",
      owner_organization_id: organization.organization_id,
      authentication_strategy: "NONE",
      environment_id: "development",
      version: "1.0.0",
      capabilities: [{ capability_id: "bot.invoke", display_name: "Invoke Bot" }],
      enforcement_point_id: "genio-agent-runtime",
      extension_metadata: {
        package_type: "BOT",
        profile: { title: "Service Desk Bot", description: "Read ServiceNow cases", avatar: {} },
        skills: [{ id: "servicenow-csm", path: "skills/servicenow-csm" }],
        plugins: [],
        resource_bindings: [{ resource_id: "servicenow-csm", capability_id: "servicenow.csm.read_case" }],
        default_runtime_tier: "none",
        manifest_digest: "manifest-1",
        artifact_digest: "artifact-1",
        source: { kind: "FIXTURE", ref: "fixture@1.0.0" },
      },
    },
  })
  assert.equal(created.kind, "EXTENSION")
  assert.equal(created.extension_metadata?.package_type, "BOT")
  assert.equal(created.extension_metadata?.resource_id, created.resource_id)

  const published = await modules.resources.setLifecycle({
    tenantId: "tenant-acme",
    resourceId: created.resource_id,
    lifecycle: "PUBLISHED",
  })
  assert.equal(published.lifecycle, "PUBLISHED")

  await assert.rejects(
    modules.resources.createResource({
      tenantId: "tenant-acme",
      value: {
        display_name: "Invalid MCP with metadata",
        kind: "MCP",
        owner_organization_id: organization.organization_id,
        authentication_strategy: "NONE",
        environment_id: "development",
        version: "1.0.0",
        enforcement_point_id: "ep-1",
        extension_metadata: {
          package_type: "BOT",
          profile: { title: "Bad", description: "Bad", avatar: {} },
          skills: [],
          plugins: [],
          resource_bindings: [],
          default_runtime_tier: "none",
          manifest_digest: "m",
          artifact_digest: "a",
        },
      },
    }),
    (error: unknown) => error instanceof Error && (error as any).code === "EXTENSION_METADATA_NOT_ALLOWED",
  )
})


test("publication endpoint rejects invalid hostnames and paths before persistence", async () => {
  const modules = createInMemoryPlatformModules()
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "test-token": { tenant_id: "tenant-acme", subject_id: "person-owner", role: "TENANT_ADMINISTRATOR", organization_ids: [], client_id: "application-1" },
    }),
  })
  try {
    for (const input of [{ hostname: "not a hostname", base_path: "/mcp" }, { hostname: "api.example.com", base_path: "mcp" }]) {
      const response = await app.inject({
        method: "PUT",
        url: "/v1/tenants/tenant-acme/resources/resource-orders/publication-endpoint",
        headers: { authorization: "Bearer test-token" },
        payload: { gateway_id: "genio-ai-mcp-gateway", dns_management: "EXTERNAL", dns_verification: "PENDING", ...input },
      })
      assert.equal(response.statusCode, 400)
      assert.equal(response.json().code, "REQUEST_VALIDATION_FAILED")
    }
  } finally {
    await app.close()
  }
})

test("Resource API rejects installation-owned identity and retirement mutations", async () => {
  const tenantId = "tenant-installed-api"
  const modules = createInMemoryPlatformModules()
  const owner = await modules.organizations.create({ tenantId, display_name: "Installed", slug: "installed" })
  const other = await modules.organizations.create({ tenantId, display_name: "Other", slug: "other" })
  const state = createResourceMemoryState()
  const registry = createInMemoryResourceRegistry({ state, organizations: modules.organizations })
  const resource = await registry.createResource({
    tenantId,
    value: {
      display_name: "ServiceNow",
      kind: "MCP",
      owner_organization_id: owner.organization_id,
      authentication_strategy: "NONE",
      environment_id: "platform",
      version: "1.0.0",
      capabilities: [{ capability_id: "mcp.invoke", display_name: "Invoke" }],
      enforcement_point_id: "platform",
    },
  })
  state.resources.set(`${tenantId}:${resource.resource_id}`, { ...resource, installation_owned: true, service_kind: "SERVICENOW_CSM" })
  modules.resources = registry
  const app = await createManagementApi({
    modules,
    resourceCatalog: registry,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "installed-token": {
        tenant_id: tenantId,
        subject_id: "person-admin",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
        client_id: "management-ui",
        scopes: ["genioone-management"],
      },
    }),
  })
  try {
    const ownerChange = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantId}/resources/${resource.resource_id}`,
      headers: { authorization: "Bearer installed-token" },
      payload: { owner_organization_id: other.organization_id },
    })
    assert.equal(ownerChange.statusCode, 409)
    assert.equal(ownerChange.json().code, "INSTALLATION_OWNED_RESOURCE_IDENTITY")

    state.resources.set(`${tenantId}:${resource.resource_id}`, { ...state.resources.get(`${tenantId}:${resource.resource_id}`)!, lifecycle: "PUBLISHED" })
    const retire = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/resources/${resource.resource_id}/lifecycle`,
      headers: { authorization: "Bearer installed-token" },
      payload: { lifecycle: "DEPRECATED" },
    })
    assert.equal(retire.statusCode, 409)
    assert.equal(retire.json().code, "INSTALLATION_OWNED_RESOURCE_CANNOT_RETIRE")

    const remove = await app.inject({
      method: "DELETE",
      url: `/v1/tenants/${tenantId}/resources/${resource.resource_id}`,
      headers: { authorization: "Bearer installed-token" },
    })
    assert.equal(remove.statusCode, 404)
  } finally {
    await app.close()
  }
})
