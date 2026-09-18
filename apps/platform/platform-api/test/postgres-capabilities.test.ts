import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"
import { createPostgresResourceConnectionRegistry } from "../src/capabilities/connections/postgres"
import { createPostgresPublicModelCatalog } from "../src/capabilities/models/postgres"
import { createPostgresOrganizationDirectory } from "../src/capabilities/organizations/postgres"
import { createPostgresPlatformModules } from "../src/capabilities/platform-modules-postgres"
import { createPostgresProviderProfileCatalog } from "../src/capabilities/providers/postgres"
import { createPostgresResourceRegistry } from "../src/capabilities/resources/postgres"
import { PlatformApiError } from "../src/capabilities/errors"
import { parseConnectionCertificate } from "../src/capabilities/connections/certificate"

type Row = Record<string, unknown>

const resourceRow: Row = {
  tenant_id: "tenant-acme",
  resource_id: "resource-ai",
  display_name: "Corporate AI",
  kind: "LLM",
  owner_organization_id: "org-ai",
  authentication_strategy: "OAUTH",
  environment_id: "local",
  version: "1.0.0",
  lifecycle: "DRAFT",
  operational_state: "UNKNOWN",
  capabilities: [{ capability_id: "chat", display_name: "Chat" }],
  enforcement_point_id: "ai-gateway",
  row_revision: 1,
  resource_digest: null,
  created_at: 1_700_000_000,
}

const connectionRow: Row = {
  tenant_id: "tenant-acme",
  connection_id: "connection-1",
  resource_id: "resource-ai",
  display_name: "Local Ollama",
  connection_kind: "LLM",
  provider_type: "OLLAMA",
  provider_profile_id: "provider-ollama",
  endpoint: "http://127.0.0.1:11434",
  mcp_tool_namespace: null,
  mcp_selected_tools: [],
  mcp_tool_selection_operation_id: null,
  credential_ref: null,
  downstream_identity: { mode: "NONE" },
  request_mapping: null,
  status: "DRAFT",
  configuration_revision: 1,
  lifecycle: "DRAFT",
  verification_state: "UNVERIFIED",
  health_state: "UNKNOWN",
  health_observed_at: null,
  health_source_revision: null,
  routing_priority: 0,
  region: null,
  supported_obligations: [],
  created_at: 1_700_000_001,
  row_revision: 1,
}

const providerRow: Row = {
  tenant_id: "tenant-acme",
  profile_id: "provider-ollama",
  display_name: "Ollama (local)",
  provider_type: "OLLAMA",
  protocol: "OPENAI_COMPATIBLE",
  capabilities: ["CHAT", "STREAMING", "TOOL_CALLING"],
  model_discovery: "PROVIDER_API",
  endpoint_required: true,
  credential_required: false,
  built_in: true,
}

const publicationRow: Row = {
  tenant_id: "tenant-acme",
  publication_id: "publication-1",
  resource_id: "resource-ai",
  endpoint_revision: 1,
  resource_revision: 1,
  resource_digest: "resource-digest",
  policy_revision: 0,
  gateway_id: "ai-gateway",
  hostname: "ai.example.test",
  base_path: "/v1",
  visibility: "PRIVATE",
  publication_state: "DRAFT",
  dns_management: "PLATFORM_MANAGED",
  dns_proof_status: "VERIFIED",
  dns_proof: { dns_target: "gateway.example.test" },
  request_snapshot: {},
  review_snapshot: {},
  row_revision: 1,
  created_at: 1_700_000_002,
  updated_at: 1_700_000_002,
}

class FakeSqlAdapter implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []

  constructor(readonly handler: (text: string, parameters: readonly unknown[]) => Row[] = () => []) {}

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    const rows = this.handler(text, parameters) as Result[]
    return { rows, rowCount: rows.length }
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

function has(text: string, fragment: string): boolean {
  return text.toLowerCase().includes(fragment.toLowerCase())
}

