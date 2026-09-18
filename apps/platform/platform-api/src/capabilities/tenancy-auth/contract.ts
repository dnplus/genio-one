import type { FastifyRequest } from "fastify"

export const PRINCIPAL_ROLES = [
  "USER",
  "ORGANIZATION_ADMINISTRATOR",
  "TENANT_ADMINISTRATOR",
] as const

export type PrincipalRole = (typeof PRINCIPAL_ROLES)[number]

/**
 * Identity facts trusted by the Management API after authentication.
 *
 * These values are deliberately not accepted from command bodies.  A future
 * Keycloak/OIDC verifier will implement the same seam and map its claims to
 * this product-level principal.
 */
export interface Principal {
  tenant_id: string
  subject_id: string
  display_name?: string
  email?: string
  role: PrincipalRole
  organization_ids: string[]
  client_id: string
  scopes?: string[]
  external_identity?: {
    provider_id: string
    external_subject_id: string
  }
}

export interface PrincipalAuthenticator {
  authenticate(input: {
    token: string
    /** Selected from the trusted request path, never from token claims. */
    tenantId: string
    request?: FastifyRequest
  }): Promise<Principal | null> | Principal | null
}

export interface EntitlementResolver {
  /**
   * Resolve the effective model set from trusted identity and catalog facts.
   * The request's `entitled_model_ids` is intentionally absent from this
   * input: a caller cannot expand its own entitlement set.
   */
  resolve(input: {
    tenantId: string
    subjectId: string
    clientId: string
    publicModelId?: string
    requestedModelId?: string
  }): Promise<readonly string[]> | readonly string[]
}
