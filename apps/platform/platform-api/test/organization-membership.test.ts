import assert from "node:assert/strict"
import test from "node:test"

import { createInMemoryIdentityDirectory } from "../src/capabilities/identity/memory"
import { createInMemoryOrganizationDirectory } from "../src/capabilities/organizations/memory"
import { createCanonicalPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/canonical"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

test("Organization membership drives canonical Organization Administrator scope", async () => {
  const identity = createInMemoryIdentityDirectory()
  const organizations = createInMemoryOrganizationDirectory({ idFactory: () => "org-ai" })
  await identity.bootstrap({
    tenantId: "tenant-acme",
    subjects: [{
      subject_id: "person-org-admin",
      kind: "PERSON",
      role: "USER",
      external_identities: [{
        provider_id: "keycloak-acme",
        external_subject_id: "external-org-admin",
      }],
    }],
  })
  const organization = await organizations.create({
    tenantId: "tenant-acme",
    display_name: "AI Platform",
    member_subject_ids: ["person-org-admin"],
  })
  await organizations.update({
    tenantId: "tenant-acme",
    organizationId: organization.organization_id,
    value: {
      display_name: organization.display_name,
      member_subject_ids: ["person-org-admin"],
      organization_administrator_subject_ids: ["person-org-admin"],
      membership_sources: [{ kind: "MANUAL", reference: "console", status: "SYNCED" }],
    },
  })

  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: createStaticPrincipalAuthenticator({
      token: {
        tenant_id: "tenant-acme",
        subject_id: "external-org-admin",
        client_id: "management-ui",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: ["attacker-controlled-org"],
        external_identity: {
          provider_id: "keycloak-acme",
          external_subject_id: "external-org-admin",
        },
      },
    }),
    identity,
    organizations,
  })

  assert.deepEqual(
    await authenticator.authenticate({ token: "token", tenantId: "tenant-acme" }),
    {
      tenant_id: "tenant-acme",
      subject_id: "person-org-admin",
      client_id: "management-ui",
      role: "ORGANIZATION_ADMINISTRATOR",
      organization_ids: ["org-ai"],
      external_identity: {
        provider_id: "keycloak-acme",
        external_subject_id: "external-org-admin",
      },
    },
  )
})

test("Gateway Runtime transport keeps its registration identity outside the directory", async () => {
  const identity = createInMemoryIdentityDirectory()
  const organizations = createInMemoryOrganizationDirectory()
  const runtimePrincipal = {
    tenant_id: "tenant-acme",
    subject_id: "gateway-runtime-1",
    client_id: "gateway-runtime-1",
    role: "USER" as const,
    organization_ids: [],
  }
  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: createStaticPrincipalAuthenticator({ runtime: runtimePrincipal }),
    identity,
    organizations,
  })

  assert.deepEqual(
    await authenticator.authenticate({
      token: "runtime",
      tenantId: "tenant-acme",
      request: { url: "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-runtime-1/aggregate/connect" } as never,
    }),
    runtimePrincipal,
  )
})