function errorCode(error: unknown): string | null {
  return error instanceof PlatformApiError ? error.code : null
}

test("Postgres module composition shares one SQL boundary", () => {
  const sql = new FakeSqlAdapter()
  const modules = createPostgresPlatformModules({
    sql,
    idFactory: (prefix) => `${prefix}-test`,
  })
  assert.equal(modules.sql, sql)
  assert.notEqual(modules.resources, modules.connections)
  assert.notEqual(modules.resources, modules.models)
})

test("organization adapter uses tenant-scoped parameterized SQL", async () => {
  const sql = new FakeSqlAdapter((text) => {
    if (has(text, "insert into genio_one_organizations")) {
      return [
        {
          tenant_id: "tenant-acme",
          organization_id: "org-test",
          display_name: "Commerce",
          slug: "commerce",
          member_subject_ids: [],
          organization_administrator_subject_ids: [],
          membership_sources: [],
          created_at: 1_700_000_000,
        },
      ]
    }
    if (has(text, "from genio_one_organization_memberships") ||
        has(text, "from genio_one_organization_membership_sources")) return []
    return [
      {
        tenant_id: "tenant-acme",
        organization_id: "org-test",
        display_name: "Commerce",
        slug: "commerce",
        member_subject_ids: [],
        organization_administrator_subject_ids: [],
        membership_sources: [],
        created_at: 1_700_000_000,
      },
    ]
  })
  const directory = createPostgresOrganizationDirectory({
    sql,
    idFactory: () => "org-test",
  })

  const organization = await directory.create({
    tenantId: "tenant-acme",
    display_name: "Commerce",
  })
  assert.deepEqual(organization, {
    tenant_id: "tenant-acme",
    organization_id: "org-test",
    display_name: "Commerce",
    slug: "commerce",
    member_subject_ids: [],
    organization_administrator_subject_ids: [],
    membership_sources: [],
    created_at: 1_700_000_000,
  })
  await directory.get({ tenantId: "tenant-acme", organizationId: "org-test" })
  const insert = sql.calls.find((call) => has(call.text, "insert into genio_one_organizations"))
  assert.ok(insert)
  assert.equal(insert.text.includes("tenant-acme"), false)
  assert.deepEqual(insert.parameters, ["tenant-acme", "org-test", "Commerce", "commerce"])
})

test("Resource persistence keeps Publication in its own aggregate and checks owner", async () => {
  const sql = new FakeSqlAdapter((text) => {
    if (has(text, "from genio_one_organizations")) return [{ organization_id: "org-ai" }]
    if (has(text, "insert into genio_one_resources")) return [resourceRow]
    if (has(text, "from genio_one_resources") && has(text, "for update")) return [resourceRow]
    if (has(text, "from genio_one_resource_connections")) return [{ connection_id: "connection-1" }]
    if (has(text, "select coalesce(max(endpoint_revision)")) return [{ next_revision: 1 }]
    if (has(text, "insert into genio_one_publications")) return [publicationRow]
    if (has(text, "from genio_one_publications")) return []
    return []
  })
  const organizations = createPostgresOrganizationDirectory({ sql })
  const resources = createPostgresResourceRegistry({
    sql,
    organizations,
    verifyDns: () => true,
    idFactory: () => "resource-ai",
  })
  const created = await resources.createResource({
    tenantId: "tenant-acme",
    value: {
      display_name: "Corporate AI",
      kind: "LLM",
      owner_organization_id: "org-ai",
      authentication_strategy: "OAUTH",
      environment_id: "local",
      version: "1.0.0",
      enforcement_point_id: "ai-gateway",
    },
  })
  assert.equal(created.lifecycle, "DRAFT")
  assert.equal(created.publication_endpoint, null)

  const withEndpoint = await resources.setPublicationEndpoint({
    tenantId: "tenant-acme",
    resourceId: "resource-ai",
    value: {
      gateway_id: "ai-gateway",
      hostname: "ai.example.test",
      base_path: "/v1",
      dns_management: "PLATFORM_MANAGED",
      dns_verification: "VERIFIED",
      dns_target: "gateway.example.test",
    },
  })
  assert.equal(withEndpoint.publication_endpoint?.hostname, "ai.example.test")
  assert.equal(withEndpoint.publication_endpoint?.dns_target, "gateway.example.test")
  const resourceInsert = sql.calls.find((call) => has(call.text, "insert into genio_one_resources"))
  assert.ok(resourceInsert)
  assert.equal(resourceInsert.text.includes("publication_endpoint"), false)
  assert.match(resourceInsert.text, /\$9::text::jsonb/i)
  const publicationInsert = sql.calls.find((call) => has(call.text, "insert into genio_one_publications"))
  assert.ok(publicationInsert)
  assert.equal(publicationInsert.text.includes("secret"), false)
  assert.match(publicationInsert.text, /\$13::text::jsonb/i)
})

