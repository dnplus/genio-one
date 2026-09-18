import assert from "node:assert/strict"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import { createInMemoryProviderCredentialProfileStore } from "../src/capabilities/provider-credentials/memory"
import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

function errorCode(error: unknown): string | null {
  return error instanceof PlatformApiError ? error.code : null
}

test("Provider credential profiles separate generic credential source from provider exchange", async () => {
  const store = createInMemoryProviderCredentialProfileStore({
    now: () => 1_000,
    idFactory: () => "provider-credential-profile-1",
  })
  const profile = await store.create({
    tenantId: "tenant-acme",
    createdBySubjectId: "person-admin",
    value: {
      owner_organization_id: "organization-ai-platform",
      display_name: "Vertex production federation",
      strategy: {
        kind: "OIDC_FEDERATION",
        source: {
          issuer: "https://identity.example.test/realms/genio-one/",
          client_id: "genio-gateway",
          client_secret_ref: "vertex-oidc-client",
          audience: "gcp-sts",
        },
        exchange: {
          adapter: "GCP_STS",
          project_name: "genio-production",
          region: "us-central1",
          project_id: "123456789",
          workload_identity_pool_name: "genio-pool",
          workload_identity_provider_name: "genio-oidc",
          service_account_name: "genio-runtime",
        },
      },
    },
  })
  assert.equal(profile.profile_id, "provider-credential-profile-1")
  assert.equal(profile.revision, 1)
  assert.equal(profile.adapter_family, "GCP")
  assert.equal(profile.strategy.kind, "OIDC_FEDERATION")
  assert.equal(profile.strategy.source.issuer, "https://identity.example.test/realms/genio-one")
  assert.equal(profile.strategy.exchange.adapter, "GCP_STS")
  assert.match(profile.strategy_digest, /^[a-f0-9]{64}$/)
  assert.equal("client_secret" in profile.strategy.source, false)
})

test("Provider credential profile revisions are optimistic, immutable and terminal after revoke", async () => {
  const store = createInMemoryProviderCredentialProfileStore({ now: () => 1_000 })
  const created = await store.create({
    tenantId: "tenant-acme",
    createdBySubjectId: "person-admin",
    value: {
      profile_id: "provider-credential-adc",
      owner_organization_id: "organization-ai-platform",
      display_name: "Vertex runtime identity",
      strategy: {
        kind: "RUNTIME_IDENTITY",
        adapter: "GCP_APPLICATION_DEFAULT",
        parameters: { project_name: "genio-production", region: "us-central1" },
      },
    },
  })
  await assert.rejects(
    store.revise({
      tenantId: "tenant-acme",
      profileId: created.profile_id,
      createdBySubjectId: "person-admin",
      value: {
        expected_revision: 2,
        display_name: created.display_name,
        strategy: created.strategy,
        state: "ACTIVE",
      },
    }),
    (error: unknown) => errorCode(error) === "PROVIDER_CREDENTIAL_PROFILE_REVISION_CONFLICT",
  )
  const revoked = await store.revise({
    tenantId: "tenant-acme",
    profileId: created.profile_id,
    createdBySubjectId: "person-admin",
    value: {
      expected_revision: 1,
      display_name: created.display_name,
      strategy: created.strategy,
      state: "REVOKED",
    },
  })
  assert.equal(revoked.revision, 2)
  assert.equal(revoked.state, "REVOKED")
  assert.equal((await store.getRevision({
    tenantId: "tenant-acme",
    profileId: created.profile_id,
    revision: 1,
  }))?.state, "ACTIVE")
  await assert.rejects(
    store.revise({
      tenantId: "tenant-acme",
      profileId: created.profile_id,
      createdBySubjectId: "person-admin",
      value: {
        expected_revision: 2,
        display_name: created.display_name,
        strategy: created.strategy,
        state: "ACTIVE",
      },
    }),
    (error: unknown) => errorCode(error) === "PROVIDER_CREDENTIAL_PROFILE_REVOKED",
  )
})

