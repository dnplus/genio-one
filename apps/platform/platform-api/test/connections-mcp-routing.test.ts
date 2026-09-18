import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

test("MCP routing stores the stable native tool namespace", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 1_700_000_000 })
  const organization = await modules.organizations.create({
    tenantId: "tenant-acme",
    display_name: "Acme AI",
    slug: "acme-ai-routing",
  })
  const resource = await modules.resources.createResource({
    tenantId: "tenant-acme",
    value: {
      display_name: "MCP Routing",
      kind: "MCP",
      owner_organization_id: organization.organization_id,
      authentication_strategy: "NONE",
      environment_id: "local",
      version: "1.0.0",
      capabilities: [{ capability_id: "mcp.invoke", display_name: "Invoke MCP tools" }],
      enforcement_point_id: "ai-gateway",
    },
  })
  const connection = await modules.connections.create({
    tenantId: "tenant-acme",
    resourceId: resource.resource_id,
    value: {
      display_name: "Local MCP",
      connection_kind: "MCP",
      endpoint: "http://127.0.0.1:19003/mcp",
    },
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "test-token": {
        tenant_id: "tenant-acme",
        subject_id: "person-owner",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [organization.organization_id],
        client_id: "application-1",
      },
    }),
  })
  const response = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/resources/${resource.resource_id}/connections/${connection.connection_id}/mcp-routing`,
    headers: { authorization: "Bearer test-token" },
    payload: {
      correlation_id: "mcp-routing-1",
      expected_revision: connection.configuration_revision,
      mcp_tool_namespace: "engineering",
    },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().mcp_tool_namespace, "engineering")
  await app.close()
})
