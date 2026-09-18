import assert from "node:assert/strict"
import test from "node:test"

import Fastify from "fastify"

import { endpointActivityHttp } from "../src/capabilities/endpoint-activities/http"
import { createInMemoryEndpointActivityStore } from "../src/capabilities/endpoint-activities/memory"
import { createInMemoryEndpointRuntimeStore } from "../src/capabilities/endpoint-runtime/memory"

const body = {
  correlation_id: "correlation-1",
  evidence_level: "VERIFIED" as const,
  subject: { subject_id: "person-1", evidence_level: "VERIFIED" as const },
  destination_host: "OpenAI.COM.",
  acting_client: { acting_client_id: "codex", evidence_level: "VERIFIED" as const },
  client_configuration: {
    managed_configuration_revision: "codex-v1",
    otel_collector_origin: "http://127.0.0.1:4318",
  },
  applied_state_revision: "endpoint-direct-v1",
  applied_policy_version: "endpoint-direct-policy-v1",
  route: "DIRECT" as const,
  request_count: 2,
  bytes_sent: 30,
  bytes_received: 40,
  observed_at: 1_800_000_000,
}

async function enrolledRuntime() {
  const runtime = createInMemoryEndpointRuntimeStore({ now: () => 1_800_000_000 })
  const bootstrap = await runtime.bootstrap({ tenantId: "tenant-1", subjectId: "person-1", correlationId: "bootstrap-1" })
  const credential = await runtime.authenticateCredential({ tenantId: "tenant-1", token: bootstrap.credential.token })
  await runtime.enroll({
    credentialId: credential.credentialId,
    tenantId: "tenant-1",
    subjectId: "person-1",
    value: {
      correlation_id: "enroll-1",
      identity: {
        subject: { subject_id: "person-1", evidence_level: "VERIFIED" },
        acting_client: { acting_client_id: "genio-endpoint", evidence_level: "VERIFIED" },
        device_id: null,
      },
      device_id: bootstrap.device_id,
      endpoint_version: "0.1.0",
      at: 1_800_000_000,
    },
  })
  await runtime.heartbeat({
    tenantId: "tenant-1",
    deviceId: bootstrap.device_id,
    subjectId: "person-1",
    value: {
      correlation_id: "ack-1",
      evidence_level: "VERIFIED",
      subject: body.subject,
      endpoint_version: "0.1.0",
      applied_state_revision: body.applied_state_revision,
      applied_policy_version: body.applied_policy_version,
      health: "HEALTHY",
      at: 1_800_000_000,
    },
  })
  return { runtime, deviceId: bootstrap.device_id }
}

test("Endpoint activity records a verified client and exposes the same inventory event", async () => {
  const app = Fastify()
  const { runtime, deviceId } = await enrolledRuntime()
  await app.register(endpointActivityHttp, {
    store: createInMemoryEndpointActivityStore(() => "activity-1"),
    runtime,
    authorizeEndpoint: async () => ({ subjectId: "person-1" }),
  })

  const created = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-1/endpoints/${deviceId}/ai-activities`,
    payload: body,
  })
  assert.equal(created.statusCode, 201)
  assert.deepEqual(created.json().client, { status: "VERIFIED", acting_client_id: "codex" })
  assert.equal(created.json().destination_host, "openai.com")
  assert.equal(created.json().kind, "DISCOVERY")

  const replay = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-1/endpoints/${deviceId}/ai-activities`,
    payload: body,
  })
  assert.equal(replay.statusCode, 201)
  assert.equal(replay.json().activity_id, "activity-1")

  const inventory = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-1/ai-activities?recent_limit=10",
  })
  assert.equal(inventory.statusCode, 200)
  assert.equal(inventory.json().recent_activity[0].activity_id, "activity-1")
  assert.equal(inventory.json().resources[0].request_count, 2)
  assert.deepEqual(inventory.json().resources[0].clients, [{ status: "VERIFIED", acting_client_id: "codex" }])
  await app.close()
})

test("Endpoint activity rejects a submitted Subject that differs from authentication", async () => {
  const app = Fastify()
  const { runtime, deviceId } = await enrolledRuntime()
  await app.register(endpointActivityHttp, {
    store: createInMemoryEndpointActivityStore(),
    runtime,
    authorizeEndpoint: async () => ({ subjectId: "person-2" }),
  })
  const response = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-1/endpoints/${deviceId}/ai-activities`,
    payload: body,
  })
  assert.equal(response.statusCode, 403)
  await app.close()
})