test("Static secret profiles remain provider-neutral", async () => {
  const store = createInMemoryProviderCredentialProfileStore()
  const profile = await store.create({
    tenantId: "tenant-acme",
    createdBySubjectId: "person-admin",
    value: {
      owner_organization_id: "organization-ai-platform",
      display_name: "Generic API key",
      strategy: { kind: "STATIC_SECRET_REFERENCE", secret_ref: "provider-api-key" },
    },
  })
  assert.equal(profile.adapter_family, "GENERIC")
  await assert.rejects(
    store.create({
      tenantId: "tenant-acme",
      createdBySubjectId: "person-admin",
      value: {
        owner_organization_id: "organization-ai-platform",
        display_name: "Invalid blank reference",
        strategy: { kind: "STATIC_SECRET_REFERENCE", secret_ref: "   " },
      },
    }),
    (error: unknown) => errorCode(error) === "PROVIDER_CREDENTIAL_SECRET_REFERENCE_REQUIRED",
  )
})

test("Provider credential profile HTTP routes enforce owner Organization scope", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      admin: {
        tenant_id: "tenant-acme",
        subject_id: "person-admin",
        client_id: "management-ui",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
      },
      owner: {
        tenant_id: "tenant-acme",
        subject_id: "person-owner",
        client_id: "management-ui",
        role: "USER",
        organization_ids: ["organization-ai-platform"],
      },
      outsider: {
        tenant_id: "tenant-acme",
        subject_id: "person-outsider",
        client_id: "management-ui",
        role: "USER",
        organization_ids: ["organization-other"],
      },
    }),
  })
  const created = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/provider-credential-profiles",
    headers: { authorization: "Bearer owner" },
    payload: {
      profile_id: "provider-credential-openai",
      owner_organization_id: "organization-ai-platform",
      display_name: "OpenAI production key",
      strategy: { kind: "STATIC_SECRET_REFERENCE", secret_ref: "openai-production" },
    },
  })
  assert.equal(created.statusCode, 201, created.body)
  assert.equal(created.json().created_by_subject_id, "person-owner")

  const visible = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/provider-credential-profiles",
    headers: { authorization: "Bearer owner" },
  })
  assert.equal(visible.statusCode, 200)
  assert.equal(visible.json().length, 1)

  const hidden = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/provider-credential-profiles",
    headers: { authorization: "Bearer outsider" },
  })
  assert.deepEqual(hidden.json(), [])

  const denied = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/provider-credential-profiles",
    headers: { authorization: "Bearer outsider" },
    payload: {
      owner_organization_id: "organization-ai-platform",
      display_name: "Denied profile",
      strategy: { kind: "STATIC_SECRET_REFERENCE", secret_ref: "denied" },
    },
  })
  assert.equal(denied.statusCode, 403)
  assert.equal(denied.json().code, "ORGANIZATION_ADMIN_REQUIRED")
  await app.close()
})

test("Connection binds an exact active profile revision owned by the Resource Organization", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  const owner = await modules.organizations.create({
    tenantId: "tenant-acme",
    display_name: "AI Platform",
    slug: "ai-platform",
  })
  const other = await modules.organizations.create({
    tenantId: "tenant-acme",
    display_name: "Other",
    slug: "other",
  })
  const resource = await modules.resources.createResource({
    tenantId: "tenant-acme",
    value: {
      display_name: "Company LLM",
      kind: "LLM",
      owner_organization_id: owner.organization_id,
      authentication_strategy: "OAUTH",
      environment_id: "development",
      version: "1.0.0",
      capabilities: [{ capability_id: "model.invoke", display_name: "Invoke" }],
      enforcement_point_id: "genio-ai-mcp-gateway",
    },
  })
  const profile = await modules.providerCredentials.create({
    tenantId: "tenant-acme",
    createdBySubjectId: "person-admin",
    value: {
      profile_id: "provider-credential-company-llm",
      owner_organization_id: owner.organization_id,
      display_name: "Company LLM API key",
      strategy: { kind: "STATIC_SECRET_REFERENCE", secret_ref: "company-llm-api-key" },
    },
  })
  const connection = await modules.connections.create({
    tenantId: "tenant-acme",
    resourceId: resource.resource_id,
    value: {
      display_name: "OpenAI primary",
      connection_kind: "LLM",
      provider_type: "OPENAI",
      endpoint: "https://api.openai.com/v1",
      provider_credential_profile: { profile_id: profile.profile_id, revision: profile.revision },
    },
  })
  assert.deepEqual(connection.provider_credential_profile, {
    profile_id: profile.profile_id,
    revision: 1,
    strategy_digest: profile.strategy_digest,
  })
  assert.deepEqual(connection.downstream_identity, {
    mode: "SERVICE",
    authentication: "PROVIDER_CREDENTIAL_PROFILE",
  })

  const wrongOwner = await modules.providerCredentials.create({
    tenantId: "tenant-acme",
    createdBySubjectId: "person-admin",
    value: {
      profile_id: "provider-credential-other",
      owner_organization_id: other.organization_id,
      display_name: "Other key",
      strategy: { kind: "STATIC_SECRET_REFERENCE", secret_ref: "other-key" },
    },
  })
  await assert.rejects(
    modules.connections.create({
      tenantId: "tenant-acme",
      resourceId: resource.resource_id,
      value: {
        display_name: "Wrong owner",
        connection_kind: "LLM",
        provider_type: "OPENAI",
        endpoint: "https://api.openai.com/v1",
        provider_credential_profile: {
          profile_id: wrongOwner.profile_id,
          revision: wrongOwner.revision,
        },
      },
    }),
    (error: unknown) => errorCode(error) === "PROVIDER_CREDENTIAL_PROFILE_NOT_FOUND",
  )

  await modules.providerCredentials.revise({
    tenantId: "tenant-acme",
    profileId: profile.profile_id,
    createdBySubjectId: "person-admin",
    value: {
      expected_revision: 1,
      display_name: profile.display_name,
      strategy: profile.strategy,
      state: "REVOKED",
    },
  })
  await assert.rejects(
    modules.connections.create({
      tenantId: "tenant-acme",
      resourceId: resource.resource_id,
      value: {
        display_name: "Revoked profile",
        connection_kind: "LLM",
        provider_type: "OPENAI",
        endpoint: "https://api.openai.com/v1",
        provider_credential_profile: { profile_id: profile.profile_id, revision: 1 },
      },
    }),
    (error: unknown) => errorCode(error) === "PROVIDER_CREDENTIAL_PROFILE_REVOKED",
  )
})

