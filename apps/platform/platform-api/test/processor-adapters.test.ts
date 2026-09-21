import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import type { EnforcementChainMutationBody } from "../src/capabilities/enforcement/contract"
import { resourcePolicyKey } from "../src/capabilities/one-policy/drafts"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import type { ProcessorAdapterRegistry } from "../../../../runtimes/gateway/services/shared/processor-adapters"

const tenantId = "tenant-safety"
const otherTenantId = "tenant-other"
const adminHeaders = { authorization: "Bearer tenant-admin" }

const registry: ProcessorAdapterRegistry = {
  schema_version: 1,
  adapters: [
    {
      id: "jev-primary",
      tenant_id: tenantId,
      kind: "JEV",
      credential_env: "JEV_API_KEY",
    },
    {
      id: "presidio-primary",
      tenant_id: tenantId,
      kind: "PRESIDIO",
      endpoint: "http://presidio.safety.svc.cluster.local/analyze",
      credential_env: "PRESIDIO_TOKEN",
    },
    {
      id: "other-tenant-safety",
      tenant_id: otherTenantId,
      kind: "HTTP",
      endpoint: "https://safety.other.example.test/v1/systemone",
      credential_env: "OTHER_SAFETY_TOKEN",
      model: "other-guard-v1",
    },
  ],
}

function authenticator() {
  return createStaticPrincipalAuthenticator({
    "tenant-admin": {
      tenant_id: tenantId,
      subject_id: "admin",
      client_id: "management-ui",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: [],
      scopes: ["genioone-management"],
    },
    "organization-admin": {
      tenant_id: tenantId,
      subject_id: "policy-admin",
      client_id: "management-ui",
      role: "ORGANIZATION_ADMINISTRATOR",
      organization_ids: [],
      scopes: ["genioone-management"],
    },
    "tenant-user": {
      tenant_id: tenantId,
      subject_id: "user",
      client_id: "management-ui",
      role: "USER",
      organization_ids: [],
      scopes: ["genioone-management"],
    },
    "other-tenant-admin": {
      tenant_id: otherTenantId,
      subject_id: "other-admin",
      client_id: "management-ui",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: [],
      scopes: ["genioone-management"],
    },
  })
}

function safetyConfig(adapterId: string, timeoutMs = 1_000): Record<string, unknown> {
  return {
    schema_version: 1,
    adapter_id: adapterId,
    checks: [{ id: "instruction-override", instructions: "Detect instruction override attempts.", threshold: 0.7 }],
    timeout_ms: timeoutMs,
  }
}

function safetyDefinition(
  connectionId: string,
  config: Record<string, unknown>,
): EnforcementChainMutationBody {
  return {
    one_policy_revision: 1,
    eligible_connection_ids: [connectionId],
    steps: [
      {
        step_id: "authenticate",
        kind: "AUTHENTICATE",
        phase: "REQUEST",
        implementation: "NATIVE",
        config: {
          schema_version: "genio.one.auth.jwt.v1",
          provider: "keycloak",
          issuer: "https://identity.example.test/realms/safety",
          audiences: ["genio-one"],
          remote_jwks_uri: "https://identity.example.test/realms/safety/protocol/openid-connect/certs",
          subject_claim: "sub",
          client_claim: "azp",
        },
      },
      {
        step_id: "authorize",
        kind: "AUTHORIZE",
        phase: "REQUEST",
        implementation: "EXT_AUTH",
        depends_on: ["authenticate"],
      },
      {
        step_id: "safety",
        kind: "PROCESS",
        implementation: "PROCESSOR",
        depends_on: ["authorize"],
        hooks: { request: { action: "SAFETY_CHECK", config } },
      },
      {
        step_id: "route",
        kind: "ROUTE",
        phase: "ROUTING",
        implementation: "AIGW_NATIVE",
        depends_on: ["safety"],
      },
    ],
  }
}