test("Provider capabilities are inserted as JSON arrays, not JSON strings", async () => {
  const sql = new FakeSqlAdapter((text) => {
    if (has(text, "select") && has(text, "from genio_one_provider_profiles")) {
      return [providerRow]
    }
    return []
  })
  const providers = createPostgresProviderProfileCatalog({ sql })
  await providers.list({ tenantId: "tenant-acme" })
  const inserts = sql.calls.filter((call) => has(call.text, "insert into genio_one_provider_profiles"))
  assert.ok(inserts.length > 0)
  for (const insert of inserts) assert.match(insert.text, /\$6::text::jsonb/i)
})

test("Resource update is revision-aware and fails closed on a lost update", async () => {
  const sql = new FakeSqlAdapter((text) => {
    if (has(text, "from genio_one_resources")) return [resourceRow]
    if (has(text, "update genio_one_resources")) return []
    return []
  })
  const organizations = createPostgresOrganizationDirectory({ sql })
  const resources = createPostgresResourceRegistry({ sql, organizations })
  await assert.rejects(
    resources.updateResource({
      tenantId: "tenant-acme",
      resourceId: "resource-ai",
      value: { display_name: "Concurrent write" },
    }),
    (error: unknown) => errorCode(error) === "RESOURCE_REVISION_CONFLICT",
  )
  const update = sql.calls.find((call) => has(call.text, "update genio_one_resources"))
  assert.ok(update)
  assert.match(update.text, /row_revision\s*=\s*\$\d+/i)
})

test("Draft Resource edits advance an idle Publication snapshot reference", async () => {
  const sql = new FakeSqlAdapter((text) => {
    if (has(text, "update genio_one_resources")) {
      return [{ ...resourceRow, version: "2.0.0", row_revision: 2 }]
    }
    if (has(text, "from genio_one_resources")) return [resourceRow]
    return []
  })
  const organizations = createPostgresOrganizationDirectory({ sql })
  const resources = createPostgresResourceRegistry({ sql, organizations })

  const updated = await resources.updateResource({
    tenantId: "tenant-acme",
    resourceId: "resource-ai",
    value: { version: "2.0.0" },
  })

  assert.equal(updated.version, "2.0.0")
  const publicationUpdate = sql.calls.find((call) =>
    has(call.text, "update genio_one_publications"),
  )
  assert.ok(publicationUpdate)
  assert.match(publicationUpdate.text, /publication_state\s*=\s*'DRAFT'/i)
  assert.match(publicationUpdate.text, /publication_build_state\s*=\s*'IDLE'/i)
  assert.match(publicationUpdate.text, /request_snapshot\s*=\s*'\{\}'::jsonb/i)
  assert.deepEqual(publicationUpdate.parameters.slice(0, 3), [
    "tenant-acme",
    "resource-ai",
    2,
  ])
})

