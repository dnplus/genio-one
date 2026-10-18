import { createHash, randomBytes } from "node:crypto"
import {
  GENIOONE_SCOPES,
  MANAGEMENT_SCOPE_VALUES,
  RESOURCE_SCOPE_VALUES,
  isGenioOneScope,
} from "@genioone/protocol/authorization-scopes"

import { PlatformApiError } from "../errors"
import type { PrincipalAuthenticator } from "../tenancy-auth/contract"
import type { ApplicationRegistry } from "./module"
import type { ApplicationApiKeyCredential, IssueApplicationApiKeyCredentialInput } from "./contract"

export const APPLICATION_API_KEY_PREFIX = "genio_app_"
export const APPLICATION_API_KEY_MAX_LIFETIME_SECONDS = 365 * 86400

const keyPattern = /^genio_app_[A-Za-z0-9_-]{43}$/
const platformScopes = new Set<string>([
  GENIOONE_SCOPES.read,
  GENIOONE_SCOPES.write,
  ...MANAGEMENT_SCOPE_VALUES,
])
const resourceScopes = new Set<string>(RESOURCE_SCOPE_VALUES)

export function applicationApiKeyHash(token: string): string | null {
  return keyPattern.test(token) ? createHash("sha256").update(token).digest("hex") : null
}

export function createApplicationApiKeyMaterial(): { secret: string; hash: string; prefix: string } {
  const secret = `${APPLICATION_API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`
  return { secret, hash: applicationApiKeyHash(secret)!, prefix: secret.slice(0, 18) }
}

export function validateApplicationApiKeyInput(value: IssueApplicationApiKeyCredentialInput, now: number) {
  const displayName = value.display_name.trim()
  if (!displayName || displayName.length > 256) throw new PlatformApiError("API_KEY_DISPLAY_NAME_INVALID", 422)
  if (!Number.isSafeInteger(value.expires_at) || value.expires_at <= now || value.expires_at > now + APPLICATION_API_KEY_MAX_LIFETIME_SECONDS) {
    throw new PlatformApiError("API_KEY_EXPIRY_INVALID", 422)
  }
  const resourceId = value.resource_id?.trim() ?? null
  const capabilityId = value.capability_id?.trim() ?? null
  if (Boolean(resourceId) !== Boolean(capabilityId) || (value.resource_id !== undefined && !resourceId) || (value.capability_id !== undefined && !capabilityId)) {
    throw new PlatformApiError("API_KEY_TARGET_INVALID", 422)
  }
  const allowed = resourceId ? resourceScopes : platformScopes
  if (!value.scopes.length || value.scopes.length > 64 || new Set(value.scopes).size !== value.scopes.length || value.scopes.some(scope => !isGenioOneScope(scope) || !allowed.has(scope))) {
    throw new PlatformApiError("API_KEY_SCOPE_INVALID", 422)
  }
  return { displayName, resourceId, capabilityId, scopes: [...value.scopes].sort(), expiresAt: value.expires_at }
}

export function assertApplicationCredentialScopeCeiling(scopes: readonly string[], issuerScopes: readonly string[] | undefined): void {
  if (!issuerScopes || scopes.some(scope => !issuerScopes.includes(scope))) {
    throw new PlatformApiError("INSUFFICIENT_SCOPE", 403, "Credential scopes must be within the issuer's granted OAuth scopes")
  }
}

export function applicationApiKeyIsUsable(credential: ApplicationApiKeyCredential, now: number): boolean {
  return credential.expires_at > now && credential.revoked_at === null && (
    credential.state === "ACTIVE" ||
    (credential.state === "RETIRED" && credential.valid_until !== null && credential.valid_until > now)
  )
}

export function createApplicationApiKeyAuthenticator(options: {
  registry: ApplicationRegistry
  delegate: PrincipalAuthenticator
}): PrincipalAuthenticator {
  return {
    authenticate(input) {
      return input.token.startsWith(APPLICATION_API_KEY_PREFIX)
        ? options.registry.authenticateApiKey({ tenantId: input.tenantId, token: input.token })
        : options.delegate.authenticate(input)
    },
  }
}
