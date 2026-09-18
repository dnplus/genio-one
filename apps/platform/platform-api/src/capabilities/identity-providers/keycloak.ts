import type { HttpFetch } from "../../../../../../runtimes/gateway/services/shared/http-fetch"
import { PlatformApiError } from "../errors"
import {
  keycloakRecords as records,
  keycloakRequired as required,
  keycloakResponseJson as responseJson,
  keycloakString as stringValue,
  type KeycloakJsonRecord as JsonRecord,
} from "../../keycloak/http"
import type { IdentityProvider, IdentityProviderList } from "./contract"
import type { IdentityProviderRegistry } from "./module"
import { identityProviderPresets, presetForStoredProvider } from "./presets"

/** Keycloak masks a stored client secret with this sentinel when reading back. */
const MASKED_SECRET = "**********"

function booleanValue(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  return fallback
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

/**
 * Only https is accepted, and only an absolute origin without embedded
 * credentials, so an operator cannot point discovery at a loopback service or
 * smuggle a userinfo component past the Keycloak Admin API.
 */
function assertDiscoveryUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PlatformApiError("IDENTITY_PROVIDER_DISCOVERY_URL_INVALID", 400, "The discovery URL is not a valid absolute URL")
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new PlatformApiError(
      "IDENTITY_PROVIDER_DISCOVERY_URL_INVALID",
      400,
      "The discovery URL must be an https URL without embedded credentials",
    )
  }
  return url.toString()
}

