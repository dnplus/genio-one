import { describe, expect, it } from "bun:test"

import { createKeycloakIdentityProviderRegistry } from "../src/capabilities/identity-providers/keycloak"
import { isPlatformApiError } from "../src/capabilities/errors"

interface RecordedRequest {
  url: string
  method: string
  body: unknown
}

function keycloakDouble(options: {
  instances?: Record<string, unknown>[]
  importConfig?: Record<string, unknown>
  importStatus?: number
  createStatus?: number
  readStatus?: number
} = {}) {
  const requests: RecordedRequest[] = []
  const stored = new Map<string, Record<string, unknown>>(
    (options.instances ?? []).map((entry) => [entry.alias as string, entry]),
  )
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString()
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : init?.body
    requests.push({ url, method, body })

    if (url.endsWith("/protocol/openid-connect/token")) return json({ access_token: "admin-token" })
    if (url.endsWith("/identity-provider/instances/import-config")) {
      if (options.importStatus && options.importStatus !== 200) return json({ error: "failed" }, options.importStatus)
      return json(options.importConfig ?? {
        authorizationUrl: "https://idp.example.com/authorize",
        tokenUrl: "https://idp.example.com/token",
        issuer: "https://idp.example.com",
      })
    }
    if (url.endsWith("/identity-provider/instances")) {
      if (method === "POST") {
        const value = body as Record<string, unknown>
        if (options.createStatus && options.createStatus !== 201) return json({ error: "conflict" }, options.createStatus)
        stored.set(value.alias as string, value)
        return new Response(null, { status: 201 })
      }
      return json([...stored.values()])
    }
    const alias = decodeURIComponent(url.split("/identity-provider/instances/")[1] ?? "")
    if (!alias) return json({ error: "not found" }, 404)
    if (method === "DELETE") {
      if (!stored.has(alias)) return new Response(null, { status: 404 })
      stored.delete(alias)
      return new Response(null, { status: 204 })
    }
    if (method === "PUT") {
      stored.set(alias, body as Record<string, unknown>)
      return new Response(null, { status: 204 })
    }
    if (options.readStatus === 404 || !stored.has(alias)) return new Response(null, { status: 404 })
    return json(stored.get(alias))
  }

  return { requests, stored, fetchImpl: fetchImpl as unknown as typeof fetch }
}

function registryFor(double: ReturnType<typeof keycloakDouble>) {
  return createKeycloakIdentityProviderRegistry({
    origin: "https://identity.internal",
    issuerOrigin: "https://identity.example.com",
    realm: "genio-one",
    adminUsername: "admin",
    adminPassword: "admin-secret",
    fetch: double.fetchImpl,
  })
}

