import test from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import { installBreezeAsr } from "../../../connectors/breeze-asr/install"
import type { Api } from "../../../connectors/install"

test("Breeze installer resumes and publishes a transcription model without duplicating resources", async () => {
  const modules = createInMemoryPlatformModules()
  const tenantId = "tenant-asr-test"
  const gatewayId = "gateway-asr-test"
  const runtimeId = "runtime-asr-test"
  const org = await modules.organizations.create({ tenantId, display_name: "ASR Test", slug: "asr-test" })
  await modules.runtimeControl.registerGatewayRuntime({ tenantId, runtimeId, targetId: gatewayId, oidcClientId: "runtime-client", reportKeyId: "report", reportPublicKeyPem: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() })
  await modules.gatewayAggregateRuntimeControl!.store.saveCapabilities({ tenantId, runtimeId, protocolVersions: ["genio.one.runtime.v1"], preferredProtocolVersion: "genio.one.runtime.v1", deliveryMode: "AGGREGATE_RELEASE" })
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: createStaticPrincipalAuthenticator({ "test-token": { tenant_id: tenantId, subject_id: "admin", role: "TENANT_ADMINISTRATOR", organization_ids: [org.organization_id], client_id: "test-client" } }), entitlementResolver: modules.entitlements })
  let interrupt = true
  let writes = 0
  const api: Api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    if (interrupt && path.endsWith("/publication-endpoint")) { interrupt = false; throw new Error("TEST_INTERRUPTED") }
    if (init?.method && init.method !== "GET") writes++
    const response = await app.inject({ method: (init?.method ?? "GET") as "GET" | "POST" | "PUT", url: path, headers: { authorization: "Bearer test-token", ...(init?.body ? { "content-type": "application/json" } : {}) }, ...(init?.body ? { payload: String(init.body) } : {}) })
    if (response.statusCode === 404) throw new Error(`STANDARD_INSTALL_HTTP_404:${path}`)
    assert.ok(response.statusCode < 400, `${init?.method ?? "GET"} ${path}: ${response.statusCode} ${response.body}`)
    return response.statusCode === 204 ? null as T : response.json<T>()
  }
  const config = { platformOrigin: "https://cp.test", tenantId, ownerOrganizationId: org.organization_id, environmentId: "test", gatewayId, upstreamEndpoint: "http://127.0.0.1:5192/v1", hostname: "asr.test", basePath: "/", dnsTarget: "gateway.test", identityIssuer: "https://identity.test/realms/genio-one", identityAudience: "api" }
  try {
    await assert.rejects(() => installBreezeAsr(config, api), /TEST_INTERRUPTED/)
    const result = await installBreezeAsr(config, api)
    const before = writes
    const repeated = await installBreezeAsr(config, api)
    assert.equal(repeated.resourceId, result.resourceId)
    assert.equal(writes, before)
    const models = await api<Array<{ capabilities: string[] }>>(`/v1/tenants/${tenantId}/models`)
    assert.deepEqual(models[0]?.capabilities, ["TRANSCRIPTION"])
    const catalog = await api<{ capabilities: Array<{ resource_id: string; access: string }> }>(`/v1/tenants/${tenantId}/catalog`)
    assert.equal(catalog.capabilities.find((item) => item.resource_id === result.resourceId)?.access, "AUTO_GRANT")
    await assert.rejects(() => installBreezeAsr({ ...config, upstreamEndpoint: "http://another.test/v1" }, api), /ASR_CONNECTION_CONFLICT/)
  } finally { await app.close() }
})