test("Connection adapter rejects embedded credentials before touching SQL", async () => {
  const sql = new FakeSqlAdapter()
  const providers = createPostgresProviderProfileCatalog({ sql })
  const connections = createPostgresResourceConnectionRegistry({ sql, providers })
  await assert.rejects(
    connections.create({
      tenantId: "tenant-acme",
      resourceId: "resource-ai",
      value: {
        display_name: "Unsafe",
        provider_type: "OLLAMA",
        endpoint: "http://user:password@127.0.0.1:11434",
      },
    }),
    (error: unknown) => errorCode(error) === "CONNECTION_ENDPOINT_CREDENTIALS_FORBIDDEN",
  )
  assert.equal(sql.calls.length, 0)
})

test("Public Model list hides unpublished Resources by default", async () => {
  const sql = new FakeSqlAdapter((text) => {
    if (has(text, "from genio_one_public_models")) {
      return [
        {
          tenant_id: "tenant-acme",
          model_id: "model-1",
          model_name: "llama3",
          display_name: "Llama 3",
          resource_id: "resource-ai",
          visibility: "PUBLIC",
          lifecycle: "PUBLISHED",
          capabilities: ["CHAT"],
          created_at: 1_700_000_003,
        },
      ]
    }
    return []
  })
  const models = createPostgresPublicModelCatalog({
    sql,
    resources: {} as never,
    connections: {} as never,
    providers: {} as never,
  })
  const result = await models.list({ tenantId: "tenant-acme" })
  assert.equal(result[0]?.model_name, "llama3")
  const query = sql.calls[0]
  assert.match(query.text, /r\.lifecycle\s*=\s*'PUBLISHED'/i)
  assert.deepEqual(query.parameters, ["tenant-acme", "PUBLIC"])
})

test("tenant mismatch never falls through to a same-id row", async () => {
  const sql = new FakeSqlAdapter(() => [])
  const organizations = createPostgresOrganizationDirectory({ sql })
  const resources = createPostgresResourceRegistry({ sql, organizations })
  await assert.rejects(
    resources.getResource({ tenantId: "tenant-other", resourceId: "resource-ai" }),
    (error: unknown) => errorCode(error) === "RESOURCE_NOT_FOUND",
  )
  assert.deepEqual(sql.calls[0]?.parameters, ["tenant-other", "resource-ai"])
})

test("Connection reads include the optimistic row revision", async () => {
  const sql = new FakeSqlAdapter((text) => {
    if (has(text, "from genio_one_resource_connections")) return [connectionRow]
    return [{ resource_id: "resource-ai" }]
  })
  const connections = createPostgresResourceConnectionRegistry({
    sql,
    providers: {} as never,
  })
  await connections.get({
    tenantId: "tenant-acme",
    resourceId: "resource-ai",
    connectionId: "connection-1",
  })
  const select = sql.calls.find((call) => has(call.text, "from genio_one_resource_connections"))
  assert.ok(select)
  assert.match(select.text, /row_revision/i)
})

