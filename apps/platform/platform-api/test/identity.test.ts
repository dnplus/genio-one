import assert from "node:assert/strict"
import test from "node:test"

import { createInMemoryIdentityDirectory } from "../src/capabilities/identity/memory"

test("identity inventory keeps subjects, roles, and external bindings tenant scoped", async () => {
  const directory = createInMemoryIdentityDirectory()

  await directory.bootstrap({
    tenantId: "tenant-a",
    subjects: [{
      subject_id: "person-admin-a",
      kind: "PERSON",
      display_name: "Administrator A",
      role: "TENANT_ADMINISTRATOR",
      external_identities: [{ provider_id: "oidc", external_subject_id: "external-admin" }],
    }],
  })
  await directory.bootstrap({
    tenantId: "tenant-b",
    subjects: [{
      subject_id: "person-admin-b",
      kind: "PERSON",
      display_name: "Administrator B",
      role: "TENANT_ADMINISTRATOR",
      external_identities: [{ provider_id: "oidc", external_subject_id: "external-admin" }],
    }],
  })
  await directory.create({
    tenantId: "tenant-a",
    value: {
      kind: "AGENT",
      subject_id: "agent-operations",
      display_name: "Operations Copilot",
    },
  })

  const tenantA = await directory.inventory({ tenantId: "tenant-a" })
  const tenantB = await directory.inventory({ tenantId: "tenant-b" })

  assert.deepEqual(tenantA.subjects.map((subject) => subject.subject_id).sort(), [
    "agent-operations",
    "person-admin-a",
  ])
  assert.deepEqual(tenantA.tenant_administrators, ["person-admin-a"])
  assert.deepEqual(tenantA.external_identity_bindings, [{
    provider_id: "oidc",
    external_subject_id: "external-admin",
    subject_id: "person-admin-a",
  }])

  assert.deepEqual(tenantB.subjects.map((subject) => subject.subject_id), ["person-admin-b"])
  assert.deepEqual(tenantB.tenant_administrators, ["person-admin-b"])
  assert.deepEqual(tenantB.external_identity_bindings, [{
    provider_id: "oidc",
    external_subject_id: "external-admin",
    subject_id: "person-admin-b",
  }])
  assert.equal(await directory.canonicalSubjectId({
    tenantId: "tenant-a",
    subjectId: "external-admin",
  }), "person-admin-a")
  assert.equal(await directory.canonicalSubjectId({
    tenantId: "tenant-a",
    subjectId: "person-admin-a",
  }), "person-admin-a")
})
