import type { ApplicationOAuthClientProvisioner } from "./module"
import type { ApplicationTokenBroker } from "../federation/module"
import type { HttpFetch } from "../../../../../../runtimes/gateway/services/shared/http-fetch"
import {
  keycloakRecords as records,
  keycloakRequired as required,
  keycloakResponseJson as responseJson,
  keycloakString as stringValue,
  type KeycloakJsonRecord as JsonRecord,
} from "../../keycloak/http"

export function createKeycloakApplicationOAuthClientProvisioner(options: {
  origin: string
  issuerOrigin: string
  realm: string
  adminUsername: string
  adminPassword: string
  identityProviderId: string
  fetch?: HttpFetch
}): ApplicationOAuthClientProvisioner & ApplicationTokenBroker {
  const fetchImpl = options.fetch ?? fetch
  const origin = required(options.origin, "Keycloak origin").replace(/\/$/, "")
  const issuerOrigin = required(options.issuerOrigin, "Keycloak issuer origin").replace(/\/$/, "")
  const realm = required(options.realm, "Keycloak realm")
  const identityProviderId = required(options.identityProviderId, "Keycloak identity provider id")
  const realmPath = `/realms/${encodeURIComponent(realm)}`
  const issuer = `${issuerOrigin}${realmPath}`

  async function adminToken(): Promise<string> {
    const value = await responseJson(await fetchImpl(`${origin}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: options.adminUsername,
        password: options.adminPassword,
      }),
    }), "Keycloak Admin token") as JsonRecord
    return stringValue(value.access_token, "Keycloak Admin token")
  }

  async function client(token: string, clientId: string): Promise<JsonRecord | null> {
    const values = records(await responseJson(await fetchImpl(
      `${origin}/admin/realms/${encodeURIComponent(realm)}/clients?clientId=${encodeURIComponent(clientId)}`,
      { headers: { authorization: `Bearer ${token}` } },
    ), "Keycloak Application client lookup"), "Keycloak Application client lookup")
    if (values.length > 1) throw new Error(`Keycloak returned duplicate client ${clientId}`)
    return values[0] ?? null
  }

  async function ensureScope(token: string, internalClientId: string, scopeName: string): Promise<void> {
    const scopes = records(await responseJson(await fetchImpl(
      `${origin}/admin/realms/${encodeURIComponent(realm)}/client-scopes`,
      { headers: { authorization: `Bearer ${token}` } },
    ), "Keycloak client scopes"), "Keycloak client scopes")
    const scope = scopes.find((entry) => entry.name === scopeName)
    const scopeId = stringValue(scope?.id, `Keycloak client scope ${scopeName}`)
    await responseJson(await fetchImpl(
      `${origin}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(internalClientId)}/default-client-scopes/${encodeURIComponent(scopeId)}`,
      { method: "PUT", headers: { authorization: `Bearer ${token}` } },
    ), "Keycloak Application scope assignment")
  }

  async function ensureMapper(
    token: string,
    internalClientId: string,
    mapper: JsonRecord,
  ): Promise<void> {
    const url = `${origin}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(internalClientId)}/protocol-mappers/models`
    const existing = records(await responseJson(await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
    }), "Keycloak Application mappers"), "Keycloak Application mappers")
      .find((entry) => entry.name === mapper.name)
    await responseJson(await fetchImpl(existing
      ? `${url}/${encodeURIComponent(stringValue(existing.id, "Keycloak Application mapper id"))}`
      : url, {
      method: existing ? "PUT" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(existing ? { ...mapper, id: existing.id } : mapper),
    }), "Keycloak Application mapper")
  }

  return {
    async provision(input) {
      if (input.issuer.replace(/\/$/, "") !== issuer) {
        throw new Error(`Application issuer ${input.issuer} does not match ${issuer}`)
      }
      const token = await adminToken()
      let existing = await client(token, input.clientId)
      const profile = {
        clientId: input.clientId,
        name: `GenioOne Application ${input.applicationId}`,
        description: input.credentialId,
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
          `${origin}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(stringValue(existing.id, "Keycloak Application client id"))}`,
          {
            method: "PUT",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ ...existing, ...profile }),
          },
        ), "Keycloak Application client update")
      } else {
        await responseJson(await fetchImpl(`${origin}/admin/realms/${encodeURIComponent(realm)}/clients`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(profile),
        }), "Keycloak Application client creation")
        existing = await client(token, input.clientId)
      }
      const internalId = stringValue(existing?.id, "Keycloak Application client id")
      await ensureScope(token, internalId, input.scope)
      await ensureMapper(token, internalId, {
        name: "genio-one-resource-audience",
        protocol: "openid-connect",
        protocolMapper: "oidc-audience-mapper",
        config: {
          "included.client.audience": input.audience,
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
          "claim.value": input.tenantId,
          "jsonType.label": "String",
          "id.token.claim": "false",
          "access.token.claim": "true",
          "introspection.token.claim": "true",
        },
      })
      const serviceAccount = await responseJson(await fetchImpl(
        `${origin}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(internalId)}/service-account-user`,
        { headers: { authorization: `Bearer ${token}` } },
      ), "Keycloak Application service account") as JsonRecord
      const secret = await responseJson(await fetchImpl(
        `${origin}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(internalId)}/client-secret`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ), "Keycloak Application secret") as JsonRecord
      return {
        clientId: input.clientId,
        clientSecret: stringValue(secret.value, "Keycloak Application secret"),
        tokenEndpoint: `${issuer}/protocol/openid-connect/token`,
        issuer,
        externalSubjectId: stringValue(serviceAccount.id, "Keycloak Application service account id"),
        identityProviderId,
      }
    },
    async revoke({ clientId }) {
      const token = await adminToken()
      const existing = await client(token, clientId)
      if (!existing) return
      await responseJson(await fetchImpl(
        `${origin}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(stringValue(existing.id, "Keycloak Application client id"))}`,
        { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
      ), "Keycloak Application client deletion")
    },
    async mint({ clientId, scope }) {
      const token = await adminToken()
      const existing = await client(token, clientId)
      const internalId = stringValue(existing?.id, "Keycloak Application client id")
      const secret = await responseJson(await fetchImpl(
        `${origin}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(internalId)}/client-secret`,
        { headers: { authorization: `Bearer ${token}` } },
      ), "Keycloak Application secret") as JsonRecord
      const response = await responseJson(await fetchImpl(
        `${origin}${realmPath}/protocol/openid-connect/token`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: stringValue(secret.value, "Keycloak Application secret"),
            scope,
          }),
        },
      ), "Keycloak Application token") as JsonRecord
      const expiresIn = Number(response.expires_in)
      if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 3600) {
        throw new Error("Keycloak Application token expiry is invalid")
      }
      const tokenScope = stringValue(response.scope, "Keycloak Application token scope")
      const tokenScopes = [...new Set(tokenScope.split(/\s+/).filter(Boolean))].sort()
      const requestedScopes = [...new Set(scope.split(/\s+/).filter(Boolean))].sort()
      if (
        tokenScopes.length !== requestedScopes.length ||
        tokenScopes.some((value, index) => value !== requestedScopes[index])
      ) {
        throw new Error("Keycloak Application token scope is invalid")
      }
      return {
        accessToken: stringValue(response.access_token, "Keycloak Application access token"),
        tokenType: "Bearer",
        expiresIn,
        scope: tokenScope,
      }
    },
  }
}
