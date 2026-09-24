import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose"

import type { Principal, PrincipalAuthenticator, PrincipalRole } from "./contract"
import { PRINCIPAL_ROLES } from "./contract"
import { normalizePrincipal } from "./memory"

const ASYMMETRIC_JWT_ALGORITHMS = new Set([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
])
const CLAIM_PATH = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/

export interface OidcClaimMapping {
  subject: string
  client: string
  role: string
  organizations: string
}

export interface OidcTenantConfiguration {
  tenant_id: string
  identity_provider_id?: string
  issuer: string
  audiences: string[]
  jwks_uri: string
  algorithms: string[]
  claims: OidcClaimMapping
  principal_mappings?: Array<{
    external_subject_id: string
    subject_id: string
    role: Principal["role"]
    organization_ids: string[]
  }>
}

export interface OidcPrincipalAuthenticatorOptions {
  tenants: readonly OidcTenantConfiguration[]
  allowInsecureLoopback?: boolean
  allowInsecureHttp?: boolean
  /** Test seam; production uses a cached remote JWKS resolver per tenant. */
  verifyToken?: (
    token: string,
    configuration: OidcTenantConfiguration,
  ) => Promise<JWTPayload>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function oidcUrl(
  value: string,
  field: string,
  allowInsecureLoopback: boolean,
  allowInsecureHttp: boolean,
): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid OIDC ${field}`)
  }
  const loopbackHttp =
    allowInsecureLoopback &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
  const explicitHttp = allowInsecureHttp && url.protocol === "http:"
  if (
    (url.protocol !== "https:" && !loopbackHttp && !explicitHttp) ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error(`Invalid OIDC ${field}`)
  }
  return value
}

function claimPath(value: unknown, field: string): string {
  if (!nonEmptyString(value) || !CLAIM_PATH.test(value)) {
    throw new Error(`Invalid OIDC claim mapping ${field}`)
  }
  return value
}

function validateConfiguration(
  value: OidcTenantConfiguration,
  allowInsecureLoopback: boolean,
  allowInsecureHttp: boolean,
): OidcTenantConfiguration {
  if (!nonEmptyString(value.tenant_id)) throw new Error("Invalid OIDC tenant_id")
  if (!Array.isArray(value.audiences) || value.audiences.length === 0) {
    throw new Error("Invalid OIDC audiences")
  }
  const audiences = value.audiences.map((audience) => audience.trim())
  if (audiences.some((audience) => !audience) || new Set(audiences).size !== audiences.length) {
    throw new Error("Invalid OIDC audiences")
  }
  if (!Array.isArray(value.algorithms) || value.algorithms.length === 0) {
    throw new Error("Invalid OIDC algorithms")
  }
  const algorithms = value.algorithms.map((algorithm) => algorithm.trim())
  if (
    algorithms.some((algorithm) => !ASYMMETRIC_JWT_ALGORITHMS.has(algorithm)) ||
    new Set(algorithms).size !== algorithms.length
  ) {
    throw new Error("Invalid OIDC algorithms")
  }
  if (!isRecord(value.claims)) throw new Error("Invalid OIDC claims")

  return {
    tenant_id: value.tenant_id.trim(),
    identity_provider_id: nonEmptyString(value.identity_provider_id)
      ? value.identity_provider_id.trim()
      : value.issuer,
    issuer: oidcUrl(value.issuer, "issuer", allowInsecureLoopback, allowInsecureHttp),
    audiences,
    jwks_uri: oidcUrl(value.jwks_uri, "jwks_uri", allowInsecureLoopback, allowInsecureHttp),
    algorithms,
    claims: {
      subject: claimPath(value.claims.subject, "subject"),
      client: claimPath(value.claims.client, "client"),
      role: claimPath(value.claims.role, "role"),
      organizations: claimPath(value.claims.organizations, "organizations"),
    },
    ...(value.principal_mappings
      ? {
          principal_mappings: value.principal_mappings.map((mapping) => {
            const principal = normalizePrincipal({
              tenant_id: value.tenant_id,
              subject_id: mapping.subject_id,
              role: mapping.role,
              organization_ids: mapping.organization_ids,
              client_id: "bootstrap-validation",
            })
            if (!nonEmptyString(mapping.external_subject_id) || !principal) {
              throw new Error("Invalid OIDC principal mapping")
            }
            return {
              external_subject_id: mapping.external_subject_id.trim(),
              subject_id: principal.subject_id,
              role: principal.role,
              organization_ids: principal.organization_ids,
            }
          }),
        }
      : {}),
  }
}

function claim(payload: JWTPayload, path: string): unknown {
  let value: unknown = payload
  for (const segment of path.split(".")) {
    // Check Object.hasOwn to prevent prototype chain traversal (e.g. __proto__, constructor)
    if (!isRecord(value) || !Object.hasOwn(value, segment)) return undefined
    value = value[segment]
  }
  return value
}

function oauthScopes(payload: JWTPayload): string[] | undefined {
  if (typeof payload.scope === "string") {
    return [...new Set(payload.scope.split(/\s+/).map((scope) => scope.trim()).filter(Boolean))]
  }
  if (Array.isArray(payload.scp) && payload.scp.every(nonEmptyString)) {
    return [...new Set(payload.scp.map((scope) => scope.trim()))]
  }
  return undefined
}

function principalFromPayload(
  configuration: OidcTenantConfiguration,
  payload: JWTPayload,
): Principal | null {
  const externalSubject = claim(payload, configuration.claims.subject)
  const client = claim(payload, configuration.claims.client)
  if (!nonEmptyString(externalSubject) || !nonEmptyString(client)) return null
  // Keycloak names the provider that actually authenticated a brokered sign-in
  // in `identity_provider`; without it every login looks like it came from
  // Keycloak itself, which is useless for attribution once more than one login
  // method exists. A local password login carries no such claim and keeps the
  // configured issuer identity, so existing bindings continue to resolve.
  const brokeredProvider = claim(payload, "identity_provider")
  const issuerProviderId = configuration.identity_provider_id ?? configuration.issuer
  const external_identity = {
    provider_id: nonEmptyString(brokeredProvider)
      ? `${issuerProviderId}:${brokeredProvider}`
      : issuerProviderId,
    external_subject_id: externalSubject,
  }
  const scopes = oauthScopes(payload)
  const display_name = profileClaim(payload, "name") ?? profileClaim(payload, "preferred_username")
  const email = profileClaim(payload, "email")
  const profile = {
    ...(display_name ? { display_name } : {}),
    ...(email ? { email } : {}),
  }

  const mapped = configuration.principal_mappings?.find(
    (mapping) => mapping.external_subject_id === externalSubject,
  )
  if (mapped && nonEmptyString(client)) {
    return normalizePrincipal({
      tenant_id: configuration.tenant_id,
      subject_id: mapped.subject_id,
      role: mapped.role,
      organization_ids: mapped.organization_ids,
      client_id: client,
      ...(scopes === undefined ? {} : { scopes }),
      ...profile,
      external_identity,
    })
  }
  const organizationValue = claim(payload, configuration.claims.organizations)
  const organizations = Array.isArray(organizationValue) && organizationValue.every(nonEmptyString)
    ? [...new Set(organizationValue.map((value) => value.trim()))]
    : []

  return normalizePrincipal({
    tenant_id: configuration.tenant_id,
    subject_id: claim(payload, configuration.claims.subject),
    client_id: claim(payload, configuration.claims.client),
    role: canonicalRoleFromClaim(claim(payload, configuration.claims.role)) ?? undefined,
    organization_ids: organizations,
    ...(scopes === undefined ? {} : { scopes }),
    ...profile,
    external_identity,
  })
}

function profileClaim(payload: JWTPayload, path: string): string | undefined {
  const value = claim(payload, path)
  return nonEmptyString(value) ? value.trim() : undefined
}

function canonicalRoleFromClaim(value: unknown): PrincipalRole | null {
  if (value === undefined || value === null) return "USER"
  if (typeof value === "string") {
    return (PRINCIPAL_ROLES as readonly string[]).includes(value) ? value as PrincipalRole : null
  }
  if (Array.isArray(value)) {
    const mapped = value.find((item): item is PrincipalRole =>
      typeof item === "string" && (PRINCIPAL_ROLES as readonly string[]).includes(item),
    )
    return mapped ?? "USER"
  }
  return null
}

/**
 * Verify a tenant-scoped OIDC access token against a preconfigured issuer.
 *
 * The request path chooses the tenant configuration. Unverified `iss`,
 * tenant, role, and organization claims never choose a trust root.
 */
export function createOidcPrincipalAuthenticator(
  options: OidcPrincipalAuthenticatorOptions,
): PrincipalAuthenticator {
  const configurations = new Map<string, OidcTenantConfiguration>()
  const verifiers = new Map<string, (token: string) => Promise<JWTPayload>>()

  for (const candidate of options.tenants) {
    const configuration = validateConfiguration(
      candidate,
      options.allowInsecureLoopback === true,
      options.allowInsecureHttp === true,
    )
    if (configurations.has(configuration.tenant_id)) {
      throw new Error(`Duplicate OIDC tenant ${configuration.tenant_id}`)
    }
    configurations.set(configuration.tenant_id, configuration)
    if (!options.verifyToken) {
      const jwks = createRemoteJWKSet(new URL(configuration.jwks_uri))
      verifiers.set(configuration.tenant_id, async (token) => {
        const result = await jwtVerify(token, jwks, {
          issuer: configuration.issuer,
          audience: configuration.audiences,
          algorithms: configuration.algorithms,
        })
        return result.payload
      })
    }
  }

  return {
    async authenticate({ token, tenantId }) {
      const configuration = configurations.get(tenantId)
      if (!configuration) return null
      try {
        const payload = options.verifyToken
          ? await options.verifyToken(token, configuration)
          : await verifiers.get(tenantId)!(token)
        return principalFromPayload(configuration, payload)
      } catch {
        return null
      }
    },
  }
}
