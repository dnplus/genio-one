import test from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import { installMail2000 } from "../../../connectors/mail2000/install"
import { installServiceNow } from "../../../connectors/servicenow-csm/install"
import { createMail2000Handler } from "../../../connectors/mail2000/server"
import { createMail2000Imap } from "../../../connectors/mail2000/imap"
import { createMail2000Smtp } from "../../../connectors/mail2000/smtp"
import { createMail2000Dav } from "../../../connectors/mail2000/dav"
import { createServiceNowHandler } from "../../../connectors/servicenow-csm/server"
import type { Api } from "../../../connectors/install"

for (const provider of ["mail2000", "servicenow"] as const) test(`${provider} installer publishes an Auto Grant resource through CP routes`, async () => {
  const modules = createInMemoryPlatformModules()
  const tenantId = "tenant-standard-test"
  const gatewayId = "gateway-standard-test"
  const runtimeId = "runtime-standard-test"
  const org = await modules.organizations.create({ tenantId, display_name: "Test", slug: "test" })
  await modules.runtimeControl.registerGatewayRuntime({ tenantId, runtimeId, targetId: gatewayId, oidcClientId: "runtime-client", reportKeyId: "report", reportPublicKeyPem: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() })
  await modules.gatewayAggregateRuntimeControl!.store.saveCapabilities({ tenantId, runtimeId, protocolVersions: ["genio.one.runtime.v1"], preferredProtocolVersion: "genio.one.runtime.v1", deliveryMode: "AGGREGATE_RELEASE" })
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: createStaticPrincipalAuthenticator({ "test-token": { tenant_id: tenantId, subject_id: "admin", role: "TENANT_ADMINISTRATOR", organization_ids: [org.organization_id], client_id: "test-client" } }), entitlementResolver: modules.entitlements })
  const handler = provider === "mail2000" ? createMail2000Handler({
    ...createMail2000Imap({ host: "mail.test", port: 993 }), sendMail: createMail2000Smtp({ host: "mail.test", port: 465 }),
    caldav: createMail2000Dav({ url: "https://mail.test/cal/", kind: "caldav" }), carddav: createMail2000Dav({ url: "https://mail.test/contacts/", kind: "carddav" }),
  }) : createServiceNowHandler({ instanceUrl: "https://sn.test" })
  const definitionResponse = await handler(new Request("https://connector.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }))
  const definition = await definitionResponse.json() as { result: { tools: Array<{ name: string; title?: string; description?: string }> } }
  const tools = definition.result.tools

  const api: Api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await app.inject({ method: (init?.method ?? "GET") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: path, headers: { authorization: "Bearer test-token", ...(init?.body ? { "content-type": "application/json" } : {}) }, ...(init?.body ? { payload: String(init.body) } : {}) })
    assert.ok(response.statusCode < 400, `${init?.method ?? "GET"} ${path}: ${response.statusCode} ${response.body}`)
    if (path.endsWith("/mcp-discovery") && init?.method === "POST") {
      const operation = await modules.mcpDiscovery.claimNext({ tenantId, gatewayId, runtimeId })
      assert.ok(operation)
      await modules.mcpDiscovery.complete({ tenantId, runtimeId, operationId: operation.operation_id, result: { state: "SUCCEEDED", observation: { protocol_version: "2025-11-25", server_name: provider, server_version: "0.1.0", tools: tools.map((tool) => ({ name: tool.name, title: tool.title ?? null, description: tool.description ?? null })) } } })
    }
    return response.statusCode === 204 ? null as T : response.json<T>()
  }
  const config = { platformOrigin: "https://cp.test", tenantId, ownerOrganizationId: org.organization_id, environmentId: "test", gatewayId, upstreamEndpoint: "https://connector.test/mcp", hostname: "gateway.test", basePath: "/mcp", dnsTarget: "gateway.test", identityIssuer: "https://identity.test/realms/genio-one", identityAudience: "api" }
  try {
    const result = provider === "mail2000" ? await installMail2000(config, api) : await installServiceNow({ ...config, serviceNowOrigin: "https://sn.test", oauthClientId: "client", oauthScopes: [] }, api)
    const catalog = await api<{ capabilities: Array<{ resource_id: string; access: string }> }>(`/v1/tenants/${tenantId}/catalog`)
    const capabilities = catalog.capabilities.filter((capability) => capability.resource_id === result.resourceId)
    assert.equal(capabilities.length, tools.length + 1)
    assert.ok(capabilities.every((capability) => capability.access === "AUTO_GRANT"))
    const personal = await api<Array<{ authentication: string }>>(`/v1/tenants/${tenantId}/me/resource-connections/${result.resourceId}`)
    assert.equal(personal.length, 1)
    assert.equal(personal[0]!.authentication, provider === "mail2000" ? "PASSWORD" : "OAUTH")
  } finally { await app.close() }
})
