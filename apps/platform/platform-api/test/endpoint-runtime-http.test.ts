import assert from "node:assert/strict"
import test from "node:test"

import Fastify from "fastify"

import { endpointRuntimeHttp } from "../src/capabilities/endpoint-runtime/http"
import { createInMemoryEndpointRuntimeStore } from "../src/capabilities/endpoint-runtime/memory"

const identity = {
  subject: { subject_id: "person-1", evidence_level: "VERIFIED" as const },
  acting_client: { acting_client_id: "genio-endpoint", evidence_level: "VERIFIED" as const },
  device_id: null,
}

test("Endpoint Runtime enrolls, applies desired state, heartbeats, and confirms a direct route", async () => {
  let now = 1_800_000_000
  const app = Fastify()
  const store = createInMemoryEndpointRuntimeStore({ now: () => now++ })
  const bootstrap = await store.bootstrap({ tenantId: "tenant-1", subjectId: "person-1", correlationId: "bootstrap-1" })
  const credential = await store.authenticateCredential({ tenantId: "tenant-1", token: bootstrap.credential.token })
  const deviceId = bootstrap.device_id
  await app.register(endpointRuntimeHttp, {
    store,
    authorizeEndpoint: async () => ({ subjectId: "person-1", credentialId: credential.credentialId }),
  })

  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-1/endpoints/enroll",
    payload: {
      correlation_id: "enroll-1",
      identity,
      device_id: deviceId,
      endpoint_version: "0.1.0",
      at: now,
    },
  })
  assert.equal(enrollment.statusCode, 200)
  assert.equal(enrollment.json().device.subject_id, "person-1")
  assert.equal(enrollment.json().configuration.desired_state.routing.default_route, "DIRECT")
  await assert.rejects(store.assertApplied({
    tenantId: "tenant-1",
    deviceId: deviceId,
    subjectId: "person-1",
    appliedStateRevision: "endpoint-direct-v1",
    appliedPolicyVersion: "endpoint-direct-policy-v1",
  }), /ENDPOINT_DESIRED_STATE_NOT_APPLIED/)
  await assert.rejects(
    store.assertApplied({
      tenantId: "tenant-1",
      deviceId: deviceId,
      subjectId: "person-2",
      appliedStateRevision: "endpoint-direct-v1",
      appliedPolicyVersion: "endpoint-direct-policy-v1",
    }),
    /ENDPOINT_SUBJECT_EVIDENCE_INVALID/,
  )

  const firstHeartbeat = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-1/endpoints/${deviceId}/heartbeat`,
    payload: {
      correlation_id: "heartbeat-1",
      evidence_level: "VERIFIED",
      subject: identity.subject,
      endpoint_version: "0.1.0",
      applied_state_revision: null,
      applied_policy_version: null,
      health: "HEALTHY",
      at: now,
    },
  })
  assert.equal(firstHeartbeat.statusCode, 200)
  assert.equal(firstHeartbeat.json().desired_state.revision, "endpoint-direct-v1")

  const appliedHeartbeat = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-1/endpoints/${deviceId}/heartbeat`,
    payload: {
      correlation_id: "heartbeat-2",
      evidence_level: "VERIFIED",
      subject: identity.subject,
      endpoint_version: "0.1.0",
      applied_state_revision: "endpoint-direct-v1",
      applied_policy_version: "endpoint-direct-policy-v1",
      health: "HEALTHY",
      at: now,
    },
  })
  assert.equal(appliedHeartbeat.statusCode, 200)
  assert.equal(appliedHeartbeat.json().desired_state, null)

  const enforcement = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-1/endpoints/${deviceId}/enforcements`,
    payload: {
      correlation_id: "enforcement-1",
      evidence_level: "VERIFIED",
      subject: identity.subject,
      destination_host: "example.com",
      acting_client: { acting_client_id: "curl", evidence_level: "VERIFIED" },
      client_configuration: null,
      applied_state_revision: "endpoint-direct-v1",
      applied_policy_version: "endpoint-direct-policy-v1",
      route: "DIRECT",
      missing_deployment_capability: null,
      at: now,
    },
  })
  assert.equal(enforcement.statusCode, 200)
  assert.deepEqual(enforcement.json(), {
    policy_rule_id: null,
    resource_id: null,
    route: "DIRECT",
    managed_route: null,
    policy_message: null,
    missing_deployment_capability: null,
  })
  await app.close()
})

test("Endpoint Runtime rejects a submitted Subject that differs from authentication", async () => {
  const app = Fastify()
  await app.register(endpointRuntimeHttp, {
    store: createInMemoryEndpointRuntimeStore(),
    authorizeEndpoint: async () => ({ subjectId: "person-2", credentialId: "invalid" }),
  })
  const response = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-1/endpoints/enroll",
    payload: {
      correlation_id: "enroll-spoofed",
      identity,
      device_id: "device-1",
      endpoint_version: "0.1.0",
      at: 1_800_000_000,
    },
  })
  assert.equal(response.statusCode, 403)
  await app.close()
})
