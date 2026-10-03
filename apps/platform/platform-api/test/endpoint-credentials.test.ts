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
  const rotation = { tenantId: binding.tenantId, deviceId: runtime.deviceId, credentialId: runtime.credentialId,
    subjectId: binding.subjectId, correlationId: "rotate-1" }
  await assert.rejects(store.rotateCredential({ ...rotation, deviceId: "other-device" }), /ENDPOINT_CREDENTIAL_REJECTED/)
  await assert.rejects(store.rotateCredential({ ...rotation, subjectId: "other-person" }), /ENDPOINT_CREDENTIAL_REJECTED/)
  const rotated = await store.rotateCredential(rotation)
  await assert.rejects(auth(credential.token), /ENDPOINT_CREDENTIAL_REJECTED/)
  const rotatedIdentity = await auth(rotated.token)
  const events = await store.lifecycleEvents({ tenantId: binding.tenantId, deviceId: runtime.deviceId })
  assert.deepEqual(events.map((event) => event.kind), ["ENROLLED", "ROTATED"])
  assert.deepEqual(events[1], {
    tenant_id: binding.tenantId, device_id: runtime.deviceId, subject_id: binding.subjectId,
    correlation_id: "rotate-1", kind: "ROTATED", reason: null, at: now,
    old_credential_id: runtime.credentialId, new_credential_id: rotatedIdentity.credentialId,
  })
  assert.ok(!JSON.stringify(events).includes(rotated.token))
  await assert.rejects(store.rotateCredential(rotation), /ENDPOINT_CREDENTIAL_REJECTED/)
  assert.equal((await store.lifecycleEvents({ tenantId: binding.tenantId, deviceId: runtime.deviceId })).length, 2)
  const nextRotation = { ...rotation, credentialId: rotatedIdentity.credentialId, correlationId: "rotate-2" }
  const twiceRotated = await store.rotateCredential(nextRotation)
  await assert.rejects(auth(rotated.token), /ENDPOINT_CREDENTIAL_REJECTED/)
  const nextIdentity = await auth(twiceRotated.token)
  const repeatedEvents = await store.lifecycleEvents({ tenantId: binding.tenantId, deviceId: runtime.deviceId })
  assert.deepEqual(repeatedEvents.map((event) => event.kind), ["ENROLLED", "ROTATED", "ROTATED"])
  assert.equal(repeatedEvents[2]?.old_credential_id, rotatedIdentity.credentialId)
  assert.equal(repeatedEvents[2]?.new_credential_id, nextIdentity.credentialId)
  await assert.rejects(store.rotateCredential(nextRotation), /ENDPOINT_CREDENTIAL_REJECTED/)
  assert.equal((await store.lifecycleEvents({ tenantId: binding.tenantId, deviceId: runtime.deviceId })).length, 3)
  now = twiceRotated.expires_at
  await assert.rejects(auth(twiceRotated.token), /ENDPOINT_CREDENTIAL_REJECTED/)
  const expiredBootstrap = await store.bootstrap({ ...binding, correlationId: "expires" })
  now = expiredBootstrap.credential.expires_at
  await assert.rejects(auth(expiredBootstrap.credential.token), /ENDPOINT_CREDENTIAL_REJECTED/)
})

test("Runtime HTTP refuses ordinary OIDC principals and credential use outside the bound runtime", async () => {
  const modules = createInMemoryPlatformModules()
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      user: { tenant_id: "tenant-1", subject_id: "person-1", role: "USER",
        organization_ids: [], client_id: "browser", scopes: ["genioone-invocation", "genioone-endpoint-runtime"] },
      admin: { tenant_id: "tenant-1", subject_id: "administrator", role: "TENANT_ADMINISTRATOR",
        organization_ids: [], client_id: "admin", scopes: ["genioone-management"] },
    }) })
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
    const previous = await modules.endpointRuntime.authenticateCredential({ tenantId: "tenant-1", token })
    assert.equal((await app.inject({ method: "POST", url: `${root}/bootstrap`, headers: headers(token), payload: { correlation_id: "smuggle" } })).statusCode, 401)
    assert.equal((await app.inject({ method: "POST", url: `${root}/other-device/rotate-credential`, headers: headers(token) })).statusCode, 401)
    const rotated = await app.inject({ method: "POST", url: `${root}/${bootstrap.device_id}/rotate-credential`,
      headers: { ...headers(token), "x-genio-correlation-id": "rotate-correlation-1" } })
    assert.equal(rotated.statusCode, 200, rotated.body)
    assert.equal(rotated.headers["x-correlation-id"], "rotate-correlation-1")
    const receipts = await modules.auditEvents.queryAuthenticationAttempts!({
      correlationId: "rotate-correlation-1", code: "ENDPOINT_CREDENTIAL_ACCEPTED", outcome: "SUCCESS", offset: 0, limit: 10,
    })
    assert.equal(receipts.receipts.length, 1)
    assert.equal(receipts.receipts[0]?.correlation_id, rotated.headers["x-correlation-id"])
    const next = await modules.endpointRuntime.authenticateCredential({ tenantId: "tenant-1", token: rotated.json().token })
    const listed = await app.inject({ method: "GET", url: `${root}/${bootstrap.device_id}/lifecycle-events`, headers: headers("admin") })
    assert.equal(listed.statusCode, 200, listed.body)
    const rotation = listed.json().find((event: { kind: string }) => event.kind === "ROTATED")
    assert.equal(rotation?.correlation_id, rotated.headers["x-correlation-id"])
    assert.equal(rotation?.subject_id, "person-1")
    assert.equal(rotation?.old_credential_id, previous.credentialId)
    assert.equal(rotation?.new_credential_id, next.credentialId)
    assert.ok(!JSON.stringify(rotation).includes(token))
    assert.ok(!JSON.stringify(rotation).includes(rotated.json().token))
    assert.equal((await app.inject({ method: "POST", url: `${root}/${bootstrap.device_id}/rotate-credential`, headers: headers(token) })).statusCode, 401)
    assert.equal((await modules.endpointRuntime.lifecycleEvents({ tenantId: "tenant-1", deviceId: bootstrap.device_id })).length, 2)
  } finally { await app.close() }
})
