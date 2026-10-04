import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"

import Fastify from "fastify"

import { runtimeControlHttp } from "../src/capabilities/runtime-control/http"
import { createInMemoryRuntimeControlStore } from "../src/capabilities/runtime-control/memory"

test("runtime-control HTTP confirms a provisioned Gateway Runtime without writing", async () => {
  const store = createInMemoryRuntimeControlStore()
  const app = Fastify({ logger: false })
  const reportPublicKeyPem = generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "pem" })
    .toString()
  const registration = await store.registerGatewayRuntime({
    tenantId: "tenant-http",
    runtimeId: "gateway-http",
    targetId: "gateway-target-http",
    oidcClientId: "gateway-http",
    reportKeyId: "report-key-http",
    reportPublicKeyPem,
  })
  await app.register(runtimeControlHttp, {
    store: {
      ...store,
      async registerGatewayRuntime() {
        throw new Error("Self-registration must not call the trusted writer")
      },
    },
  })

  const response = await app.inject({
    method: "PUT",
    url: "/v1/tenants/tenant-http/runtime-control/GATEWAY/gateway-http/registration",
    payload: {
      target_id: "gateway-target-http",
      oidc_client_id: "gateway-http",
      report_key_id: "report-key-http",
      report_public_key_pem: reportPublicKeyPem,
    },
  })

  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), registration)
  assert.deepEqual(await store.getGatewayRuntime({
    tenantId: "tenant-http",
    runtimeId: "gateway-http",
  }), registration)
  await app.close()
})
