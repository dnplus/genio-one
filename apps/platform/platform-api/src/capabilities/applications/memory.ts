import { PlatformApiError } from "../errors"
import type { IdentityDirectory } from "../identity/module"
import type { OrganizationDirectory } from "../organizations/module"
import type { Application } from "./contract"
import type { ApplicationRegistry } from "./module"

export function createInMemoryApplicationRegistry(options: {
  identity: IdentityDirectory
  organizations: OrganizationDirectory
  now?: () => number
  idFactory?: () => string
}): ApplicationRegistry {
  const values = new Map<string, Application>()
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
    async listCredentials() {
      return []
    },
    async issueOAuthCredential() {
      throw new PlatformApiError("APPLICATION_CREDENTIAL_PROVISIONER_UNAVAILABLE", 503)
    },
    async rotateCredential() {
      throw new PlatformApiError("APPLICATION_CREDENTIAL_PROVISIONER_UNAVAILABLE", 503)
    },
    async revokeCredential() {
      throw new PlatformApiError("APPLICATION_CREDENTIAL_NOT_FOUND", 404)
    },
    async retireExpiredCredentials() {
      return 0
    },
  }
}
