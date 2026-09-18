import type {
  Principal,
  PrincipalAuthenticator,
  PrincipalRole,
} from "./contract"
import { PRINCIPAL_ROLES } from "./contract"
import {
  createOidcPrincipalAuthenticator,
  type OidcTenantConfiguration,
} from "./oidc"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isPrincipalRole(value: unknown): value is PrincipalRole {
  return typeof value === "string" && (PRINCIPAL_ROLES as readonly string[]).includes(value)
}

/**
 * Return the external OIDC subjects that authenticate as each canonical
 * GenioOne subject. The same trusted mapping drives Management API identity
 * and the signed Gateway authorization bundle.
 */
export function oidcSubjectAliasesFromEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, readonly string[]>> {
  const raw = environment.GENIO_ONE_MANAGEMENT_API_OIDC_TENANTS_JSON
  if (!raw) return {}
  const tenants = JSON.parse(raw) as OidcTenantConfiguration[]
  const aliases = new Map<string, Set<string>>()
  for (const tenant of tenants) {
    for (const mapping of tenant.principal_mappings ?? []) {
      if (!isNonEmptyString(mapping.subject_id) || !isNonEmptyString(mapping.external_subject_id)) {
        throw new Error("Invalid OIDC principal mapping")
      }
      const values = aliases.get(mapping.subject_id) ?? new Set<string>()
      values.add(mapping.external_subject_id)
      aliases.set(mapping.subject_id, values)
    }
  }
  return Object.fromEntries(
    [...aliases.entries()].map(([subjectId, values]) => [subjectId, [...values].sort()]),
  )
}

/** Validate and clone an authenticator result before it becomes request context. */
export function normalizePrincipal(value: unknown): Principal | null {
  if (!isRecord(value)) return null
  if (!isNonEmptyString(value.tenant_id)) return null
  if (!isNonEmptyString(value.subject_id)) return null
  if (!isPrincipalRole(value.role)) return null
  if (
    !Array.isArray(value.organization_ids) ||
    !value.organization_ids.every(isNonEmptyString)
  ) {
    return null
  }
  if (!isNonEmptyString(value.client_id)) return null
  if (
    value.scopes !== undefined &&
    (!Array.isArray(value.scopes) || !value.scopes.every(isNonEmptyString))
  ) {
    return null
  }
  return {
    tenant_id: value.tenant_id.trim(),
    subject_id: value.subject_id.trim(),
    ...(isNonEmptyString(value.display_name) ? { display_name: value.display_name.trim() } : {}),
    ...(isNonEmptyString(value.email) ? { email: value.email.trim() } : {}),
    role: value.role,
    organization_ids: value.organization_ids.map((organizationId) => organizationId.trim()),
    client_id: value.client_id.trim(),
    ...(value.scopes === undefined
      ? {}
      : { scopes: [...new Set(value.scopes.map((scope) => scope.trim()))] }),
    ...(isRecord(value.external_identity) &&
      isNonEmptyString(value.external_identity.provider_id) &&
      isNonEmptyString(value.external_identity.external_subject_id)
      ? {
          external_identity: {
            provider_id: value.external_identity.provider_id.trim(),
            external_subject_id: value.external_identity.external_subject_id.trim(),
          },
        }
      : {}),
  }
}

function createFailClosedPrincipalAuthenticator(): PrincipalAuthenticator {
  return {
    authenticate() {
      return null
    },
  }
}

export function createStaticPrincipalAuthenticator(
  principals: ReadonlyMap<string, Principal> | Record<string, Principal>,
): PrincipalAuthenticator {
  const entries = principals instanceof Map ? principals.entries() : Object.entries(principals)
  const trusted = new Map<string, Principal>()
  for (const [token, principal] of entries) {
    const normalized = normalizePrincipal(principal)
    if (isNonEmptyString(token) && normalized) {
      trusted.set(token, normalized)
    }
  }
  return {
    authenticate({ token }) {
      const principal = trusted.get(token)
      return principal
        ? {
            ...principal,
            organization_ids: [...principal.organization_ids],
            ...(principal.scopes ? { scopes: [...principal.scopes] } : {}),
          }
        : null
    },
  }
}

