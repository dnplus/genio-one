import assert from "node:assert/strict"
import test from "node:test"

import { createKeycloakGatewayIdentityProvisioner } from "../src/capabilities/gateway-registration/keycloak"
import type { HttpFetch } from "../../../../runtimes/gateway/services/shared/http-fetch"

test("Gateway identity discovery uses the internal Keycloak origin while retaining the public issuer", async () => {
  const internalOrigin = "http://keycloak.keycloak.svc:8080"
  const publicOrigin = "https://identity.example.test"
  const calls: string[] = []
  const fetchImpl: HttpFetch = async (input, init) => {
    const url = String(input)
    calls.push(`${init?.method ?? "GET"} ${url}`)
    if (url.startsWith(publicOrigin)) throw new Error("public issuer origin is unavailable from the runtime network")
    if (url.endsWith("/realms/master/protocol/openid-connect/token")) {
      return Response.json({ access_token: "admin-token" })
    }
    if (url.includes("/clients?clientId=")) {
      return Response.json([ownedClient()])
    }
    if (url.endsWith("/client-scopes")) {
      return Response.json([{ id: "runtime-scope-id", name: "genioone-gateway-runtime" }])
    }
    if (url.endsWith("/protocol-mappers/models") && (init?.method ?? "GET") === "GET") {
      return Response.json([])
    }
    if (url.endsWith("/client-secret")) {
      return Response.json({ value: "gateway-secret" })
    }
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: `${publicOrigin}/realms/genio-one`,
        token_endpoint: `${publicOrigin}/realms/genio-one/protocol/openid-connect/token`,
      })
    }
    return new Response(null, { status: 204 })
  }
  const provisioner = createKeycloakGatewayIdentityProvisioner({
    origin: internalOrigin,
    issuerOrigin: publicOrigin,
    realm: "genio-one",
    adminUsername: "admin",
    adminPassword: "password",
    audience: "genio-one-product-api",
    fetch: fetchImpl,
  })

  const identity = await provisioner.provision({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    clientId: "gateway-runtime-1",
  })

  assert.equal(identity.issuer, `${publicOrigin}/realms/genio-one`)
  assert.equal(identity.token_endpoint, `${internalOrigin}/realms/genio-one/protocol/openid-connect/token`)
  assert.equal(calls.at(-1), `GET ${internalOrigin}/realms/genio-one/.well-known/openid-configuration`)
})

const ownership = {
  "genioone.provisioner": "gateway-registration",
  "genioone.tenant-id": "tenant-acme",
  "genioone.runtime-id": "gateway-runtime-1",
}
const identityInput = { tenantId: "tenant-acme", runtimeId: "gateway-runtime-1", clientId: "gateway-runtime-1" }

function ownedClient() {
  return { id: "internal-client-id", clientId: identityInput.clientId, attributes: { ...ownership, retained: "value" } }
}

function harness(initial: Record<string, unknown> | null, created?: Record<string, unknown>) {
  let current = initial
  const mutations: { method: string; url: string; body: unknown }[] = []
  const provisioner = createKeycloakGatewayIdentityProvisioner({
    origin: "http://identity.test", issuerOrigin: "http://identity.test", realm: "genio-one",
    adminUsername: "admin", adminPassword: "password", audience: "product-api",
    fetch: async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      if (url.endsWith("/realms/master/protocol/openid-connect/token")) return Response.json({ access_token: "token" })
      if (url.includes("/clients?clientId=")) return Response.json(current ? [current] : [])
      if (method !== "GET") {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        mutations.push({ method, url, body })
        if (url.endsWith("/clients") && method === "POST") current = created ?? { ...body, id: "new-id" }
        if (url.endsWith("/client-secret")) return Response.json({ value: "secret" })
        return new Response(null, { status: 204 })
      }
      if (url.endsWith("/client-scopes")) return Response.json([{ id: "scope", name: "genioone-gateway-runtime" }])
      if (url.endsWith("/protocol-mappers/models")) return Response.json([])
      if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: "http://identity.test/realms/genio-one" })
      throw new Error(`Unexpected request: ${method} ${url}`)
    },
  })
  return { provisioner, mutations }
}

for (const [name, existing] of Object.entries({
  unmarked: { id: "other", clientId: identityInput.clientId },
  tenant: { ...ownedClient(), attributes: { ...ownership, "genioone.tenant-id": "tenant-other" } },
  runtime: { ...ownedClient(), attributes: { ...ownership, "genioone.runtime-id": "runtime-other" } },
  provisioner: { ...ownedClient(), attributes: { ...ownership, "genioone.provisioner": "application" } },
  malformed: { ...ownedClient(), attributes: [ownership] },
  malformedValue: { ...ownedClient(), attributes: { ...ownership, "genioone.tenant-id": ["tenant-acme"] } },
  missing: { ...ownedClient(), attributes: { "genioone.provisioner": "gateway-registration" } },
  clientId: { ...ownedClient(), clientId: "another-client" },
})) {
  for (const operation of ["provision", "revoke"] as const) {
    test(`${operation} rejects ${name} client before any mutation`, async () => {
      const { provisioner, mutations } = harness(existing)
      await assert.rejects(provisioner[operation](identityInput), /ownership/)
      assert.deepEqual(mutations, [])
    })
  }
}

test("owned client supports provisioning retries, preserves attributes, and revocation", async () => {
  const { provisioner, mutations } = harness(ownedClient())
  await provisioner.provision(identityInput)
  await provisioner.provision(identityInput)
  const updates = mutations.filter((entry) => entry.method === "PUT" && entry.url.endsWith("/internal-client-id"))
  assert.equal(updates.length, 2)
  assert.deepEqual((updates[0]!.body as { attributes: unknown }).attributes, ownedClient().attributes)
  assert.equal(mutations.filter((entry) => entry.url.endsWith("/client-secret")).length, 2)
  await provisioner.revoke(identityInput)
  assert.equal(mutations.at(-1)?.method, "DELETE")
})

test("new client receives server-owned ownership attributes", async () => {
  const { provisioner, mutations } = harness(null)
  await provisioner.provision(identityInput)
  assert.deepEqual((mutations[0]!.body as { attributes: unknown }).attributes, ownership)
})

test("new client lookup validates ownership before subsequent mutations", async () => {
  const { provisioner, mutations } = harness(null, { id: "raced-client", clientId: identityInput.clientId })
  await assert.rejects(provisioner.provision(identityInput), /ownership/)
  assert.equal(mutations.length, 1)
  assert.equal(mutations[0]?.method, "POST")
  assert.ok(mutations[0]?.url.endsWith("/clients"))
})

test("revoking an absent client is idempotent", async () => {
  const { provisioner, mutations } = harness(null)
  await provisioner.revoke(identityInput)
  await provisioner.revoke(identityInput)
  assert.deepEqual(mutations, [])
})
