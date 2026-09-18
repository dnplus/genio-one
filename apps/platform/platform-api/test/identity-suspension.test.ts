import assert from "node:assert/strict"
import test from "node:test"

import { createCanonicalPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/canonical"
import { createInMemoryIdentityDirectory } from "../src/capabilities/identity/memory"
import { createInMemoryOrganizationDirectory } from "../src/capabilities/organizations/memory"
import { isPlatformApiError } from "../src/capabilities/errors"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"

const tenantId = "tenant-acme"

function principalFor(subjectId: string, externalSubjectId?: string): Principal {
  return {
    tenant_id: tenantId,
    subject_id: subjectId,
    role: "USER",
    organization_ids: [],
    client_id: "management-ui",
    ...(externalSubjectId
      ? { external_identity: { provider_id: "keycloak:entra-id", external_subject_id: externalSubjectId } }
      : {}),
  }
}

async function directoryWith(subject: {
  subject_id: string
  role?: "USER" | "TENANT_ADMINISTRATOR"
  external_subject_id?: string
}) {
  const identity = createInMemoryIdentityDirectory()
  await identity.bootstrap({
    tenantId,
    subjects: [{
      subject_id: subject.subject_id,
      kind: "PERSON",
      display_name: "Ada Lovelace",
      role: subject.role ?? "USER",
      ...(subject.external_subject_id
        ? {
            external_identities: [{
              provider_id: "keycloak:entra-id",
              external_subject_id: subject.external_subject_id,
            }],
          }
        : {}),
    }],
  })
  return { identity, organizations: createInMemoryOrganizationDirectory() }
}

test("a suspended Subject is refused on the next request, without waiting for its token to expire", async () => {
  const { identity, organizations } = await directoryWith({ subject_id: "person-1" })
  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: { authenticate: async () => principalFor("person-1") },
    identity,
    organizations,
  })

  assert.ok(await authenticator.authenticate({ token: "t", tenantId }))
  await identity.suspend({
    tenantId,
    subjectId: "person-1",
    suspendedBy: "person-admin",
    value: { reason: "Left the company" },
  })
  // The same token that worked a moment ago is now refused.
  assert.equal(await authenticator.authenticate({ token: "t", tenantId }), null)
})

test("suspension outranks the Tenant Administrator role", async () => {
  const { identity, organizations } = await directoryWith({
    subject_id: "person-admin-2",
    role: "TENANT_ADMINISTRATOR",
  })
  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: { authenticate: async () => principalFor("person-admin-2") },
    identity,
    organizations,
  })

  assert.equal(
    (await authenticator.authenticate({ token: "t", tenantId }))?.role,
    "TENANT_ADMINISTRATOR",
  )
  await identity.suspend({ tenantId, subjectId: "person-admin-2", suspendedBy: "person-other", value: {} })
  assert.equal(await authenticator.authenticate({ token: "t", tenantId }), null)
})

test("restoring a Subject returns access", async () => {
  const { identity, organizations } = await directoryWith({ subject_id: "person-1" })
  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: { authenticate: async () => principalFor("person-1") },
    identity,
    organizations,
  })

  await identity.suspend({ tenantId, subjectId: "person-1", suspendedBy: "person-admin", value: {} })
  assert.equal(await authenticator.authenticate({ token: "t", tenantId }), null)

  const restored = await identity.restore({ tenantId, subjectId: "person-1" })
  assert.equal(restored.suspended, false)
  assert.equal(restored.suspension_reason, null)
  assert.ok(await authenticator.authenticate({ token: "t", tenantId }))
})

test("a suspended brokered identity is not re-provisioned by just-in-time registration", async () => {
  const { identity, organizations } = await directoryWith({
    subject_id: "person-1",
    external_subject_id: "external-1",
  })
  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: { authenticate: async () => principalFor("external-1", "external-1") },
    identity,
    organizations,
    justInTimeProviderIds: ["keycloak:entra-id"],
  })

  await identity.suspend({ tenantId, subjectId: "person-1", suspendedBy: "person-admin", value: {} })
  assert.equal(await authenticator.authenticate({ token: "t", tenantId }), null)

  // The binding still resolves to the suspended Person, so no second Person is
  // created that would quietly hand the same human a fresh identity.
  const inventory = await identity.inventory({ tenantId })
  assert.equal(inventory.subjects.length, 1)
  assert.equal(inventory.subjects[0]!.suspended, true)
})

test("re-running bootstrap does not lift a suspension", async () => {
  const { identity } = await directoryWith({ subject_id: "person-1" })
  await identity.suspend({
    tenantId,
    subjectId: "person-1",
    suspendedBy: "person-admin",
    value: { reason: "Left the company" },
  })

  await identity.bootstrap({
    tenantId,
    subjects: [{ subject_id: "person-1", kind: "PERSON", display_name: "Ada Lovelace", role: "USER" }],
  })

  const [subject] = (await identity.inventory({ tenantId })).subjects
  assert.equal(subject!.suspended, true)
  assert.equal(subject!.suspension_reason, "Left the company")
})

test("suspension records who applied it and keeps the first reason on repeat", async () => {
  const { identity } = await directoryWith({ subject_id: "person-1" })
  const first = await identity.suspend({
    tenantId,
    subjectId: "person-1",
    suspendedBy: "person-admin",
    value: { reason: "Left the company" },
  })
  assert.equal(first.suspended_by, "person-admin")
  assert.equal(first.suspension_reason, "Left the company")
  assert.ok(typeof first.suspended_at === "number" && first.suspended_at > 0)

  const second = await identity.suspend({
    tenantId,
    subjectId: "person-1",
    suspendedBy: "person-other",
    value: { reason: "Something else" },
  })
  // The original record of who suspended and why survives a repeated call.
  assert.equal(second.suspended_by, "person-admin")
  assert.equal(second.suspension_reason, "Left the company")
  assert.equal(second.suspended_at, first.suspended_at)
})

test("suspending an unknown Subject is reported as not found", async () => {
  const { identity } = await directoryWith({ subject_id: "person-1" })
  for (const attempt of [
    identity.suspend({ tenantId, subjectId: "absent", suspendedBy: "person-admin", value: {} }),
    identity.restore({ tenantId, subjectId: "absent" }),
  ]) {
    const failure = await attempt.catch((error: unknown) => error)
    assert.ok(isPlatformApiError(failure) && failure.code === "SUBJECT_NOT_FOUND")
  }
})

test("a newly registered Subject is not suspended", async () => {
  const { identity } = await directoryWith({ subject_id: "person-1" })
  const [subject] = (await identity.inventory({ tenantId })).subjects
  assert.equal(subject!.suspended, false)
  assert.equal(subject!.suspended_at, null)
  assert.equal(subject!.suspended_by, null)
})
