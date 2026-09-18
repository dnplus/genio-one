import { randomUUID } from "node:crypto"

import type { IdentityDirectory } from "../identity/module"
import type { OrganizationDirectory } from "../organizations/module"
import type { Principal, PrincipalAuthenticator } from "./contract"

/**
 * Replace mutable role and Organization scope claims with canonical Control
 * Plane state for registered subjects. Runtime and service principals that do
 * not belong to the human/agent directory continue to use their dedicated
 * authenticator result.
 */
export function createCanonicalPrincipalAuthenticator(options: {
  delegate: PrincipalAuthenticator
  identity: IdentityDirectory
  organizations: OrganizationDirectory
  /**
   * Providers whose first-time sign-in may register a Person. A brokered
   * identity otherwise has to exist in the directory before it can sign in.
   * The provisioned Person holds no Organization membership and no role
   * beyond USER, so this establishes who someone is, never what they may do.
   */
  justInTimeProviderIds?: readonly string[]
}): PrincipalAuthenticator {
  const justInTimeProviders = new Set(
    (options.justInTimeProviderIds ?? []).map((value) => value.trim()).filter(Boolean),
  )

  /**
   * Registers the brokered identity as a Person and returns its canonical id.
   * The binding is what matters: a concurrent sign-in that already created it
   * wins the upsert, and the re-read returns that subject rather than a
   * duplicate. A provisioning failure denies the request instead of letting an
   * unregistered identity through.
   */
  async function provisionPerson(authenticated: Principal): Promise<string | null> {
    const external = authenticated.external_identity!
    try {
      await options.identity.bootstrap({
        tenantId: authenticated.tenant_id,
        subjects: [{
          subject_id: `person-${randomUUID()}`,
          kind: "PERSON",
          display_name: authenticated.display_name ?? null,
          email: authenticated.email ?? null,
          role: "USER",
          external_identities: [{
            provider_id: external.provider_id,
            external_subject_id: external.external_subject_id,
          }],
        }],
      })
    } catch {
      return null
    }
    return options.identity.subjectForExternalIdentity({
      tenantId: authenticated.tenant_id,
      providerId: external.provider_id,
      externalSubjectId: external.external_subject_id,
    })
  }

  return {
    async authenticate(input) {
      const authenticated = await options.delegate.authenticate(input)
      if (!authenticated) return null
      if (input.request?.url.includes("/runtime-control/")) {
        // Gateway Runtime identity is authorized by its runtime registration,
        // not the human/agent directory. Avoid a directory round trip during
        // the WebSocket upgrade and preserve the dedicated runtime boundary.
        return authenticated
      }
      let canonicalSubjectId = authenticated.external_identity
        ? await options.identity.subjectForExternalIdentity({
            tenantId: authenticated.tenant_id,
            providerId: authenticated.external_identity.provider_id,
            externalSubjectId: authenticated.external_identity.external_subject_id,
          })
        : authenticated.subject_id
      if (
        authenticated.external_identity &&
        !canonicalSubjectId &&
        justInTimeProviders.has(authenticated.external_identity.provider_id)
      ) {
        canonicalSubjectId = await provisionPerson(authenticated)
      }
      if (authenticated.external_identity && !canonicalSubjectId) return null
      const principal = { ...authenticated, subject_id: canonicalSubjectId ?? authenticated.subject_id }
      const authorization = await options.identity.authorizationForSubject({
        tenantId: principal.tenant_id,
        subjectId: principal.subject_id,
      })
      // A suspension outranks every role: it is checked before the
      // administrator branch so a suspended Tenant Administrator is stopped
      // too, and on every request rather than at sign-in, so an already-issued
      // token stops working without waiting for it to expire.
      if (authorization.suspended) return null
      if (!authorization.registered) return principal
      if (authorization.tenant_administrator) {
        return { ...principal, role: "TENANT_ADMINISTRATOR", organization_ids: [] }
      }
      const access = await options.organizations.accessForSubject({
        tenantId: principal.tenant_id,
        subjectId: principal.subject_id,
      })
      return {
        ...principal,
        role: access.administrator_organization_ids.length > 0
          ? "ORGANIZATION_ADMINISTRATOR"
          : "USER",
        organization_ids: access.organization_ids,
      }
    },
  }
}