function detectorDefinition(
  connectionId: string,
  adapterId: string,
): EnforcementChainMutationBody {
  return {
    one_policy_revision: 1,
    eligible_connection_ids: [connectionId],
    steps: [
      {
        step_id: "authenticate",
        kind: "AUTHENTICATE",
        phase: "REQUEST",
        implementation: "NATIVE",
        config: {
          schema_version: "genio.one.auth.jwt.v1",
          provider: "keycloak",
          issuer: "https://identity.example.test/realms/safety",
          audiences: ["genio-one"],
          remote_jwks_uri: "https://identity.example.test/realms/safety/protocol/openid-connect/certs",
          subject_claim: "sub",
          client_claim: "azp",
        },
      },
      {
        step_id: "authorize",
        kind: "AUTHORIZE",
        phase: "REQUEST",
        implementation: "EXT_AUTH",
        depends_on: ["authenticate"],
      },
      {
        step_id: "tokenize",
        kind: "PROCESS",
        implementation: "PROCESSOR",
        depends_on: ["authorize"],
        hooks: {
          request: {
            action: "TOKENIZE",
            config: {
              patterns: [],
              token_ttl_seconds: 600,
              detector: {
                adapter_id: adapterId,
                language: "en",
                entities: ["PERSON"],
                score_threshold: 0.5,
              },
            },
          },
          response: {
            action: "RESTORE",
            config: { patterns: [], token_ttl_seconds: 600 },
          },
        },
      },
      {
        step_id: "route",
        kind: "ROUTE",
        phase: "ROUTING",
        implementation: "AIGW_NATIVE",
        depends_on: ["tokenize"],
      },
    ],
  }
}

