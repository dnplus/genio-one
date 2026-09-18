import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

test("Organization Administrator registers and reads only Organization-owned Applications", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  await modules.identity.bootstrap({
    tenantId: "tenant-acme",
    subjects: [
      { subject_id: "person-org-admin", kind: "PERSON", role: "USER" },
      { subject_id: "person-user", kind: "PERSON", role: "USER" },
    ],
  })
  const owned = await modules.organizations.create({
    tenantId: "tenant-acme",
    display_name: "AI Platform",
    member_subject_ids: ["person-org-admin"],
  })
  const other = await modules.organizations.create({
    tenantId: "tenant-acme",
    display_name: "Finance",
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "org-token": {
        tenant_id: "tenant-acme",
        subject_id: "person-org-admin",
        client_id: "management-ui",
        role: "ORGANIZATION_ADMINISTRATOR",
        organization_ids: [owned.organization_id],
      },
      "user-token": {
        tenant_id: "tenant-acme",
        subject_id: "person-user",
        client_id: "management-ui",
        role: "USER",
        organization_ids: [],
      },
    }),
  })

  const created = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/applications",
    headers: { authorization: "Bearer org-token" },
    payload: {
      display_name: "Operations Automation",
      owner_organization_id: owned.organization_id,
    },
  })
  assert.equal(created.statusCode, 201)
  assert.equal(created.json().registered_by.subject_id, "person-org-admin")

  const wrongOwner = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/applications",
    headers: { authorization: "Bearer org-token" },
    payload: {
      display_name: "Finance Automation",
      owner_organization_id: other.organization_id,
    },
  })
  assert.equal(wrongOwner.statusCode, 403)
  assert.equal(wrongOwner.json().code, "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED")

  const visible = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/applications",
    headers: { authorization: "Bearer org-token" },
  })
  assert.deepEqual(visible.json().map((value: { display_name: string }) => value.display_name), [
    "Operations Automation",
  ])

  const hidden = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/applications",
    headers: { authorization: "Bearer user-token" },
  })
  assert.deepEqual(hidden.json(), [])

  const identity = await modules.identity.inventory({ tenantId: "tenant-acme" })
  assert.equal(identity.subjects.filter((subject) => subject.kind === "APPLICATION").length, 1)

  const issue = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/applications/${created.json().application_id}/api-credentials`,
    headers: { authorization: "Bearer org-token" },
    payload: {
      correlation_id: "application-credential-issue",
      resource_id: "resource-api",
      capability_id: "incident.list",
    },
  })
  assert.equal(issue.statusCode, 503)
  assert.equal(issue.json().code, "APPLICATION_CREDENTIAL_PROVISIONER_UNAVAILABLE")

  const rotate = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/applications/${created.json().application_id}/api-credentials/credential-1/rotate`,
    headers: { authorization: "Bearer org-token" },
    payload: {
      correlation_id: "application-credential-rotate",
      grace_period_seconds: 60,
    },
  })
  assert.equal(rotate.statusCode, 503)
  assert.equal(rotate.json().code, "APPLICATION_CREDENTIAL_PROVISIONER_UNAVAILABLE")

  const revoke = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/applications/${created.json().application_id}/api-credentials/credential-1/revoke`,
    headers: { authorization: "Bearer org-token" },
    payload: { correlation_id: "application-credential-revoke" },
  })
  assert.equal(revoke.statusCode, 404)
  assert.equal(revoke.json().code, "APPLICATION_CREDENTIAL_NOT_FOUND")
  await app.close()
})
