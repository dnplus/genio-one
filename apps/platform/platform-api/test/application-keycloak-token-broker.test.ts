import assert from "node:assert/strict"
import test from "node:test"

import { createKeycloakApplicationOAuthClientProvisioner } from "../src/capabilities/applications/keycloak"

test("Keycloak token broker uses the active Application client secret transiently", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = []
  const broker = createKeycloakApplicationOAuthClientProvisioner({
    origin: "https://keycloak.internal",
    issuerOrigin: "https://identity.example.test",
    realm: "genio-one",
    adminUsername: "admin",
    adminPassword: "admin-password",
    identityProviderId: "keycloak-local",
    async fetch(input, init) {
      const url = String(input)
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body instanceof URLSearchParams ? init.body.toString() : "",
      })
      if (url.includes("/realms/master/")) {
        return Response.json({ access_token: "admin-token" })
      }
      if (url.includes("/clients?clientId=")) {
        return Response.json([{ id: "internal-client", clientId: "genio-app-1" }])
      }
      if (url.endsWith("/client-secret")) {
        return Response.json({ value: "active-client-secret" })
      }
      if (url.endsWith("/protocol/openid-connect/token")) {
        return Response.json({
          access_token: "bounded-keycloak-token",
          token_type: "Bearer",
          expires_in: 300,
          scope: "genioone-invocation",
        })
      }
      return new Response(null, { status: 404 })
    },
  })

  const minted = await broker.mint({ clientId: "genio-app-1", scope: "genioone-invocation" })

  assert.equal(minted.accessToken, "bounded-keycloak-token")
  assert.equal(minted.expiresIn, 300)
  const secretRequest = requests.find((request) => request.url.endsWith("/client-secret"))
  assert.equal(secretRequest?.method, "GET")
  const tokenRequest = requests.find((request) =>
    request.url.endsWith("/realms/genio-one/protocol/openid-connect/token")
  )
  assert.match(tokenRequest?.body ?? "", /client_secret=active-client-secret/)
  assert.equal(JSON.stringify(minted).includes("active-client-secret"), false)
})
