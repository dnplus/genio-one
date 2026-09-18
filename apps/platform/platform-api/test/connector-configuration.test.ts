import { createHttpConnectionVerifier } from "../src/local-slice-verifiers"
import { createConnectorHost } from "../../../connectors/host"
import { createServiceNowHandler } from "../../../connectors/servicenow-csm/server"
import { expect, test } from "bun:test"
import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import { readConnectorConfigurationToken, type ConnectorConfiguration } from "../../../connectors/configuration"

test("management creates and edits site configuration without deployment endpoint or personal secrets", async () => {
  const modules = createInMemoryPlatformModules()
  const tenantId = "connector-test"
  const org = await modules.organizations.create({ tenantId, display_name: "Connector test", slug: "connector-test" })
  const key = "test-connector-configuration-key-0000000001"
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: createStaticPrincipalAuthenticator({ "test-token": { tenant_id: tenantId, subject_id: "admin", role: "TENANT_ADMINISTRATOR", organization_ids: [org.organization_id], client_id: "test", scopes: ["genioone-management"] } }), connectorDeployment: { configurationKey: key, endpoints: { "servicenow-csm": "http://connector.test/mcp", mail2000: "http://mail.test/mcp" } } })
  const base = `/v1/tenants/${tenantId}`
  try {
    const resource = await app.inject({ headers: { authorization: "Bearer test-token" }, method: "POST", url: `${base}/resources`, payload: { display_name: "CSM", kind: "MCP", owner_organization_id: org.organization_id, environment_id: "test", version: "v1", authentication_strategy: "OAUTH", enforcement_point_id: "gateway", capabilities: [{ capability_id: "mcp.invoke", display_name: "MCP" }] } })
    expect(resource.statusCode).toBe(201)
    const path = `${base}/resources/${resource.json().resource_id}/connections`
    const config: ConnectorConfiguration = { kind: "servicenow-csm", instance_url: "https://first.test", oauth_client_id: "client-a", oauth_scopes: ["useraccount"] }
    const created = await app.inject({ headers: { authorization: "Bearer test-token" }, method: "POST", url: path, payload: { display_name: "First", connection_kind: "MCP", connector_configuration: config } })
    expect(created.statusCode).toBe(201)
    expect(created.json().connector_configuration).toEqual(config)
    expect(readConnectorConfigurationToken(new URL(created.json().endpoint).pathname.slice(5), key)).toEqual(config)
    expect(created.json().downstream_identity.oauth_client.client_id).toBe("client-a")
    const host = createConnectorHost({ kind: "servicenow-csm", configurationKey: key, discoveryHandler: createServiceNowHandler(), configuredHandler: (configuration) => createServiceNowHandler({ instanceUrl: configuration.kind === "servicenow-csm" ? configuration.instance_url : undefined }) })
    const verifier = createHttpConnectionVerifier({ allowHttp: true, fetcher: (url, init) => host(new Request(url, init)) })
    expect(await verifier.verify({ connection: created.json() })).toBe(true)
    const update = await app.inject({ headers: { authorization: "Bearer test-token" }, method: "PATCH", url: `${path}/${created.json().connection_id}`, payload: { expected_revision: 1, connector_configuration: { ...config, instance_url: "https://second.test", oauth_client_id: "client-b" } } })
    expect(update.statusCode).toBe(200)
    expect(update.json().configuration_revision).toBe(2)
    expect(update.json().downstream_identity.oauth_client.issuer).toBe("https://second.test")
    const listed = await app.inject({ headers: { authorization: "Bearer test-token" }, method: "GET", url: path })
    expect(listed.json()[0].connector_configuration.instance_url).toBe("https://second.test")
    const invalid = await app.inject({ headers: { authorization: "Bearer test-token" }, method: "POST", url: path, payload: { display_name: "Bad", connection_kind: "MCP", connector_configuration: { ...config, instance_url: "https://user:password@bad.test" } } })
    expect(invalid.statusCode).toBe(422)
    const override = await app.inject({ headers: { authorization: "Bearer test-token" }, method: "PATCH", url: `${path}/${created.json().connection_id}`, payload: { expected_revision: 2, endpoint: "https://attacker.test/mcp" } })
    expect(override.statusCode).toBe(422)
    const getResource = modules.resources.getResource.bind(modules.resources)
    modules.resources.getResource = async (input) => ({ ...await getResource(input), lifecycle: "PUBLISHED" })
    const publishedChange = await app.inject({ headers: { authorization: "Bearer test-token" }, method: "PATCH", url: `${path}/${created.json().connection_id}`, payload: { expected_revision: 2, connector_configuration: { ...config, instance_url: "https://third.test" } } })
    expect(publishedChange.statusCode).toBe(409)
    expect(publishedChange.json().code).toBe("CONNECTOR_SITE_CHANGE_REQUIRES_NEW_CONNECTION")
  } finally { await app.close() }
})
