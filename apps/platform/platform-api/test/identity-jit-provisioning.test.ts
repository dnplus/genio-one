import assert from "node:assert/strict"
import test from "node:test"

import { createCanonicalPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/canonical"
import { createOidcPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/oidc"
import { createInMemoryIdentityDirectory } from "../src/capabilities/identity/memory"
import { createInMemoryOrganizationDirectory } from "../src/capabilities/organizations/memory"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"

const tenantId = "tenant-acme"

function delegateFor(principal: Principal | null) {
  return { authenticate: async () => principal }
}

function brokered(providerId: string, externalSubjectId: string): Principal {
  return {
    tenant_id: tenantId,
    subject_id: externalSubjectId,
    display_name: "Ada Lovelace",
    email: "ada@example.test",
    role: "USER",
    organization_ids: [],
    client_id: "management-ui",
    external_identity: { provider_id: providerId, external_subject_id: externalSubjectId },
  }
}

async function directories() {
  const identity = createInMemoryIdentityDirectory()
  const organizations = createInMemoryOrganizationDirectory()
  return { identity, organizations }
}

test("a brokered identity is refused when its provider is not enabled for just-in-time registration", async () => {
  const { identity, organizations } = await directories()
  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: delegateFor(brokered("keycloak:entra-id", "external-1")),
    identity,
    organizations,
  })

  assert.equal(await authenticator.authenticate({ token: "t", tenantId }), null)
  const inventory = await identity.inventory({ tenantId })
  assert.equal(inventory.subjects.length, 0)
})

test("an enabled provider registers a Person on first sign-in with no organization access", async () => {
  const { identity, organizations } = await directories()
  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: delegateFor(brokered("keycloak:entra-id", "external-1")),
    identity,
    organizations,
    justInTimeProviderIds: ["keycloak:entra-id"],
  })

  const principal = await authenticator.authenticate({ token: "t", tenantId })
  assert.ok(principal)
  // Provisioning establishes identity only; authorization stays a separate,
  // explicit act by an administrator.
  assert.equal(principal.role, "USER")
  assert.deepEqual(principal.organization_ids, [])

  const inventory = await identity.inventory({ tenantId })
  assert.equal(inventory.subjects.length, 1)
  assert.equal(inventory.subjects[0]!.kind, "PERSON")
  assert.equal(inventory.subjects[0]!.profile.email, "ada@example.test")
  assert.equal(inventory.tenant_administrators.length, 0)
})

test("a second sign-in reuses the registered Person instead of creating another", async () => {
  const { identity, organizations } = await directories()
  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: delegateFor(brokered("keycloak:entra-id", "external-1")),
    identity,
    organizations,
    justInTimeProviderIds: ["keycloak:entra-id"],
  })

  const first = await authenticator.authenticate({ token: "t", tenantId })
  const second = await authenticator.authenticate({ token: "t", tenantId })

  assert.equal(first!.subject_id, second!.subject_id)
  assert.equal((await identity.inventory({ tenantId })).subjects.length, 1)
})

test("registration is scoped to the enabled provider, so the same external id from another provider is refused", async () => {
  const { identity, organizations } = await directories()
  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: delegateFor(brokered("keycloak:github", "external-1")),
    identity,
    organizations,
    justInTimeProviderIds: ["keycloak:entra-id"],
  })

  assert.equal(await authenticator.authenticate({ token: "t", tenantId }), null)
  assert.equal((await identity.inventory({ tenantId })).subjects.length, 0)
})

test("a directory failure denies the request rather than admitting an unregistered identity", async () => {
  const { identity, organizations } = await directories()
  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: delegateFor(brokered("keycloak:entra-id", "external-1")),
    identity: {
      ...identity,
      bootstrap: async () => { throw new Error("directory unavailable") },
    },
    organizations,
    justInTimeProviderIds: ["keycloak:entra-id"],
  })

  assert.equal(await authenticator.authenticate({ token: "t", tenantId }), null)
})

test("a local password login keeps the configured provider id so existing bindings still resolve", async () => {
  const configuration = {
    tenant_id: tenantId,
    identity_provider_id: "keycloak",
    issuer: "https://identity.example.test/realms/acme",
    audiences: ["genio-one-management"],
    jwks_uri: "https://identity.example.test/realms/acme/protocol/openid-connect/certs",
    algorithms: ["RS256"],
    claims: { subject: "sub", client: "azp", role: "genio.role", organizations: "genio.organization_ids" },
  }
  const authenticator = createOidcPrincipalAuthenticator({
    tenants: [configuration],
    // No identity_provider claim: this is the bootstrap administrator signing
    // in with a realm password, which must keep working after brokering exists.
    async verifyToken() {
      return { iss: configuration.issuer, aud: configuration.audiences, sub: "admin-subject", azp: "management-ui" }
    },
  })

  const principal = await authenticator.authenticate({ token: "t", tenantId })
  assert.equal(principal!.external_identity!.provider_id, "keycloak")
})

test("a brokered login is attributed to the upstream provider, not to Keycloak alone", async () => {
  const configuration = {
    tenant_id: tenantId,
    identity_provider_id: "keycloak",
    issuer: "https://identity.example.test/realms/acme",
    audiences: ["genio-one-management"],
    jwks_uri: "https://identity.example.test/realms/acme/protocol/openid-connect/certs",
    algorithms: ["RS256"],
    claims: { subject: "sub", client: "azp", role: "genio.role", organizations: "genio.organization_ids" },
  }
  const authenticator = createOidcPrincipalAuthenticator({
    tenants: [configuration],
    async verifyToken() {
      return {
        iss: configuration.issuer,
        aud: configuration.audiences,
        sub: "person-1",
        azp: "management-ui",
        identity_provider: "entra-id",
      }
    },
  })

  const principal = await authenticator.authenticate({ token: "t", tenantId })
  // Two people federated from different providers can no longer collide into
  // one indistinguishable audit identity.
  assert.equal(principal!.external_identity!.provider_id, "keycloak:entra-id")
})