test("Connection update resets verification once when endpoint and credential profile change together", async () => {
  const digest = "a".repeat(64)
  const profile = {
    tenant_id: "tenant-acme",
    profile_id: "provider-credential-gcp",
    revision: 1,
    owner_organization_id: "org-ai",
    display_name: "GCP runtime identity",
    adapter_family: "GCP" as const,
    strategy: {
      kind: "RUNTIME_IDENTITY" as const,
      adapter: "GCP_APPLICATION_DEFAULT" as const,
      parameters: { project_name: "project-acme", region: "us-central1" },
    },
    strategy_digest: digest,
    state: "ACTIVE" as const,
    created_by_subject_id: "person-admin",
    created_at: 1_700_000_002,
  }
  const updatedRow = {
    ...connectionRow,
    endpoint: "https://us-central1-aiplatform.googleapis.com/v1",
    provider_credential_profile_id: profile.profile_id,
    provider_credential_profile_revision: profile.revision,
    provider_credential_strategy_digest: digest,
    downstream_identity: { mode: "SERVICE", authentication: "PROVIDER_CREDENTIAL_PROFILE" },
    configuration_revision: 2,
    row_revision: 2,
  }
  const sql = new FakeSqlAdapter((text) => {
    if (has(text, "update genio_one_resource_connections")) return [updatedRow]
    if (has(text, "from genio_one_resource_connections")) return [connectionRow]
    if (has(text, "from genio_one_resources")) return [resourceRow]
    return []
  })
  const providerCredentials = {
    getRevision: async () => profile,
    getLatest: async () => profile,
  }
  const connections = createPostgresResourceConnectionRegistry({
    sql,
    providers: {} as never,
    providerCredentials: providerCredentials as never,
  })

  await connections.update({
    tenantId: "tenant-acme",
    resourceId: "resource-ai",
    connectionId: "connection-1",
    value: {
      expected_revision: 1,
      endpoint: updatedRow.endpoint,
      provider_credential_profile: { profile_id: profile.profile_id, revision: profile.revision },
    },
  })

  const update = sql.calls.find((call) => has(call.text, "update genio_one_resource_connections"))
  assert.ok(update)
  assert.equal((update.text.match(/verification_state\s*=/gi) ?? []).length, 1)
  assert.equal((update.text.match(/health_state\s*=/gi) ?? []).length, 1)
  assert.equal((update.text.match(/health_observed_at\s*=/gi) ?? []).length, 1)
  assert.equal((update.text.match(/health_source_revision\s*=/gi) ?? []).length, 1)
})

test("published Connection certificate rotation stages a successor and resets readiness", async () => {
  const certificate = parseConnectionCertificate({
    mode: "CUSTOM_CA",
    certificate_pem: readFileSync(new URL("../../tests/fixtures/client-auth/test-client-ca.pem", import.meta.url), "utf8"),
  }, 1_800_000_000)
  const publishedResource = { ...resourceRow, lifecycle: "PUBLISHED" }
  const currentConnection = {
    ...connectionRow,
    status: "READY",
    lifecycle: "ENABLED",
    verification_state: "VERIFIED",
    health_state: "HEALTHY",
    health_observed_at: 1_800_000_000,
    health_source_revision: 1,
    certificate_mode: "SYSTEM_CA",
    certificate_pem: null,
    certificate_fingerprint_sha256: null,
    certificate_subject: null,
    certificate_issuer: null,
    certificate_is_self_signed: false,
    certificate_not_before: null,
    certificate_not_after: null,
  }
  const rotatedConnection = {
    ...currentConnection,
    certificate_mode: certificate.mode,
    certificate_pem: certificate.certificate_pem,
    certificate_fingerprint_sha256: certificate.fingerprint_sha256,
    certificate_subject: certificate.subject,
    certificate_issuer: certificate.issuer,
    certificate_is_self_signed: certificate.is_self_signed,
    certificate_not_before: certificate.not_before,
    certificate_not_after: certificate.not_after,
    configuration_revision: 2,
    row_revision: 2,
    verification_state: "UNVERIFIED",
    health_state: "UNKNOWN",
    health_observed_at: null,
    health_source_revision: null,
  }
  const sql = new FakeSqlAdapter((text) => {
    if (has(text, "from genio_one_resources") && !has(text, "select publication_id")) return [publishedResource]
    if (has(text, "select publication_id, endpoint_revision")) return [{ ...publicationRow, publication_state: "PUBLISHED" }]
    if (has(text, "update genio_one_resource_connections")) return [rotatedConnection]
    if (has(text, "from genio_one_resource_connections")) return [currentConnection]
    return []
  })
  const connections = createPostgresResourceConnectionRegistry({
    sql,
    providers: {} as never,
    idFactory: () => "publication-successor",
    now: () => 1_800_000_000,
  })

  const updated = await connections.updateCertificate({
    tenantId: "tenant-acme",
    resourceId: "resource-ai",
    connectionId: "connection-1",
    value: {
      expected_revision: 1,
      mode: "CUSTOM_CA",
      certificate_pem: certificate.certificate_pem,
    },
  })

  assert.equal(updated.configuration_revision, 2)
  assert.equal(updated.verification_state, "UNVERIFIED")
  assert.equal(updated.health_state, "UNKNOWN")
  assert.equal(updated.certificate?.fingerprint_sha256, certificate.fingerprint_sha256)
  assert.equal(updated.certificate?.status, "VALID")
  assert.equal(sql.calls.some((call) => has(call.text, "insert into genio_one_publications")), true)
})

