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
        scopes: ["genioone-management", "application.create"],
        role: "ORGANIZATION_ADMINISTRATOR",
        organization_ids: [owned.organization_id],
        administrator_organization_ids: [owned.organization_id],
      },
      "user-token": {
        tenant_id: "tenant-acme",
        subject_id: "person-user",
        client_id: "management-ui",
        scopes: ["genioone-management", "application.create"],
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

test("Application credential mutations require owner management scope while membership remains readable", async () => {
  const tenantId = "tenant-acme"
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  await modules.identity.bootstrap({
    tenantId,
    subjects: [
      { subject_id: "person-kevin", kind: "PERSON", role: "USER" },
      { subject_id: "person-tenant-admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" },
    ],
  })
  const sales = await modules.organizations.create({
    tenantId,
    display_name: "Sales",
    member_subject_ids: ["person-kevin"],
  })
  const uatAccess = await modules.organizations.create({
    tenantId,
    display_name: "UAT Access",
    member_subject_ids: ["person-kevin"],
  })
  const salesApplication = await modules.applications.register({
    tenantId,
    registeredBySubjectId: "person-kevin",
    value: {
      display_name: "Sales Automation",
      owner_organization_id: sales.organization_id,
    },
  })
  const uatAccessApplication = await modules.applications.register({
    tenantId,
    registeredBySubjectId: "person-kevin",
    value: {
      display_name: "UAT Access Automation",
      owner_organization_id: uatAccess.organization_id,
    },
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      kevin: {
        tenant_id: tenantId,
        subject_id: "person-kevin",
        client_id: "management-ui",
        scopes: ["genioone-management"],
        role: "ORGANIZATION_ADMINISTRATOR",
        organization_ids: [sales.organization_id, uatAccess.organization_id],
        administrator_organization_ids: [uatAccess.organization_id],
      },
      "tenant-admin": {
        tenant_id: tenantId,
        subject_id: "person-tenant-admin",
        client_id: "management-ui",
        scopes: ["genioone-management"],
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
      },
    }),
  })
  const headers = (token: string) => ({ authorization: `Bearer ${token}` })
  const credentialPath = (applicationId: string) =>
    `/v1/tenants/${tenantId}/applications/${applicationId}/api-credentials`
  const issuePayload = {
    correlation_id: "application-credential-issue",
    resource_id: "resource-api",
    capability_id: "incident.list",
  }
  const rotatePayload = {
    correlation_id: "application-credential-rotate",
    grace_period_seconds: 60,
  }
  const revokePayload = { correlation_id: "application-credential-revoke" }

  try {
    const salesCredentials = await app.inject({
      method: "GET",
      url: credentialPath(salesApplication.application_id),
      headers: headers("kevin"),
    })
    assert.equal(salesCredentials.statusCode, 200, salesCredentials.body)
    assert.deepEqual(salesCredentials.json(), [])

    const salesIssue = await app.inject({
      method: "POST",
      url: credentialPath(salesApplication.application_id),
      headers: headers("kevin"),
      payload: issuePayload,
    })
    assert.equal(salesIssue.statusCode, 403, salesIssue.body)
    assert.equal(salesIssue.json().code, "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED")

    const salesRotate = await app.inject({
      method: "POST",
      url: `${credentialPath(salesApplication.application_id)}/credential-1/rotate`,
      headers: headers("kevin"),
      payload: rotatePayload,
    })
    assert.equal(salesRotate.statusCode, 403, salesRotate.body)
    assert.equal(salesRotate.json().code, "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED")

    const salesRevoke = await app.inject({
      method: "POST",
      url: `${credentialPath(salesApplication.application_id)}/credential-1/revoke`,
      headers: headers("kevin"),
      payload: revokePayload,
    })
    assert.equal(salesRevoke.statusCode, 403, salesRevoke.body)
    assert.equal(salesRevoke.json().code, "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED")

    const uatAccessIssue = await app.inject({
      method: "POST",
      url: credentialPath(uatAccessApplication.application_id),
      headers: headers("kevin"),
      payload: issuePayload,
    })
    assert.equal(uatAccessIssue.statusCode, 503, uatAccessIssue.body)
    assert.equal(uatAccessIssue.json().code, "APPLICATION_CREDENTIAL_PROVISIONER_UNAVAILABLE")

    const uatAccessRotate = await app.inject({
      method: "POST",
      url: `${credentialPath(uatAccessApplication.application_id)}/credential-1/rotate`,
      headers: headers("kevin"),
      payload: rotatePayload,
    })
    assert.equal(uatAccessRotate.statusCode, 503, uatAccessRotate.body)
    assert.equal(uatAccessRotate.json().code, "APPLICATION_CREDENTIAL_PROVISIONER_UNAVAILABLE")

    const uatAccessRevoke = await app.inject({
      method: "POST",
      url: `${credentialPath(uatAccessApplication.application_id)}/credential-1/revoke`,
      headers: headers("kevin"),
      payload: revokePayload,
    })
    assert.equal(uatAccessRevoke.statusCode, 404, uatAccessRevoke.body)
    assert.equal(uatAccessRevoke.json().code, "APPLICATION_CREDENTIAL_NOT_FOUND")

    const tenantAdminIssue = await app.inject({
      method: "POST",
      url: credentialPath(salesApplication.application_id),
      headers: headers("tenant-admin"),
      payload: issuePayload,
    })
    assert.equal(tenantAdminIssue.statusCode, 503, tenantAdminIssue.body)
    assert.equal(tenantAdminIssue.json().code, "APPLICATION_CREDENTIAL_PROVISIONER_UNAVAILABLE")
  } finally {
    await app.close()
  }
})