test("uploaded credentials remain private and pinned to immutable revisions", async () => {
  const store = createInMemoryProviderCredentialProfileStore()
  const material = JSON.stringify({ type: "authorized_user", client_id: "test-client", client_secret: "test-secret", refresh_token: "test-refresh" })
  const profile = await store.create({ tenantId: "tenant-a", createdBySubjectId: "admin", value: {
    profile_id: "adc", owner_organization_id: "org", display_name: "ADC", credential_material: material,
    strategy: { kind: "RUNTIME_IDENTITY", adapter: "GCP_APPLICATION_DEFAULT", parameters: { project_name: "project", region: "us-central1" } },
  } })
  assert.equal(profile.credential_configured, true)
  assert.doesNotMatch(JSON.stringify(profile), /test-secret|test-refresh|credential_material/)
  const newer = await store.revise({ tenantId: "tenant-a", profileId: "adc", createdBySubjectId: "admin", value: {
    expected_revision: 1, display_name: "ADC", strategy: profile.strategy, state: "ACTIVE", credential_material: material.replace("test-refresh", "new-refresh"),
  } })
  assert.equal(await store.readMaterial!({ tenantId: "tenant-a", profileId: "adc", revision: 1 }), material)
  assert.match((await store.readMaterial!({ tenantId: "tenant-a", profileId: "adc", revision: 2 }))!, /new-refresh/)
  assert.equal(await store.readMaterial!({ tenantId: "tenant-b", profileId: "adc", revision: 1 }), null)
  assert.doesNotMatch(JSON.stringify(await store.listLatest({ tenantId: "tenant-a" })), /test-secret|refresh_token/)
  await assert.rejects(store.revise({ tenantId: "tenant-a", profileId: "adc", createdBySubjectId: "admin", value: {
    expected_revision: 2, display_name: "ADC", strategy: profile.strategy, state: "ACTIVE", credential_material: material.slice(0, -1) + ',"token_uri":"https://untrusted.example/token"}',
  } }), (error: unknown) => errorCode(error) === "PROVIDER_CREDENTIAL_MATERIAL_ENDPOINT_REJECTED")
  assert.equal((await store.getLatest({ tenantId: "tenant-a", profileId: "adc" }))?.revision, 2)
  await store.revise({ tenantId: "tenant-a", profileId: "adc", createdBySubjectId: "admin", value: {
    expected_revision: newer.revision, display_name: "ADC", strategy: profile.strategy, state: "REVOKED",
  } })
  assert.equal(await store.readMaterial!({ tenantId: "tenant-a", profileId: "adc", revision: 1 }), null)
})
