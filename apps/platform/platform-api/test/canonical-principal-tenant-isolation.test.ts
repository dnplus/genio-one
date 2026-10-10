import assert from "node:assert/strict"
import test from "node:test"

import { createInMemoryIdentityDirectory } from "../src/capabilities/identity/memory"
import { createInMemoryOrganizationDirectory } from "../src/capabilities/organizations/memory"
import { createCanonicalPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/canonical"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"

const tenants = ["tenant-a", "tenant-b"] as const

async function fixture(external = false) {
  const identity = createInMemoryIdentityDirectory()
  let nextOrganization = 0
  const organizations = createInMemoryOrganizationDirectory({ idFactory: () => `org-${++nextOrganization}` })
  const subjectId = (tenant: string) => external ? `person-${tenant}` : "shared-person"
  const principalByToken: Record<string, Principal> = {}
  const organizationIds: Record<string, string> = {}
  for (const tenantId of tenants) {
    await identity.bootstrap({ tenantId, subjects: [{
      subject_id: subjectId(tenantId), kind: "PERSON",
      role: tenantId === "tenant-a" ? "TENANT_ADMINISTRATOR" : "USER",
      ...(external ? { external_identities: [{ provider_id: "shared-provider", external_subject_id: "shared-external-person" }] } : {}),
    }] })
    const organization = await organizations.create({ tenantId, display_name: tenantId, member_subject_ids: [subjectId(tenantId)] })
    organizationIds[tenantId] = organization.organization_id
    principalByToken[tenantId] = {
      tenant_id: tenantId, subject_id: external ? "shared-external-person" : subjectId(tenantId),
      client_id: "management-ui", role: "TENANT_ADMINISTRATOR",
      organization_ids: ["forged-organization"], administrator_organization_ids: ["forged-organization"],
      ...(external ? { external_identity: { provider_id: "shared-provider", external_subject_id: "shared-external-person" } } : {}),
    }
  }
  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: createStaticPrincipalAuthenticator(principalByToken), identity, organizations,
  })
  const authenticate = (tenantId: string) => authenticator.authenticate({ token: tenantId, tenantId })
  async function assertCanonical(tenantId: string) {
    const principal = await authenticate(tenantId)
    assert.ok(principal)
    assert.equal(principal.tenant_id, tenantId)
    assert.equal(principal.subject_id, subjectId(tenantId))
    assert.equal(principal.role, tenantId === "tenant-a" ? "TENANT_ADMINISTRATOR" : "USER")
    assert.deepEqual(principal.organization_ids, tenantId === "tenant-a" ? [] : [organizationIds[tenantId]])
    assert.deepEqual(principal.administrator_organization_ids, [])
  }
  return { identity, organizations, authenticate, assertCanonical, subjectId, organizationIds }
}

for (const order of [["tenant-a", "tenant-b", "tenant-a"], ["tenant-b", "tenant-a", "tenant-b"]]) {
  test(`canonical authority for the same subject remains tenant-scoped in ${order.join(" → ")}`, async () => {
    const context = await fixture()
    for (const tenantId of order) await context.assertCanonical(tenantId)
  })
}

for (const suspendedTenant of tenants) {
  test(`suspending the shared subject in ${suspendedTenant} does not suspend its other-tenant identity`, async () => {
    const context = await fixture()
    for (const tenantId of tenants) await context.assertCanonical(tenantId)
    await context.identity.suspend({ tenantId: suspendedTenant, subjectId: "shared-person", suspendedBy: "admin", value: { reason: "Tenant-specific suspension" } })
    const otherTenant = suspendedTenant === "tenant-a" ? "tenant-b" : "tenant-a"
    assert.equal(await context.authenticate(suspendedTenant), null)
    await context.assertCanonical(otherTenant)
    assert.equal(await context.authenticate(suspendedTenant), null)
    await context.identity.restore({ tenantId: suspendedTenant, subjectId: "shared-person" })
    await context.assertCanonical(suspendedTenant)
    await context.assertCanonical(otherTenant)
  })
}

test("the same provider and external subject bind to distinct canonical identities within each tenant", async () => {
  const context = await fixture(true)
  for (const tenantId of ["tenant-a", "tenant-b", "tenant-a", "tenant-b"]) {
    assert.equal(await context.identity.subjectForExternalIdentity({ tenantId, providerId: "shared-provider", externalSubjectId: "shared-external-person" }), context.subjectId(tenantId))
    await context.assertCanonical(tenantId)
  }
  await context.identity.suspend({ tenantId: "tenant-a", subjectId: context.subjectId("tenant-a"), suspendedBy: "admin", value: {} })
  assert.equal(await context.authenticate("tenant-a"), null)
  await context.assertCanonical("tenant-b")
})
