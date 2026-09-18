import type { GatewayIdentityProvisioner } from "./module"
import type { HttpFetch } from "../../../../../../runtimes/gateway/services/shared/http-fetch"
import {
  keycloakRecords as records,
  keycloakRequired as required,
  keycloakResponseJson as responseJson,
  keycloakString as stringValue,
  type KeycloakJsonRecord as JsonRecord,
} from "../../keycloak/http"

export function createKeycloakGatewayIdentityProvisioner(options: {
  origin: string
  issuerOrigin: string
  realm: string
  adminUsername: string
  adminPassword: string
  audience: string
  scope?: string
  fetch?: HttpFetch
}): GatewayIdentityProvisioner {
  const fetchImpl = options.fetch ?? fetch
  const origin = required(options.origin, "Keycloak origin").replace(/\/$/, "")
  const issuerOrigin = required(options.issuerOrigin, "Keycloak issuer origin").replace(/\/$/, "")
  const realm = required(options.realm, "Keycloak realm")
  const realmPath = `/realms/${encodeURIComponent(realm)}`
  const expectedIssuer = `${issuerOrigin}${realmPath}`
  const audience = required(options.audience, "Gateway audience")
  const scopeName = options.scope?.trim() || "genioone-gateway-runtime"

  async function adminToken(): Promise<string> {
    const body = await responseJson(await fetchImpl(`${origin}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: options.adminUsername,
        password: options.adminPassword,
      }),
    }), "Keycloak Admin token") as JsonRecord
    return stringValue(body.access_token, "Keycloak Admin token")
  }

  async function client(token: string, clientId: string): Promise<JsonRecord | null> {
    const values = records(await responseJson(await fetchImpl(
      `${origin}/admin/realms/${encodeURIComponent(realm)}/clients?clientId=${encodeURIComponent(clientId)}`,
      { headers: { authorization: `Bearer ${token}` } },
    ), "Keycloak client lookup"), "Keycloak client lookup")
    if (values.length > 1) throw new Error(`Keycloak returned duplicate client ${clientId}`)
    return values[0] ?? null
  }

  async function ensureScope(token: string, internalClientId: string): Promise<void> {
    const scopeValues = records(await responseJson(await fetchImpl(
      `${origin}/admin/realms/${encodeURIComponent(realm)}/client-scopes`,
      { headers: { authorization: `Bearer ${token}` } },
    ), "Keycloak client scopes"), "Keycloak client scopes")
    const selected = scopeValues.find((entry) => entry.name === scopeName)
    const scopeId = selected ? stringValue(selected.id, "Gateway Runtime scope id") : null
    if (!scopeId) throw new Error(`Keycloak client scope ${scopeName} does not exist`)
    await responseJson(await fetchImpl(
      `${origin}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(internalClientId)}/default-client-scopes/${encodeURIComponent(scopeId)}`,
      { method: "PUT", headers: { authorization: `Bearer ${token}` } },
    ), "Keycloak Gateway Runtime scope assignment")
  }

  async function ensureMapper(
    token: string,
    internalClientId: string,
    mapper: JsonRecord,
  ): Promise<void> {
    const url = `${origin}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(internalClientId)}/protocol-mappers/models`
    const existing = records(await responseJson(await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
    }), "Keycloak protocol mappers"), "Keycloak protocol mappers")
      .find((entry) => entry.name === mapper.name)
    await responseJson(await fetchImpl(existing
      ? `${url}/${encodeURIComponent(stringValue(existing.id, "Keycloak mapper id"))}`
      : url, {
      method: existing ? "PUT" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(existing ? { ...mapper, id: existing.id } : mapper),
    }), "Keycloak protocol mapper")
  }

  return {
    async provision({ tenantId, runtimeId, clientId }) {
      const token = await adminToken()
      let existing = await client(token, clientId)
      const profile = {
        clientId,
        name: `GenioOne Gateway Runtime ${runtimeId}`,
        enabled: true,
        clientAuthenticatorType: "client-secret",
        publicClient: false,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: true,
        fullScopeAllowed: false,
      }
      if (existing) {
        await responseJson(await fetchImpl(
          `${origin}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(stringValue(existing.id, "Keycloak client id"))}`,
          {
            method: "PUT",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ ...existing, ...profile }),
          },
        ), "Keycloak Gateway Runtime client update")
      } else {
        await responseJson(await fetchImpl(`${origin}/admin/realms/${encodeURIComponent(realm)}/clients`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(profile),
        }), "Keycloak Gateway Runtime client creation")
        existing = await client(token, clientId)
      }
      const internalId = stringValue(existing?.id, "Keycloak Gateway Runtime client id")
      await ensureScope(token, internalId)
      await ensureMapper(token, internalId, {
        name: "genio-one-product-api-audience",
        protocol: "openid-connect",
        protocolMapper: "oidc-audience-mapper",
        config: {
          "included.client.audience": audience,
          "id.token.claim": "false",
          "access.token.claim": "true",
          "introspection.token.claim": "true",
        },
      })
      await ensureMapper(token, internalId, {
        name: "genio-one-tenant",
        protocol: "openid-connect",
        protocolMapper: "oidc-hardcoded-claim-mapper",
        config: {
          "claim.name": "tenant_id",
          "claim.value": tenantId,
          "jsonType.label": "String",
          "id.token.claim": "false",
          "access.token.claim": "true",
          "introspection.token.claim": "true",
        },
      })
      const secret = await responseJson(await fetchImpl(
        `${origin}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(internalId)}/client-secret`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ), "Keycloak Gateway Runtime secret") as JsonRecord
      const discovery = await responseJson(await fetchImpl(
        `${origin}${realmPath}/.well-known/openid-configuration`,
      ), "Keycloak discovery") as JsonRecord
      const discoveredIssuer = stringValue(discovery.issuer, "Keycloak issuer").replace(/\/$/, "")
      if (discoveredIssuer !== expectedIssuer) {
        throw new Error(`Keycloak issuer ${discoveredIssuer} does not match ${expectedIssuer}`)
      }
      return {
        issuer: discoveredIssuer,
        token_endpoint: `${origin}${realmPath}/protocol/openid-connect/token`,
        audience,
        scope: scopeName,
        client_id: clientId,
        client_secret: stringValue(secret.value, "Keycloak Gateway Runtime secret"),
      }
    },
    async revoke({ clientId }) {
      const token = await adminToken()
      const existing = await client(token, clientId)
      if (!existing) return
      await responseJson(await fetchImpl(
        `${origin}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(stringValue(existing.id, "Keycloak client id"))}`,
        { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
      ), "Keycloak Gateway Runtime client deletion")
    },
  }
}
