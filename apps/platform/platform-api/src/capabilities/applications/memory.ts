import { PlatformApiError } from "../errors"
import type { IdentityDirectory } from "../identity/module"
import type { OrganizationDirectory } from "../organizations/module"
import type { Application, ApplicationApiKeyCredential } from "./contract"
import {
  applicationApiKeyHash,
  assertApplicationCredentialScopeCeiling,
  applicationApiKeyIsUsable,
  createApplicationApiKeyMaterial,
  validateApplicationApiKeyInput,
} from "./api-keys"
import type { ApplicationRegistry } from "./module"

export function createInMemoryApplicationRegistry(options: {
  identity: IdentityDirectory
  organizations: OrganizationDirectory
  now?: () => number
  idFactory?: () => string
}): ApplicationRegistry {
  const values = new Map<string, Application>()
  const credentials = new Map<string, { value: ApplicationApiKeyCredential; hash: string; correlationId: string; tenantId: string }>()
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? (() => crypto.randomUUID())
  return {
    async list({ tenantId }) {
      return [...values.values()].filter((value) => value.tenant_id === tenantId)
    },
    async register({ tenantId, registeredBySubjectId, value }) {
      await options.organizations.get({
        tenantId,
        organizationId: value.owner_organization_id,
      })
      const suffix = idFactory()
      const applicationId = `application-${suffix}`
      const subjectId = `application-subject-${suffix}`
      if (values.has(`${tenantId}:${applicationId}`)) {
        throw new PlatformApiError("APPLICATION_EXISTS", 409)
      }
      await options.identity.bootstrap({
        tenantId,
        subjects: [{
          subject_id: subjectId,
          kind: "APPLICATION",
          display_name: value.display_name,
          role: "USER",
        }],
      })
      const application: Application = {
        tenant_id: tenantId,
        application_id: applicationId,
        subject_id: subjectId,
        display_name: value.display_name.trim(),
        owner_organization_id: value.owner_organization_id,
        registered_by: { subject_id: registeredBySubjectId, evidence_level: "VERIFIED" },
        created_at: now(),
      }
      values.set(`${tenantId}:${applicationId}`, application)
      return structuredClone(application)
    },
    async listCredentials({ tenantId, applicationId }) {
      return [...credentials.entries()].filter(([, entry]) => entry.tenantId === tenantId && entry.value.application_id === applicationId)
        .map(([, entry]) => structuredClone(entry.value)).sort((left, right) => right.generation - left.generation)
    },
    async issueApiKeyCredential({ tenantId, applicationId, value, issuerScopes }) {
      const at = now()
      const normalized = validateApplicationApiKeyInput(value, at)
      assertApplicationCredentialScopeCeiling(normalized.scopes, issuerScopes)
      const application = values.get(`${tenantId}:${applicationId}`)
      if (!application) throw new PlatformApiError("APPLICATION_NOT_FOUND", 404)
      const authorization = await options.identity.authorizationForSubject({ tenantId, subjectId: application.subject_id })
      if (!authorization.registered || authorization.suspended) throw new PlatformApiError("APPLICATION_SUBJECT_UNAVAILABLE", 403)
      if (normalized.resourceId) throw new PlatformApiError("APPLICATION_CREDENTIAL_RELEASE_PUBLISHER_UNAVAILABLE", 503)
      const previous = [...credentials.entries()].filter(([, entry]) => entry.tenantId === tenantId && entry.value.application_id === applicationId)
      if (previous.some(([, entry]) => entry.correlationId === value.correlation_id)) throw new PlatformApiError("APPLICATION_CREDENTIAL_SECRET_ALREADY_DELIVERED", 409)
      for (const [, entry] of previous) {
        if (entry.value.state === "ACTIVE" && entry.value.expires_at <= at) entry.value = { ...entry.value, state: "REVOKED", revoked_at: at }
      }
      if (previous.some(([, entry]) => entry.value.state === "ACTIVE")) throw new PlatformApiError("APPLICATION_CREDENTIAL_ACTIVE", 409)
      const material = createApplicationApiKeyMaterial()
      const credential: ApplicationApiKeyCredential = {
        credential_id: `application-credential-${idFactory()}`,
        application_id: applicationId,
        application_subject_id: application.subject_id,
        resource_id: null,
        capability_id: null,
        generation: Math.max(0, ...previous.map(([, entry]) => entry.value.generation)) + 1,
        kind: "API_KEY",
        oauth_client_id: null,
        oauth_issuer: null,
        oauth_audience: null,
        oauth_scope: null,
        display_name: normalized.displayName,
        scopes: normalized.scopes,
        key_prefix: material.prefix,
        expires_at: normalized.expiresAt,
        state: "ACTIVE",
        created_at: at,
        activated_at: at,
        valid_until: null,
        revoked_at: null,
      }
      credentials.set(`${tenantId}:${credential.credential_id}`, { value: credential, hash: material.hash, correlationId: value.correlation_id, tenantId })
      return { credential: structuredClone(credential), api_key: material.secret, oauth_client_secret: null, oauth_token_endpoint: null, credential_delivery: "ONE_TIME" }
    },
    async authenticateApiKey({ tenantId, token }) {
      const hash = applicationApiKeyHash(token)
      if (!hash) return null
      const matched = [...credentials.entries()].find(([, entry]) => entry.tenantId === tenantId && entry.hash === hash)
      if (!matched || !applicationApiKeyIsUsable(matched[1].value, now())) return null
      const credential = matched[1].value
      const application = values.get(`${tenantId}:${credential.application_id}`)
      if (!application || application.subject_id !== credential.application_subject_id || credential.resource_id !== null) return null
      const authorization = await options.identity.authorizationForSubject({ tenantId, subjectId: credential.application_subject_id })
      if (!authorization.registered || authorization.suspended) return null
      return { tenant_id: tenantId, subject_id: credential.application_subject_id, client_id: credential.credential_id,
        role: "USER", organization_ids: [], scopes: [...credential.scopes] }
    },
    async issueOAuthCredential() {
      throw new PlatformApiError("APPLICATION_CREDENTIAL_PROVISIONER_UNAVAILABLE", 503)
    },
    async rotateCredential({ tenantId, applicationId, credentialId, value, issuerScopes }) {
      const at = now()
      const current = credentials.get(`${tenantId}:${credentialId}`)
      if (!current || current.value.application_id !== applicationId) throw new PlatformApiError("APPLICATION_CREDENTIAL_PROVISIONER_UNAVAILABLE", 503)
      assertApplicationCredentialScopeCeiling(current.value.scopes, issuerScopes)
      if (current.value.state !== "ACTIVE" || !applicationApiKeyIsUsable(current.value, at)) throw new PlatformApiError("APPLICATION_CREDENTIAL_NOT_ROTATABLE", 409)
      if (!Number.isSafeInteger(value.grace_period_seconds) || value.grace_period_seconds < 0 || value.grace_period_seconds > 86400) throw new PlatformApiError("APPLICATION_CREDENTIAL_GRACE_PERIOD_INVALID", 422)
      const authorization = await options.identity.authorizationForSubject({ tenantId, subjectId: current.value.application_subject_id })
      if (!authorization.registered || authorization.suspended) throw new PlatformApiError("APPLICATION_SUBJECT_UNAVAILABLE", 403)
      const previous = [...credentials.entries()].filter(([, entry]) => entry.tenantId === tenantId && entry.value.application_id === applicationId)
      if (previous.some(([, entry]) => entry.correlationId === value.correlation_id)) throw new PlatformApiError("APPLICATION_CREDENTIAL_SECRET_ALREADY_DELIVERED", 409)
      for (const [, entry] of previous) {
        if (entry.value.state === "RETIRED") entry.value = { ...entry.value, state: "REVOKED", revoked_at: at }
      }
      current.value = { ...current.value, state: "RETIRED", valid_until: Math.min(at + value.grace_period_seconds, current.value.expires_at) }
      const material = createApplicationApiKeyMaterial()
      const successor = { ...current.value, credential_id: `application-credential-${idFactory()}`,
        generation: Math.max(...previous.map(([, entry]) => entry.value.generation)) + 1,
        state: "ACTIVE" as const, key_prefix: material.prefix, created_at: at, activated_at: at, valid_until: null, revoked_at: null }
      credentials.set(`${tenantId}:${successor.credential_id}`, { value: successor, hash: material.hash, correlationId: value.correlation_id, tenantId })
      return { credential: structuredClone(successor), api_key: material.secret, oauth_client_secret: null, oauth_token_endpoint: null, credential_delivery: "ONE_TIME" }
    },
    async revokeCredential({ tenantId, applicationId, credentialId }) {
      const current = credentials.get(`${tenantId}:${credentialId}`)
      if (!current || current.value.application_id !== applicationId) throw new PlatformApiError("APPLICATION_CREDENTIAL_NOT_FOUND", 404)
      if (current.value.state !== "REVOKED") current.value = { ...current.value, state: "REVOKED", revoked_at: now() }
      return structuredClone(current.value)
    },
    async retireExpiredCredentials() {
      return 0
    },
  }
}
