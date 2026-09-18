import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"

import Fastify from "fastify"

import { runtimeControlHttp } from "../src/capabilities/runtime-control/http"
import { createInMemoryRuntimeControlStore } from "../src/capabilities/runtime-control/memory"

test("runtime-control HTTP registers a Gateway Runtime", async () => {
  const store = createInMemoryRuntimeControlStore()
  const app = Fastify({ logger: false })
  await app.register(runtimeControlHttp, { store })
  const reportPublicKeyPem = generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "pem" })
    .toString()

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
  assert.equal(response.json().runtime_id, "gateway-http")
  await app.close()
})
