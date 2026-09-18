import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createRuntimeTokenSource } from "./runtime-token"

test("runtime token source uses client credentials and refreshes before expiry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "genio-one-runtime-token-"))
  const clientIdFile = join(directory, "client-id")
  const clientSecretFile = join(directory, "client-secret")
  await writeFile(clientIdFile, "runtime-client\n", { mode: 0o600 })
  await writeFile(clientSecretFile, "runtime-secret\n", { mode: 0o600 })
  let now = 1_000
  let requests = 0
  const source = createRuntimeTokenSource({
    tokenEndpoint: "https://identity.example/token",
    clientIdFile,
    clientSecretFile,
    scope: "genioone-gateway-runtime",
    now: () => now,
    fetch: async (_url, init) => {
      requests += 1
      const body = init?.body as URLSearchParams
      assert.equal(body.get("grant_type"), "client_credentials")
      assert.equal(body.get("client_id"), "runtime-client")
      assert.equal(body.get("client_secret"), "runtime-secret")
      assert.equal(body.get("scope"), "genioone-gateway-runtime")
      return new Response(JSON.stringify({
        access_token: `token-${requests}`,
        expires_in: 60,
      }), { status: 200, headers: { "content-type": "application/json" } })
    },
  })

  assert.deepEqual(await source.headers(), { authorization: "Bearer token-1" })
  assert.deepEqual(await source.headers(), { authorization: "Bearer token-1" })
  now += 31_000
  assert.deepEqual(await source.headers(), { authorization: "Bearer token-2" })
  assert.equal(requests, 2)
})