export function createKeycloakIdentityProviderRegistry(options: {
  origin: string
  realm: string
  adminUsername: string
  adminPassword: string
  /** Public Keycloak origin, used to render the upstream redirect URI. */
  issuerOrigin?: string
  fetch?: HttpFetch
}): IdentityProviderRegistry {
  const fetchImpl = options.fetch ?? fetch
  const origin = required(options.origin, "Keycloak origin").replace(/\/$/, "")
  const issuerOrigin = (options.issuerOrigin?.trim() || origin).replace(/\/$/, "")
  const realm = required(options.realm, "Keycloak realm")
  const realmPath = `/admin/realms/${encodeURIComponent(realm)}`
  const instances = `${origin}${realmPath}/identity-provider/instances`

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

  function redirectUri(alias: string): string {
    return `${issuerOrigin}/realms/${encodeURIComponent(realm)}/broker/${encodeURIComponent(alias)}/endpoint`
  }

  function present(record: JsonRecord): IdentityProvider {
    const alias = stringValue(record.alias, "Keycloak identity provider alias")
    const config = (record.config && typeof record.config === "object" && !Array.isArray(record.config)
      ? record.config
      : {}) as JsonRecord
    const preset = presetForStoredProvider(record.providerId, alias)
    return {
      alias,
      preset,
      kind: identityProviderPresets[preset].providerId === "oidc" ? "OIDC" : "SOCIAL",
      display_name: optionalString(record.displayName) ?? identityProviderPresets[preset].defaultDisplayName,
      enabled: booleanValue(record.enabled, true),
      hidden_on_login_page: booleanValue(config.hideOnLoginPage),
      trust_email: booleanValue(record.trustEmail),
      client_id: optionalString(config.clientId) ?? "",
      discovery_url: optionalString(config.genioDiscoveryUrl),
      authorization_url: optionalString(config.authorizationUrl),
      token_url: optionalString(config.tokenUrl),
      redirect_uri: redirectUri(alias),
    }
  }

  /**
   * Asks Keycloak to resolve an OIDC discovery document into endpoint config.
   * Keycloak performs the fetch, so GenioOne never issues the outbound request
   * itself and inherits Keycloak's own validation of the metadata.
   */
  async function importedConfig(token: string, discoveryUrl: string): Promise<JsonRecord> {
    const response = await fetchImpl(`${instances}/import-config`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ fromUrl: discoveryUrl, providerId: "oidc" }),
    })
    if (!response.ok) {
      throw new PlatformApiError(
        "IDENTITY_PROVIDER_DISCOVERY_FAILED",
        502,
        "The OpenID Connect discovery document could not be read from the supplied URL",
      )
    }
    const imported = await responseJson(response, "Keycloak identity provider discovery")
    if (!imported || typeof imported !== "object" || Array.isArray(imported)) {
      throw new PlatformApiError(
        "IDENTITY_PROVIDER_DISCOVERY_FAILED",
        502,
        "The OpenID Connect discovery document did not describe a usable provider",
      )
    }
    return imported as JsonRecord
  }

  async function read(token: string, alias: string): Promise<JsonRecord> {
    const response = await fetchImpl(`${instances}/${encodeURIComponent(alias)}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (response.status === 404) {
      throw new PlatformApiError("IDENTITY_PROVIDER_NOT_FOUND", 404, "The login method does not exist")
    }
    return await responseJson(response, "Keycloak identity provider") as JsonRecord
  }

  return {
    async list(input) {
      const token = await adminToken()
      const values = records(
        await responseJson(await fetchImpl(instances, { headers: { authorization: `Bearer ${token}` } }), "Keycloak identity providers"),
        "Keycloak identity providers",
      )
      return {
        tenant_id: input.tenantId,
        realm,
        providers: values
          .map(present)
          .sort((left, right) => left.alias.localeCompare(right.alias)),
      } satisfies IdentityProviderList
    },

    async create(input) {
      const preset = identityProviderPresets[input.value.preset]
      const alias = input.value.alias?.trim() || preset.defaultAlias
      const token = await adminToken()

      let config: JsonRecord = {}
      if (preset.requiresDiscoveryUrl) {
        if (!input.value.discovery_url) {
          throw new PlatformApiError(
            "IDENTITY_PROVIDER_DISCOVERY_URL_REQUIRED",
            400,
            "This login method needs an OpenID Connect discovery URL",
          )
        }
        const discoveryUrl = assertDiscoveryUrl(input.value.discovery_url)
        // Keep the operator's URL so the console can show what was configured;
        // Keycloak itself only stores the resolved endpoints.
        config = { ...await importedConfig(token, discoveryUrl), genioDiscoveryUrl: discoveryUrl }
      }
      config = {
        ...config,
        clientId: input.value.client_id,
        clientSecret: input.value.client_secret,
        hideOnLoginPage: String(input.value.hidden_on_login_page ?? false),
        ...(preset.defaultScopes && !config.defaultScope ? { defaultScope: preset.defaultScopes } : {}),
      }

      const response = await fetchImpl(instances, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          alias,
          providerId: preset.providerId,
          displayName: input.value.display_name?.trim() || preset.defaultDisplayName,
          enabled: input.value.enabled ?? true,
          trustEmail: input.value.trust_email ?? false,
          storeToken: false,
          linkOnly: false,
          config,
        }),
      })
      if (response.status === 409) {
        throw new PlatformApiError(
          "IDENTITY_PROVIDER_ALREADY_EXISTS",
          409,
          "A login method with this alias already exists",
        )
      }
      await responseJson(response, "Keycloak identity provider creation")
      return present(await read(token, alias))
    },

    async update(input) {
      const token = await adminToken()
      const current = await read(token, input.alias)
      const currentConfig = (current.config && typeof current.config === "object" && !Array.isArray(current.config)
        ? current.config
        : {}) as JsonRecord

      let config: JsonRecord = { ...currentConfig }
      if (input.value.discovery_url) {
        const discoveryUrl = assertDiscoveryUrl(input.value.discovery_url)
        config = { ...config, ...await importedConfig(token, discoveryUrl), genioDiscoveryUrl: discoveryUrl }
      }
      if (input.value.client_id !== undefined) config.clientId = input.value.client_id
      // An omitted secret must not overwrite the stored one, and Keycloak's own
      // mask must never be written back as if it were a real credential.
      if (input.value.client_secret !== undefined && input.value.client_secret !== MASKED_SECRET) {
        config.clientSecret = input.value.client_secret
      } else {
        delete config.clientSecret
      }
      if (input.value.hidden_on_login_page !== undefined) {
        config.hideOnLoginPage = String(input.value.hidden_on_login_page)
      }

      await responseJson(await fetchImpl(`${instances}/${encodeURIComponent(input.alias)}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          ...current,
          alias: input.alias,
          ...(input.value.display_name !== undefined ? { displayName: input.value.display_name } : {}),
          ...(input.value.enabled !== undefined ? { enabled: input.value.enabled } : {}),
          ...(input.value.trust_email !== undefined ? { trustEmail: input.value.trust_email } : {}),
          config,
        }),
      }), "Keycloak identity provider update")
      return present(await read(token, input.alias))
    },

    async remove(input) {
      const token = await adminToken()
      const response = await fetchImpl(`${instances}/${encodeURIComponent(input.alias)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      })
      if (response.status === 404) {
        throw new PlatformApiError("IDENTITY_PROVIDER_NOT_FOUND", 404, "The login method does not exist")
      }
      await responseJson(response, "Keycloak identity provider removal")
    },
  }
}
