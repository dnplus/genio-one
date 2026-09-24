import assert from "node:assert/strict"
import test from "node:test"
import { createInMemoryEndpointRuntimeStore } from "../src/capabilities/endpoint-runtime/memory"
import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

test("Endpoint credentials consume bootstrap once, bind device and tenant, rotate and expire", async () => {
  let now = 100
  const store = createInMemoryEndpointRuntimeStore({ now: () => now })
  const binding = { tenantId: "tenant-1", subjectId: "person-1", correlationId: "bootstrap-1" }
  const bootstrap = await store.bootstrap(binding)
  await assert.rejects(store.bootstrap(binding), /ENDPOINT_BOOTSTRAP_ALREADY_DELIVERED/)
  const auth = (token: string, tenantId = binding.tenantId) => store.authenticateCredential({ tenantId, token })
  await assert.rejects(auth(bootstrap.credential.token, "other-tenant"), /ENDPOINT_CREDENTIAL_REJECTED/)
  const identity = await auth(bootstrap.credential.token)
  assert.equal(identity.kind, "BOOTSTRAP")
  assert.ok(!JSON.stringify(identity).includes(bootstrap.credential.token))
  const request = { ...binding, credentialId: identity.credentialId, value: { correlation_id: "enroll-1", device_id: bootstrap.device_id,
    endpoint_version: "0.1.0", at: now, identity: { subject: { subject_id: binding.subjectId, evidence_level: "VERIFIED" as const },
      device_id: null, acting_client: { acting_client_id: null, evidence_level: "UNKNOWN" as const } } } }
  await assert.rejects(store.enroll({ ...request, value: { ...request.value, device_id: "spoof-device" } }), /ENDPOINT_CREDENTIAL_REJECTED/)
  const [first, second] = await Promise.allSettled([store.enroll(request), store.enroll(request)])
  assert.equal(first.status, "fulfilled")
  assert.equal(second.status, "rejected")
  if (first.status !== "fulfilled") throw new Error("Enrollment missing")
  const credential = first.value.runtime_credential!
  await assert.rejects(auth(bootstrap.credential.token), /ENDPOINT_CREDENTIAL_REJECTED/)
  const runtime = await auth(credential.token)
  assert.equal(runtime.kind, "RUNTIME")
  assert.equal((await store.enroll({ ...request, credentialId: runtime.credentialId })).runtime_credential, null)
  await assert.rejects(store.rotateCredential({ tenantId: binding.tenantId, deviceId: "other-device", credentialId: runtime.credentialId }), /ENDPOINT_CREDENTIAL_REJECTED/)
  const rotated = await store.rotateCredential({ tenantId: binding.tenantId, deviceId: runtime.deviceId, credentialId: runtime.credentialId })
  await assert.rejects(auth(credential.token), /ENDPOINT_CREDENTIAL_REJECTED/)
  await auth(rotated.token)
  now = rotated.expires_at
  await assert.rejects(auth(rotated.token), /ENDPOINT_CREDENTIAL_REJECTED/)
  const expiredBootstrap = await store.bootstrap({ ...binding, correlationId: "expires" })
  now = expiredBootstrap.credential.expires_at
  await assert.rejects(auth(expiredBootstrap.credential.token), /ENDPOINT_CREDENTIAL_REJECTED/)
})

test("Runtime HTTP refuses ordinary OIDC principals and credential use outside the bound runtime", async () => {
  const modules = createInMemoryPlatformModules()
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({ user: { tenant_id: "tenant-1", subject_id: "person-1", role: "USER",
      organization_ids: [], client_id: "browser", scopes: ["genioone-invocation", "genioone-endpoint-runtime"] } }) })
  try {
    const root = "/v1/tenants/tenant-1/endpoints"
    const headers = (token: string) => ({ authorization: `Bearer ${token}` })
    const issued = await app.inject({ method: "POST", url: `${root}/bootstrap`, headers: headers("user"), payload: { correlation_id: "bootstrap-1" } })
    assert.equal(issued.statusCode, 201, issued.body)
    assert.equal(issued.headers["cache-control"], "no-store")
    const bootstrap = issued.json()
    const body = { correlation_id: "enroll", device_id: bootstrap.device_id, endpoint_version: "0.1.0", at: 100,
      identity: { subject: { subject_id: "person-1", evidence_level: "VERIFIED" }, device_id: null, acting_client: { acting_client_id: null, evidence_level: "UNKNOWN" } } }
    assert.equal((await app.inject({ method: "POST", url: `${root}/enroll`, headers: headers("user"), payload: body })).statusCode, 401)
    const enrolled = await app.inject({ method: "POST", url: `${root}/enroll`, headers: headers(bootstrap.credential.token), payload: body })
    assert.equal(enrolled.statusCode, 200, enrolled.body)
    const token = enrolled.json().runtime_credential.token
    assert.equal((await app.inject({ method: "POST", url: `${root}/bootstrap`, headers: headers(token), payload: { correlation_id: "smuggle" } })).statusCode, 401)
    assert.equal((await app.inject({ method: "POST", url: `${root}/other-device/rotate-credential`, headers: headers(token) })).statusCode, 401)
    const rotated = await app.inject({ method: "POST", url: `${root}/${bootstrap.device_id}/rotate-credential`, headers: headers(token) })
    assert.equal(rotated.statusCode, 200, rotated.body)
    assert.equal((await app.inject({ method: "POST", url: `${root}/${bootstrap.device_id}/rotate-credential`, headers: headers(token) })).statusCode, 401)
  } finally { await app.close() }
})
