import assert from "node:assert/strict"
import test from "node:test"
import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

const subject = { subject_id: "employee", evidence_level: "VERIFIED" as const }
const identity = { subject, acting_client: { acting_client_id: null, evidence_level: "UNKNOWN" as const }, device_id: null }
const enrollment = { correlation_id: "enroll-1", identity, device_id: "device-1", endpoint_version: "0.1.0", at: 100 }
const heartbeat = { correlation_id: "heartbeat-1", evidence_level: "VERIFIED" as const, subject, endpoint_version: "0.1.0",
  applied_state_revision: "endpoint-direct-v1", applied_policy_version: "endpoint-direct-policy-v1", health: "HEALTHY" as const, at: 100 }

test("Endpoint administrator revocation is idempotent and blocks runtime operations after an acknowledged policy", async () => {
  let now = 100
  const modules = createInMemoryPlatformModules({ now: () => now })
  const principal = { tenant_id: "tenant-1", subject_id: "employee", role: "USER" as const,
    organization_ids: [], client_id: "endpoint", scopes: ["genioone-endpoint-runtime"] }
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({ endpoint: principal,
      user: { ...principal, scopes: ["genioone-management"] },
      admin: { ...principal, subject_id: "administrator", role: "TENANT_ADMINISTRATOR", scopes: ["genioone-management"] },
      outsider: { ...principal, tenant_id: "tenant-2", role: "TENANT_ADMINISTRATOR", scopes: ["genioone-management"] },
    }),
  })
  try {
    const url = "/v1/tenants/tenant-1/endpoints"
    let runtimeToken = ""
    let bootstrapToken = ""
    const auth = (token: string) => ({ authorization: `Bearer ${token === "endpoint" ? runtimeToken : token === "bootstrap" ? bootstrapToken : token}` })
    const bootstrap = await app.inject({ method: "POST", url: `${url}/bootstrap`, headers: auth("user"), payload: { correlation_id: "bootstrap-1" } })
    assert.equal(bootstrap.statusCode, 201, bootstrap.body)
    const deviceId = bootstrap.json().device_id
    bootstrapToken = bootstrap.json().credential.token
    const enrolled = await app.inject({ method: "POST", url: `${url}/enroll`, headers: auth("bootstrap"), payload: { ...enrollment, device_id: deviceId } })
    assert.equal(enrolled.statusCode, 200, enrolled.body)
    runtimeToken = enrolled.json().runtime_credential.token
    const assertion = () => modules.endpointRuntime.assertApplied({ tenantId: "tenant-1", deviceId, subjectId: "employee",
      appliedStateRevision: heartbeat.applied_state_revision, appliedPolicyVersion: heartbeat.applied_policy_version })
    await assert.rejects(assertion(), /ENDPOINT_DESIRED_STATE_NOT_APPLIED/)
    const beat = () => app.inject({ method: "POST", url: `${url}/${deviceId}/heartbeat`, headers: auth("endpoint"), payload: heartbeat })
    assert.equal((await beat()).statusCode, 200)
    await assertion()
    now = 190
    await assert.rejects(assertion(), /ENDPOINT_HEARTBEAT_STALE/)
    assert.equal((await beat()).statusCode, 200)
    await assertion()
    for (const token of ["user", "endpoint", "outsider"]) {
      const denied = await app.inject({ method: "POST", url: `${url}/${deviceId}/revoke`, headers: auth(token), payload: { correlation_id: "revoke-1", reason: "Device lost" } })
      assert.equal(denied.statusCode, token === "endpoint" ? 401 : 403, denied.body)
    }
    assert.equal((await app.inject({ method: "GET", url, headers: auth("user") })).statusCode, 403)
    assert.equal((await app.inject({ method: "GET", url, headers: auth("admin") })).json().length, 1)
    for (const correlation_id of ["revoke-1", "revoke-retry"]) {
      const revoked = await app.inject({ method: "POST", url: `${url}/${deviceId}/revoke`, headers: auth("admin"), payload: { correlation_id, reason: "Device lost" } })
      assert.equal(revoked.statusCode, 200, revoked.body)
      assert.equal(revoked.json().lifecycle_state, "REVOKED")
    }
    const events = await app.inject({ method: "GET", url: `${url}/${deviceId}/lifecycle-events`, headers: auth("admin") })
    assert.equal(events.statusCode, 200)
    assert.deepEqual(events.json().map((event: { kind: string; subject_id: string }) => [event.kind, event.subject_id]), [["ENROLLED", "employee"], ["REVOKED", "administrator"]])
    await assert.rejects(assertion(), /DEVICE_REVOKED/)
    assert.equal((await beat()).statusCode, 401)
    const runtimeBody = { correlation_id: "request-1", evidence_level: "VERIFIED", subject,
      destination_host: "api.openai.com", acting_client: identity.acting_client,
      applied_state_revision: heartbeat.applied_state_revision, applied_policy_version: heartbeat.applied_policy_version, route: "DIRECT" }
    for (const [action, payload] of [
      ["enroll", enrollment],
      [`${deviceId}/enforcements`, { ...runtimeBody, at: now }],
      [`${deviceId}/ai-activities`, { ...runtimeBody, request_count: 1, bytes_sent: 0, bytes_received: 0, observed_at: now }],
    ] as const) {
      const response = await app.inject({ method: "POST", url: `${url}/${action}`, headers: auth("endpoint"), payload })
      assert.equal(response.statusCode, 401, `${action}: ${response.body}`)
      assert.equal(response.json().code, "ENDPOINT_CREDENTIAL_REJECTED")
    }
  } finally {
    await app.close()
  }
})