describe("identity provider registry", () => {
  it("creates a social preset without a discovery lookup and reports the upstream redirect URI", async () => {
    const double = keycloakDouble()
    const provider = await registryFor(double).create({
      tenantId: "tenant-a",
      value: { preset: "google", client_id: "google-client", client_secret: "google-secret" },
    })

    expect(provider.alias).toBe("google")
    expect(provider.kind).toBe("SOCIAL")
    expect(provider.display_name).toBe("Google")
    // The console shows operators exactly what to allow-list upstream, and it
    // must use the public issuer origin rather than the internal admin origin.
    expect(provider.redirect_uri).toBe(
      "https://identity.example.com/realms/genio-one/broker/google/endpoint",
    )
    expect(double.requests.some((request) => request.url.includes("import-config"))).toBe(false)
  })

  it("resolves an Entra ID preset through Keycloak discovery and keeps the operator's URL", async () => {
    const double = keycloakDouble()
    const provider = await registryFor(double).create({
      tenantId: "tenant-a",
      value: {
        preset: "entra-id",
        client_id: "entra-client",
        client_secret: "entra-secret",
        discovery_url: "https://login.microsoftonline.com/tid/v2.0/.well-known/openid-configuration",
      },
    })

    expect(provider.kind).toBe("OIDC")
    expect(provider.discovery_url).toBe(
      "https://login.microsoftonline.com/tid/v2.0/.well-known/openid-configuration",
    )
    expect(provider.authorization_url).toBe("https://idp.example.com/authorize")
    const created = double.stored.get("entra-id") as Record<string, unknown>
    expect((created.config as Record<string, unknown>).clientId).toBe("entra-client")
  })

  it("refuses a preset that needs discovery when no URL is supplied", async () => {
    const double = keycloakDouble()
    const failure = await registryFor(double).create({
      tenantId: "tenant-a",
      value: { preset: "okta", client_id: "okta-client", client_secret: "okta-secret" },
    }).catch((error: unknown) => error)

    expect(isPlatformApiError(failure) && failure.code).toBe("IDENTITY_PROVIDER_DISCOVERY_URL_REQUIRED")
    expect(double.requests.some((request) => request.method === "POST" && request.url.endsWith("instances"))).toBe(false)
  })

  it("rejects a discovery URL that is not https or carries embedded credentials", async () => {
    const double = keycloakDouble()
    const registry = registryFor(double)
    for (const discoveryUrl of [
      "http://idp.example.com/.well-known/openid-configuration",
      "https://user:pass@idp.example.com/.well-known/openid-configuration",
      "not-a-url",
    ]) {
      const failure = await registry.create({
        tenantId: "tenant-a",
        value: { preset: "oidc", client_id: "c", client_secret: "s", discovery_url: discoveryUrl },
      }).catch((error: unknown) => error)
      expect(isPlatformApiError(failure) && failure.code).toBe("IDENTITY_PROVIDER_DISCOVERY_URL_INVALID")
    }
    expect(double.requests.some((request) => request.url.includes("import-config"))).toBe(false)
  })

  it("surfaces a discovery document that Keycloak cannot read as a gateway error", async () => {
    const double = keycloakDouble({ importStatus: 502 })
    const failure = await registryFor(double).create({
      tenantId: "tenant-a",
      value: {
        preset: "okta",
        client_id: "okta-client",
        client_secret: "okta-secret",
        discovery_url: "https://unreachable.example.com/.well-known/openid-configuration",
      },
    }).catch((error: unknown) => error)

    expect(isPlatformApiError(failure) && failure.code).toBe("IDENTITY_PROVIDER_DISCOVERY_FAILED")
  })

  it("never returns an upstream client secret when listing", async () => {
    const double = keycloakDouble({
      instances: [{
        alias: "okta",
        providerId: "oidc",
        displayName: "Okta",
        enabled: true,
        config: { clientId: "okta-client", clientSecret: "**********", hideOnLoginPage: "false" },
      }],
    })
    const list = await registryFor(double).list({ tenantId: "tenant-a" })

    expect(list.providers).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain("clientSecret")
    expect(JSON.stringify(list)).not.toContain("**********")
    expect(list.providers[0]!.client_id).toBe("okta-client")
  })

  it("keeps the stored secret when an update omits it, and never writes back Keycloak's mask", async () => {
    const double = keycloakDouble({
      instances: [{
        alias: "okta",
        providerId: "oidc",
        displayName: "Okta",
        enabled: true,
        config: { clientId: "okta-client", clientSecret: "**********" },
      }],
    })
    await registryFor(double).update({
      tenantId: "tenant-a",
      alias: "okta",
      value: { display_name: "Okta Production" },
    })

    const update = double.requests.find((request) => request.method === "PUT")!
    const config = (update.body as Record<string, unknown>).config as Record<string, unknown>
    expect(config.clientSecret).toBeUndefined()
    expect((update.body as Record<string, unknown>).displayName).toBe("Okta Production")
  })

  it("writes a replacement secret when one is supplied", async () => {
    const double = keycloakDouble({
      instances: [{ alias: "okta", providerId: "oidc", enabled: true, config: { clientId: "okta-client" } }],
    })
    await registryFor(double).update({
      tenantId: "tenant-a",
      alias: "okta",
      value: { client_secret: "rotated-secret" },
    })

    const update = double.requests.find((request) => request.method === "PUT")!
    const config = (update.body as Record<string, unknown>).config as Record<string, unknown>
    expect(config.clientSecret).toBe("rotated-secret")
  })

  it("reports a missing login method as not found on update and delete", async () => {
    const double = keycloakDouble()
    const registry = registryFor(double)
    for (const attempt of [
      registry.update({ tenantId: "tenant-a", alias: "absent", value: { enabled: false } }),
      registry.remove({ tenantId: "tenant-a", alias: "absent" }),
    ]) {
      const failure = await attempt.catch((error: unknown) => error)
      expect(isPlatformApiError(failure) && failure.code).toBe("IDENTITY_PROVIDER_NOT_FOUND")
    }
  })

  it("reports a duplicate alias as a conflict", async () => {
    const double = keycloakDouble({ createStatus: 409 })
    const failure = await registryFor(double).create({
      tenantId: "tenant-a",
      value: { preset: "google", client_id: "google-client", client_secret: "google-secret" },
    }).catch((error: unknown) => error)

    expect(isPlatformApiError(failure) && failure.code).toBe("IDENTITY_PROVIDER_ALREADY_EXISTS")
  })

  it("removes a login method", async () => {
    const double = keycloakDouble({
      instances: [{ alias: "github", providerId: "github", enabled: true, config: {} }],
    })
    await registryFor(double).remove({ tenantId: "tenant-a", alias: "github" })
    expect(double.stored.has("github")).toBe(false)
  })
})