/**
 * Explicit environment-backed adapter. This is not an OIDC implementation;
 * it is suitable only as a temporary, explicitly configured fixture.
 * Keycloak/OIDC verification is the next authenticator implementation. With
 * no explicit mode or a malformed configuration, the server fails closed.
 */
export function createEnvironmentPrincipalAuthenticator(
  environment: NodeJS.ProcessEnv = process.env,
): PrincipalAuthenticator {
  const mode = environment.GENIO_ONE_MANAGEMENT_API_AUTH_MODE ?? (environment.NODE_ENV === "production" ? "fail-closed" : "oidc")
  if (mode === "fail-closed") {
    return createFailClosedPrincipalAuthenticator()
  }

  if (mode === "oidc") {
    const raw = environment.GENIO_ONE_MANAGEMENT_API_OIDC_TENANTS_JSON
    let tenants: OidcTenantConfiguration[]
    if (!raw) {
      if (environment.NODE_ENV === "production") {
        throw new Error("GENIO_ONE_MANAGEMENT_API_OIDC_TENANTS_JSON is required in oidc mode")
      }
      const port = environment.GENIO_ONE_KEYCLOAK_PORT ?? "58080"
      const issuer = (environment.GENIO_ONE_KEYCLOAK_ISSUER_ORIGIN ?? `http://127.0.0.1:${port}`).replace(/\/$/, "") + "/realms/genio-one"
      tenants = [
        {
          tenant_id: environment.GENIO_ONE_TYPESCRIPT_PILOT_TENANT_ID ?? "tenant-keycloak-local",
          identity_provider_id: "keycloak-local",
          issuer,
          audiences: ["genio-one-product-api", "genio-one-self-service", "genio-one-management-console", "account"],
          jwks_uri: `${issuer}/protocol/openid-connect/certs`,
          algorithms: ["RS256"],
          claims: {
            subject: "sub",
            client: "azp",
            role: "realm_access.roles",
            organizations: "groups",
          },
        },
      ]
    } else {
      try {
        tenants = JSON.parse(raw) as OidcTenantConfiguration[]
      } catch {
        throw new Error("GENIO_ONE_MANAGEMENT_API_OIDC_TENANTS_JSON must be valid JSON")
      }
      if (!Array.isArray(tenants)) {
        throw new Error("GENIO_ONE_MANAGEMENT_API_OIDC_TENANTS_JSON must be an array")
      }
    }
    return createOidcPrincipalAuthenticator({
      tenants,
      allowInsecureLoopback: environment.NODE_ENV !== "production",
      allowInsecureHttp:
        environment.GENIO_ONE_MANAGEMENT_API_OIDC_ALLOW_INSECURE_HTTP === "true" ||
        environment.NODE_ENV !== "production",
    })
  }

  if (mode !== "static-dev") {
    throw new Error(`Unsupported GENIO_ONE_MANAGEMENT_API_AUTH_MODE ${mode}`)
  }
  if (environment.NODE_ENV === "production") {
    return createFailClosedPrincipalAuthenticator()
  }

  const raw = environment.GENIO_ONE_MANAGEMENT_API_PRINCIPALS_JSON
  if (!raw) return createFailClosedPrincipalAuthenticator()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return createFailClosedPrincipalAuthenticator()
    const principals: Record<string, Principal> = {}
    for (const [token, value] of Object.entries(parsed)) {
      const principal = normalizePrincipal(value)
      if (!principal) return createFailClosedPrincipalAuthenticator()
      principals[token] = principal
    }
    const staticAuthenticator = createStaticPrincipalAuthenticator(principals)
    const oidcRaw = environment.GENIO_ONE_MANAGEMENT_API_OIDC_TENANTS_JSON
    if (!oidcRaw) return staticAuthenticator
    const tenants = JSON.parse(oidcRaw) as OidcTenantConfiguration[]
    const oidcAuthenticator = createOidcPrincipalAuthenticator({
      tenants,
      allowInsecureLoopback: true,
    })
    return {
      async authenticate(input) {
        return await staticAuthenticator.authenticate(input) ??
          await oidcAuthenticator.authenticate(input)
      },
    }
  } catch {
    return createFailClosedPrincipalAuthenticator()
  }
}