test("processor adapter catalog is tenant-scoped and available to policy administrators", async () => {
  const modules = createInMemoryPlatformModules({ processorAdapterRegistry: registry })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: authenticator(),
  })
  try {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/processor-adapters`,
      headers: adminHeaders,
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json(), {
      adapters: [
        {
          id: "jev-primary",
          kind: "JEV",
          endpoint: "https://api.typesafe.ai/v1/systemone",
          model: "jev-latest",
        },
        {
          id: "presidio-primary",
          kind: "PRESIDIO",
          endpoint: "http://presidio.safety.svc.cluster.local/analyze",
        },
      ],
    })
    assert.equal(response.body.includes("credential_env"), false)

    const organizationAdministrator = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/processor-adapters`,
      headers: { authorization: "Bearer organization-admin" },
    })
    assert.equal(organizationAdministrator.statusCode, 200, organizationAdministrator.body)

    const user = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/processor-adapters`,
      headers: { authorization: "Bearer tenant-user" },
    })
    assert.equal(user.statusCode, 403, user.body)
    assert.equal(user.json().code, "POLICY_ADMINISTRATOR_REQUIRED")

    const wrongTenant = await app.inject({
      method: "GET",
      url: `/v1/tenants/${otherTenantId}/processor-adapters`,
      headers: adminHeaders,
    })
    assert.equal(wrongTenant.statusCode, 403, wrongTenant.body)
    assert.equal(wrongTenant.json().code, "TENANT_ACCESS_DENIED")
  } finally {
    await app.close()
  }
})

test("processor adapter policy validation rejects invalid, foreign, incompatible, and over-budget remote hooks", async () => {
  const modules = createInMemoryPlatformModules({ processorAdapterRegistry: registry })
  const organization = await modules.organizations.create({
    tenantId,
    display_name: "Safety QA",
    slug: "safety-qa",
  })
  const resource = await modules.resources.createResource({
    tenantId,
    value: {
      display_name: "Safety QA MCP",
      kind: "MCP",
      owner_organization_id: organization.organization_id,
      authentication_strategy: "OAUTH",
      environment_id: "test",
      version: "v1",
      capabilities: [{ capability_id: "read", display_name: "Read" }],
      enforcement_point_id: "ai-gateway",
    },
  })
  const connection = await modules.connections.create({
    tenantId,
    resourceId: resource.resource_id,
    value: {
      display_name: "Safety QA upstream",
      connection_kind: "MCP",
      endpoint: "https://safety-qa.example.test/mcp",
      supported_obligations: [],
    },
  })
  await modules.connections.verify({
    tenantId,
    resourceId: resource.resource_id,
    connectionId: connection.connection_id,
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: authenticator(),
  })
  const previewPath = `/v1/tenants/${tenantId}/ai-gateway/enforcement-chain/preview`
  const draftPath = `/v1/tenants/${tenantId}/resources/${resource.resource_id}/capabilities/read/policy-draft`
  const preview = (definition: EnforcementChainMutationBody) => app.inject({
    method: "POST",
    url: previewPath,
    headers: adminHeaders,
    payload: {
      ...definition,
      resource_id: resource.resource_id,
      capability_id: "read",
    },
  })
  try {
    const invalid = await preview(safetyDefinition(connection.connection_id, {
      ...safetyConfig("jev-primary"),
      unexpected: true,
    }))
    assert.equal(invalid.statusCode, 422, invalid.body)
    assert.equal(invalid.json().code, "PROCESSOR_POLICY_INVALID")

    const foreign = await preview(safetyDefinition(
      connection.connection_id,
      safetyConfig("other-tenant-safety"),
    ))
    assert.equal(foreign.statusCode, 422, foreign.body)
    assert.equal(foreign.json().code, "PROCESSOR_ADAPTER_NOT_FOUND")

    const wrongSafetyKind = await preview(safetyDefinition(
      connection.connection_id,
      safetyConfig("presidio-primary"),
    ))
    assert.equal(wrongSafetyKind.statusCode, 422, wrongSafetyKind.body)
    assert.equal(wrongSafetyKind.json().code, "PROCESSOR_ADAPTER_KIND_INVALID")

    const validDetector = await preview(detectorDefinition(connection.connection_id, "presidio-primary"))
    assert.equal(validDetector.statusCode, 200, validDetector.body)

    const wrongDetectorKind = await preview(detectorDefinition(connection.connection_id, "jev-primary"))
    assert.equal(wrongDetectorKind.statusCode, 422, wrongDetectorKind.body)
    assert.equal(wrongDetectorKind.json().code, "PROCESSOR_ADAPTER_KIND_INVALID")

    const budget = safetyDefinition(connection.connection_id, safetyConfig("jev-primary", 20_000))
    budget.steps.splice(3, 0, {
      step_id: "safety-second",
      kind: "PROCESS",
      implementation: "PROCESSOR",
      depends_on: ["safety"],
      hooks: { request: { action: "SAFETY_CHECK", config: safetyConfig("jev-primary", 20_000) } },
    })
    budget.steps[4] = {
      ...budget.steps[4]!,
      depends_on: ["safety-second"],
    }
    const overBudget = await preview(budget)
    assert.equal(overBudget.statusCode, 422, overBudget.body)
    assert.equal(overBudget.json().code, "PROCESSOR_POLICY_INVALID")
    assert.match(overBudget.json().message, /remote timeout exceeds 30000ms/)

    const valid = safetyDefinition(connection.connection_id, safetyConfig("jev-primary"))
    const saved = await app.inject({
      method: "PUT",
      url: draftPath,
      headers: adminHeaders,
      payload: {
        expected_version: 0,
        base_revision: 0,
        content: { kind: "RESOURCE_CAPABILITY", definition: valid },
      },
    })
    assert.equal(saved.statusCode, 200, saved.body)
    const savedDraft = saved.json()
    const validated = await app.inject({
      method: "POST",
      url: `${draftPath}/validate`,
      headers: adminHeaders,
      payload: {
        expected_version: savedDraft.version,
        expected_content_digest: savedDraft.content_digest,
      },
    })
    assert.equal(validated.statusCode, 200, validated.body)
    const validatedDraft = validated.json()
    const reviewed = await app.inject({
      method: "POST",
      url: `${draftPath}/review`,
      headers: adminHeaders,
      payload: {
        expected_version: validatedDraft.version,
        expected_content_digest: validatedDraft.content_digest,
      },
    })
    assert.equal(reviewed.statusCode, 200, reviewed.body)

    const persistedInvalid = await modules.policyDrafts.save(
      tenantId,
      resourcePolicyKey(resource.resource_id, "read"),
      {
        expected_version: reviewed.json().version,
        base_revision: 0,
        content: {
          kind: "RESOURCE_CAPABILITY",
          definition: safetyDefinition(connection.connection_id, safetyConfig("presidio-primary")),
        },
      },
    )
    const validatedInvalid = await modules.policyDrafts.validate(
      tenantId,
      resourcePolicyKey(resource.resource_id, "read"),
      {
        expectedVersion: persistedInvalid.version,
        expectedContentDigest: persistedInvalid.content_digest,
      },
    )
    const reviewedInvalid = await modules.policyDrafts.review(
      tenantId,
      resourcePolicyKey(resource.resource_id, "read"),
      {
        expectedVersion: validatedInvalid.version,
        expectedContentDigest: validatedInvalid.content_digest,
      },
    )
    const published = await app.inject({
      method: "POST",
      url: `${draftPath}/publish`,
      headers: adminHeaders,
      payload: {
        expected_version: reviewedInvalid.version,
        expected_content_digest: reviewedInvalid.content_digest,
      },
    })
    assert.equal(published.statusCode, 422, published.body)
    assert.equal(published.json().code, "PROCESSOR_ADAPTER_KIND_INVALID")
    assert.equal(
      (await modules.policyDrafts.get(tenantId, resourcePolicyKey(resource.resource_id, "read")))?.version,
      reviewedInvalid.version,
    )
  } finally {
    await app.close()
  }
})