test("caller cannot mark DNS verified without a server proof", async () => {
  const sql = new FakeSqlAdapter((text) => {
    if (has(text, "from genio_one_resources")) return [resourceRow]
    if (has(text, "from genio_one_resource_connections")) return [{ connection_id: "connection-1" }]
    return []
  })
  const organizations = createPostgresOrganizationDirectory({ sql })
  const resources = createPostgresResourceRegistry({ sql, organizations })
  await assert.rejects(
    resources.setPublicationEndpoint({
      tenantId: "tenant-acme",
      resourceId: "resource-ai",
      value: {
        gateway_id: "ai-gateway",
        hostname: "ai.example.test",
        base_path: "/v1",
        dns_management: "PLATFORM_MANAGED",
        dns_verification: "VERIFIED",
        dns_target: "gateway.example.test",
      },
    }),
    (error: unknown) => errorCode(error) === "PUBLICATION_DNS_PROOF_REQUIRED",
  )
  assert.equal(sql.calls.some((call) => has(call.text, "insert into genio_one_publications")), false)
})

test("Public Model creation requires a draft Resource, ready Connection, and exact provider profile", async () => {
  const provider = {
    ...providerRow,
    tenant_id: "tenant-acme",
  }
  const providers = {
    get: async () => provider,
  } as never
  const makeCatalog = (resource: Row, connection: Row) => {
    const sql = new FakeSqlAdapter((text) => {
      if (has(text, "from genio_one_resources")) return [resource]
      if (has(text, "from genio_one_resource_connections")) return [connection]
      if (has(text, "insert into genio_one_public_models")) {
        return [{
          tenant_id: "tenant-acme",
          model_id: "model-test",
          model_name: "llama3",
          display_name: "Llama 3",
          resource_id: "resource-ai",
          visibility: "PUBLIC",
          lifecycle: "PUBLISHED",
          capabilities: ["CHAT"],
          created_at: 1_700_000_003,
        }]
      }
      return []
    })
    return { sql, catalog: createPostgresPublicModelCatalog({
      sql,
      resources: {} as never,
      connections: {} as never,
      providers,
      idFactory: () => "model-test",
    }) }
  }

  const notReady = makeCatalog(resourceRow, { ...connectionRow, status: "DRAFT" })
  await assert.rejects(
    notReady.catalog.create({
      tenantId: "tenant-acme",
      resourceId: "resource-ai",
      value: {
        model_name: "llama3",
        display_name: "Llama 3",
        mappings: [{ connection_id: "connection-1", provider_model: "llama3" }],
      },
    }),
    (error: unknown) => errorCode(error) === "CONNECTION_NOT_READY",
  )

  const publishedResource = makeCatalog({ ...resourceRow, lifecycle: "PUBLISHED" }, {
    ...connectionRow,
    status: "READY",
  })
  await assert.rejects(
    publishedResource.catalog.create({
      tenantId: "tenant-acme",
      resourceId: "resource-ai",
      value: {
        model_name: "llama3",
        display_name: "Llama 3",
        mappings: [{ connection_id: "connection-1", provider_model: "llama3" }],
      },
    }),
    (error: unknown) => errorCode(error) === "PUBLISHED_RESOURCE_IMMUTABLE",
  )

  const mapped = makeCatalog(resourceRow, { ...connectionRow, status: "READY" })
  const created = await mapped.catalog.create({
      tenantId: "tenant-acme",
      resourceId: "resource-ai",
      value: {
        model_name: "llama3",
        display_name: "Llama 3",
        mappings: [{ connection_id: "connection-1", provider_model: "llama3" }],
      },
    })
  assert.equal(created.model_id, "model-test")
  const modelInsert = mapped.sql.calls.find((call) => has(call.text, "insert into genio_one_public_models"))
  assert.ok(modelInsert)
  assert.match(modelInsert.text, /\$7::text::jsonb/i)
})

