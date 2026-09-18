import assert from "node:assert/strict"
import test from "node:test"

import { createOidcPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/oidc"

const configuration = {
  tenant_id: "tenant-acme",
  issuer: "https://identity.example.test/realms/acme",
  audiences: ["genio-one-management"],
  jwks_uri: "https://identity.example.test/realms/acme/protocol/openid-connect/certs",
  algorithms: ["RS256"],
  claims: {
    subject: "sub",
    client: "azp",
    role: "genio.role",
    organizations: "genio.organization_ids",
  },
}

test("OIDC authentication maps only verified claims from the path-selected tenant", async () => {
  const seen: string[] = []
  const authenticator = createOidcPrincipalAuthenticator({
    tenants: [configuration],
    async verifyToken(token, selected) {
      seen.push(`${token}:${selected.tenant_id}`)
      return {
        iss: configuration.issuer,
        aud: configuration.audiences,
        sub: "person-1",
        azp: "management-ui",
        scope: "openid genioone-management genioone-management",
        genio: {
          role: "ORGANIZATION_ADMINISTRATOR",
          organization_ids: ["org-ai", "org-ai"],
        },
      }
    },
  })

  assert.deepEqual(
    await authenticator.authenticate({ token: "signed-token", tenantId: "tenant-acme" }),
    {
      tenant_id: "tenant-acme",
      subject_id: "person-1",
      client_id: "management-ui",
      role: "ORGANIZATION_ADMINISTRATOR",
      organization_ids: ["org-ai"],
      scopes: ["openid", "genioone-management"],
      external_identity: {
        provider_id: configuration.issuer,
        external_subject_id: "person-1",
      },
    },
  )
  assert.deepEqual(seen, ["signed-token:tenant-acme"])
  assert.equal(
    await authenticator.authenticate({ token: "signed-token", tenantId: "tenant-other" }),
    null,
  )
  assert.deepEqual(seen, ["signed-token:tenant-acme"])
})

test("OIDC authentication maps Keycloak role arrays to a canonical principal role", async () => {
  const authenticator = createOidcPrincipalAuthenticator({
    tenants: [{
      ...configuration,
      claims: { ...configuration.claims, role: "realm_access.roles" },
    }],
    async verifyToken() {
      return {
        sub: "person-1",
        azp: "management-ui",
        realm_access: { roles: ["default-roles-genio-one", "offline_access"] },
      }
    },
  })

  const principal = await authenticator.authenticate({ token: "signed-token", tenantId: "tenant-acme" })
  assert.equal(principal?.role, "USER")
  assert.equal(principal?.subject_id, "person-1")
})

test("OIDC authentication preserves verified external identity without trusting mutable role claims", async () => {
  const authenticator = createOidcPrincipalAuthenticator({
    tenants: [{ ...configuration, identity_provider_id: "keycloak-acme" }],
    async verifyToken() {
      return { sub: "external-person-1", azp: "management-ui" }
    },
  })

  assert.deepEqual(
    await authenticator.authenticate({ token: "signed-token", tenantId: "tenant-acme" }),
    {
      tenant_id: "tenant-acme",
      subject_id: "external-person-1",
      client_id: "management-ui",
      role: "USER",
      organization_ids: [],
      external_identity: {
        provider_id: "keycloak-acme",
        external_subject_id: "external-person-1",
      },
    },
  )
})

test("OIDC authentication fails closed for invalid verified claims and verifier errors", async () => {
  const invalidClaims = createOidcPrincipalAuthenticator({
    tenants: [configuration],
    async verifyToken() {
      return {
        sub: "person-1",
        azp: "management-ui",
        genio: { role: "SUPERUSER", organization_ids: [] },
      }
    },
  })
  assert.equal(
    await invalidClaims.authenticate({ token: "signed-token", tenantId: "tenant-acme" }),
    null,
  )

  const rejected = createOidcPrincipalAuthenticator({
    tenants: [configuration],
    async verifyToken() {
      throw new Error("signature rejected")
    },
  })
  assert.equal(
    await rejected.authenticate({ token: "bad-token", tenantId: "tenant-acme" }),
    null,
  )
})

test("OIDC configuration rejects symmetric algorithms and insecure trust roots", () => {
  assert.throws(
    () =>
      createOidcPrincipalAuthenticator({
        tenants: [{ ...configuration, algorithms: ["HS256"] }],
      }),
    /Invalid OIDC algorithms/,
  )
  assert.throws(
    () =>
      createOidcPrincipalAuthenticator({
        tenants: [{ ...configuration, jwks_uri: "http://identity.example.test/jwks" }],
      }),
    /Invalid OIDC jwks_uri/,
  )
})
