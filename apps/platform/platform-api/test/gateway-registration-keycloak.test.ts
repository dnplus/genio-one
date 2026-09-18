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
      return Response.json([{ id: "internal-client-id" }])
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