test("draft publication DNS can be configured before an owned Connection is ready", async () => {
  const sql = new FakeSqlAdapter((text) => {
    if (has(text, "from genio_one_resources")) return [{ ...resourceRow, kind: "API" }]
    if (has(text, "insert into genio_one_publications")) return [publicationRow]
    return []
  })
  const organizations = createPostgresOrganizationDirectory({ sql })
  const resources = createPostgresResourceRegistry({ sql, organizations, dnsTargetForGateway: () => "edge.company.test" })
  await resources.setPublicationEndpoint({
    tenantId: "tenant-acme", resourceId: "resource-ai",
    value: { gateway_id: "api-gateway", hostname: "api.company.test", base_path: "/", dns_management: "EXTERNAL", dns_verification: "PENDING", dns_target: "untrusted.example" },
  })
  const insert = sql.calls.find((call) => has(call.text, "insert into genio_one_publications"))
  assert.ok(insert)
  assert.match(JSON.stringify(insert), /edge.company.test/)
  assert.doesNotMatch(JSON.stringify(insert), /untrusted.example/)
  assert.equal(sql.calls.some((call) => has(call.text, "from genio_one_resource_connections")), false)
})

test("Access Destinations and Extension Packages cannot use Frontend publication", async () => {
  for (const kind of ["SAAS", "EXTENSION"] as const) {
    const sql = new FakeSqlAdapter((text) => {
      if (has(text, "from genio_one_resources")) return [{ ...resourceRow, kind }]
      return []
    })
    const organizations = createPostgresOrganizationDirectory({ sql })
    const resources = createPostgresResourceRegistry({ sql, organizations })
    await assert.rejects(
      resources.setPublicationEndpoint({
        tenantId: "tenant-acme",
        resourceId: "resource-ai",
        value: {
          gateway_id: "ai-gateway",
          hostname: "ai.example.test",
          base_path: "/",
          dns_management: "EXTERNAL",
          dns_verification: "PENDING",
        },
      }),
      (error: unknown) => errorCode(error) === "RESOURCE_KIND_NOT_FRONTEND",
    )
  }
})

test("Resource CRUD cannot bypass the publication snapshot workflow", async () => {
  const sql = new FakeSqlAdapter((text) => {
    if (has(text, "from genio_one_resources")) return [resourceRow]
    if (has(text, "from genio_one_publications")) {
      return [{
        ...publicationRow,
        publication_state: "PENDING_REVIEW",
        request_snapshot: {
          request_id: "request-1",
          state: "PENDING",
          requested_by: "org-admin",
          requested_at: 1_700_000_004,
        },
        resource_digest: "stale-digest",
      }]
    }
    return []
  })
  const organizations = createPostgresOrganizationDirectory({ sql })
  const resources = createPostgresResourceRegistry({ sql, organizations })
  await assert.rejects(
    resources.reviewPublication({
      tenantId: "tenant-acme",
      resourceId: "resource-ai",
      requestId: "request-1",
      value: { decision: "APPROVE", reviewer_id: "platform-admin" },
    }),
    (error: unknown) => errorCode(error) === "PUBLICATION_WORKFLOW_REQUIRED",
  )
})
