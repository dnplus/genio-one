import assert from "node:assert/strict"
import test from "node:test"

import { createKeycloakSubjectSessionControl, externalSubjectIdsFor } from "../src/capabilities/identity/keycloak"

const options = {
  origin: "https://identity.internal",
  realm: "genio-one",
  adminUsername: "admin",
  adminPassword: "admin-secret",
}

function keycloakDouble(userStatus = 200) {
  const requests: Array<{ url: string; method: string; body: unknown }> = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString()
    const method = init?.method ?? "GET"
    requests.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined })
    if (url.endsWith("/protocol/openid-connect/token")) {
      return Response.json({ access_token: "admin-token" })
    }
    if (url.endsWith("/logout")) return new Response(null, { status: 204 })
    if (method === "PUT") return new Response(null, { status: 204 })
    if (userStatus === 404) return new Response(null, { status: 404 })
    return Response.json({ id: "external-1", username: "ada", enabled: true })
  }
  return { requests, fetchImpl: fetchImpl as unknown as typeof fetch }
}

test("disabling a Subject turns the account off and ends its sessions", async () => {
  const double = keycloakDouble()
  const control = createKeycloakSubjectSessionControl({ ...options, fetch: double.fetchImpl })

  const result = await control.disable({ externalSubjectId: "external-1" })

  assert.equal(result.applied, true)
  const update = double.requests.find((request) => request.method === "PUT")
  assert.equal((update!.body as { enabled: boolean }).enabled, false)
  // Disabling alone would leave a live session usable until it expired.
  assert.ok(double.requests.some((request) => request.method === "POST" && request.url.endsWith("/logout")))
})

test("restoring a Subject re-enables the account without forcing a logout", async () => {
  const double = keycloakDouble()
  const control = createKeycloakSubjectSessionControl({ ...options, fetch: double.fetchImpl })

  const result = await control.enable({ externalSubjectId: "external-1" })

  assert.equal(result.applied, true)
  const update = double.requests.find((request) => request.method === "PUT")
  assert.equal((update!.body as { enabled: boolean }).enabled, true)
  assert.ok(!double.requests.some((request) => request.url.endsWith("/logout")))
})

test("an account the provider does not know is reported as not applied rather than failing", async () => {
  const double = keycloakDouble(404)
  const control = createKeycloakSubjectSessionControl({ ...options, fetch: double.fetchImpl })

  // The Subject may be federated from a provider GenioOne does not administer;
  // the local suspension still stands.
  assert.deepEqual(await control.disable({ externalSubjectId: "absent" }), { applied: false })
  assert.ok(!double.requests.some((request) => request.method === "PUT"))
})

test("the update preserves the fields the provider already holds", async () => {
  const double = keycloakDouble()
  const control = createKeycloakSubjectSessionControl({ ...options, fetch: double.fetchImpl })

  await control.disable({ externalSubjectId: "external-1" })

  const update = double.requests.find((request) => request.method === "PUT")!
  assert.equal((update.body as { username: string }).username, "ada")
})

test("external subject ids resolve per Subject and de-duplicate", () => {
  const bindings = [
    { provider_id: "keycloak", external_subject_id: "external-1", subject_id: "person-1" },
    { provider_id: "keycloak:entra-id", external_subject_id: "external-1", subject_id: "person-1" },
    { provider_id: "keycloak", external_subject_id: "external-2", subject_id: "person-2" },
  ]
  assert.deepEqual(externalSubjectIdsFor(bindings, "person-1"), ["external-1"])
  assert.deepEqual(externalSubjectIdsFor(bindings, "person-2"), ["external-2"])
  assert.deepEqual(externalSubjectIdsFor(bindings, "absent"), [])
})
