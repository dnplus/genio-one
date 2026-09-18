import test from "node:test"
import assert from "node:assert/strict"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createPostgresDemoInstallationStore } from "../src/capabilities/demo-project/postgres"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

const tenantId = "tenant-demo-project"

class FirstWriteRaceSql implements SqlAdapter {
  record: Record<string, unknown> | null = null
  readonly statements: string[] = []

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    this.statements.push(text)
    if (text.includes("values ($1, null, 'SKIPPED'")) {
      this.record = {
        tenant_id: String(parameters?.[0]),
        organization_id: "demo-organization",
        installation: "INSTALLED",
        resource_ids: ["genio.demo.bot"],
        item_errors: [],
      }
      return { rows: [], rowCount: 0 }
    }
    if (text.includes("values ($1, $2, 'INSTALLED'")) {
      if (this.record?.organization_id !== parameters?.[1]) return { rows: [], rowCount: 0 }
    }
    if (text.includes("from genio_one_demo_installations")) {
      return { rows: this.record ? [this.record as Row] : [], rowCount: this.record ? 1 : 0 }
    }
    return { rows: [], rowCount: 0 }
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

async function createApi(options: { geminiCredentialRef?: string; runtimeConnectionEnabled?: boolean } = {}) {
  const modules = createInMemoryPlatformModules({
    ...(options.runtimeConnectionEnabled ? { connectionEnabled: async () => true } : {}),
  })
  const organization = await modules.organizations.create({
    tenantId,
    display_name: "Demo Organization",
    slug: "demo-organization",
  })
  const otherOrganization = await modules.organizations.create({
    tenantId,
    display_name: "Other Organization",
    slug: "other-organization",
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      admin: {
        tenant_id: tenantId,
        subject_id: "admin",
        client_id: "console",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [organization.organization_id, otherOrganization.organization_id],
      },
      organizationAdmin: {
        tenant_id: tenantId,
        subject_id: "organization-admin",
        client_id: "console",
        role: "ORGANIZATION_ADMINISTRATOR",
        organization_ids: [organization.organization_id],
      },
      user: {
        tenant_id: tenantId,
        subject_id: "user",
        client_id: "console",
        role: "USER",
        organization_ids: [],
      },
    }),
    entitlementResolver: modules.entitlements,
    demoProjectArchifyEndpoint: "http://127.0.0.1:5193/mcp",
    demoProjectArchifyCredentialRef: "genio-demo-archify",
    demoProjectGeminiCredentialRef: options.geminiCredentialRef,
    demoProjectBotUrl: "http://127.0.0.1:5180",
  })
  return { app, modules, organization, otherOrganization }
}

function request(
  app: Awaited<ReturnType<typeof createManagementApi>>,
  token: string,
  method: "GET" | "POST",
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { "content-type": "application/json" } : {}) },
    ...(payload ? { payload: JSON.stringify(payload) } : {}),
  })
}

function jsonbValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(jsonbValue) as T
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, jsonbValue(item)])) as T
  }
  return value
}

test("demo project install is resumable, grants the actor, and exposes only verified readiness", async () => {
  const { app, modules, organization } = await createApi()
  try {
    const initial = await request(app, "organizationAdmin", "GET", `/v1/tenants/${tenantId}/demo-project`)
    assert.equal(initial.statusCode, 200)
    assert.equal(initial.json().installation, "NOT_INSTALLED")

    const installed = await request(app, "organizationAdmin", "POST", `/v1/tenants/${tenantId}/demo-project/install`, {
      organization_id: organization.organization_id,
    })
    assert.equal(installed.statusCode, 200, installed.body)
    const body = installed.json() as {
      installation: string
      package_resource_id: string
      bot_url: string | null
      items: Array<{ id: string; state: string; action_url?: string }>
      prompts: Array<{ id: string }>
    }
    assert.equal(body.installation, "INSTALLED")
    assert.equal(body.package_resource_id, "genio.demo.bot")
    assert.equal(body.bot_url, "http://127.0.0.1:5180")
    assert.deepEqual(body.prompts.map((prompt) => prompt.id), ["documents", "spec-and-diagram", "interviews"])
    assert.equal(body.items.find((item) => item.id === "context7")?.state, "DISABLED")
    assert.equal(body.items.find((item) => item.id === "archify")?.state, "DISABLED")
    assert.equal(body.items.find((item) => item.id === "gemini")?.state, "NEEDS_CONFIGURATION")
    assert.equal(body.items.find((item) => item.id === "product-management")?.state, "READY")
    assert.equal(body.items.find((item) => item.id === "archify")?.action_url, "/management?view=connections&resource=genio.demo.archify")

    const repeated = await request(app, "organizationAdmin", "POST", `/v1/tenants/${tenantId}/demo-project/install`, {
      organization_id: organization.organization_id,
    })
    assert.equal(repeated.statusCode, 200, repeated.body)
    assert.equal((await modules.resources.listResources({ tenantId })).filter((resource) => resource.resource_id.startsWith("genio.demo.")).length, 5)
    assert.equal((await modules.connections.list({ tenantId, resourceId: "genio.demo.context7" })).length, 1)
    assert.equal((await modules.connections.list({ tenantId, resourceId: "genio.demo.archify" })).length, 1)
    assert.equal((await modules.connections.list({ tenantId, resourceId: "genio.demo.gemini" })).length, 0)
    assert.equal((await modules.usageGovernance.getActiveUseCase({
      tenant_id: tenantId,
      organization_id: organization.organization_id,
      use_case_id: "ce-demo",
    }))?.display_name, "CE 示範專案")

    const catalog = await request(app, "organizationAdmin", "GET", `/v1/tenants/${tenantId}/catalog`)
    assert.equal(catalog.statusCode, 200, catalog.body)
    const extension = (catalog.json() as { capabilities: Array<{ resource_id: string; capability_id: string; connection_status: string; access: string }> }).capabilities
      .find((capability) => capability.resource_id === "genio.demo.bot" && capability.capability_id === "product-management")
    assert.deepEqual(extension && {
      connection_status: extension.connection_status,
      access: extension.access,
    }, { connection_status: "READY", access: "ENTITLED" })
  } finally {
    await app.close()
  }
})

test("demo project publishes an actor-scoped Codex subscription runtime policy", async () => {
  const { app, modules, organization } = await createApi({ runtimeConnectionEnabled: true })
  try {
    const installed = await request(app, "organizationAdmin", "POST", `/v1/tenants/${tenantId}/demo-project/install`, {
      organization_id: organization.organization_id,
    })
    assert.equal(installed.statusCode, 200, installed.body)
    const policies = await modules.botAccessPolicy.listRuntimePolicies(tenantId)
    assert.equal(policies.length, 1)
    assert.deepEqual(policies[0]?.scope, {
      subject_ids: ["organization-admin"],
      organization_ids: [],
      roles: [],
      client_ids: ["genio-one-bot"],
      bot_ids: [],
      runtime_ids: ["codex"],
    })
    assert.deepEqual(policies[0]?.rules, [{
      rule_id: "allow-codex-subscription",
      target: { runtime_id: "codex", capability_id: "codex.subscription" },
      actions: ["use"],
      effect: "ALLOW",
      constraints: [],
      obligations: [{ kind: "audit", enforcement_point_id: "AGENT_RUNTIME", parameters: { event_kind: "invoke" } }],
    }, {
      rule_id: "allow-model-invoke",
      target: { runtime_id: "codex", capability_id: "model.invoke" },
      actions: ["invoke"],
      effect: "ALLOW",
      constraints: [],
      obligations: [{ kind: "audit", enforcement_point_id: "AGENT_RUNTIME", parameters: { event_kind: "invoke" } }],
    }])
    const getRuntimePolicy = modules.botAccessPolicy.getRuntimePolicy.bind(modules.botAccessPolicy)
    modules.botAccessPolicy.getRuntimePolicy = async (input) => jsonbValue(await getRuntimePolicy(input))
    const repeated = await request(app, "organizationAdmin", "POST", `/v1/tenants/${tenantId}/demo-project/install`, {
      organization_id: organization.organization_id,
    })
    assert.equal(repeated.statusCode, 200, repeated.body)
    assert.equal((await modules.botAccessPolicy.listRuntimePolicyRevisions(tenantId)).length, 1)

    const allowed = await modules.botAccessPolicy.authorizeRuntime({
      principal: {
        tenant_id: tenantId,
        subject_id: "organization-admin",
        client_id: "genio-one-bot",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
      },
      correlation_id: "demo-codex-allowed",
      bot_id: "installed-demo-bot",
      runtime_id: "codex",
      capability_id: "codex.subscription",
      action: "use",
    })
    assert.equal(allowed.decision, "ALLOW")
    assert.equal(allowed.reason_code, "RULE_ALLOW:allow-codex-subscription")
    assert.deepEqual(allowed.obligations, [{ kind: "audit", enforcement_point_id: "AGENT_RUNTIME", parameters: { event_kind: "invoke" } }])

    const modelAllowed = await modules.botAccessPolicy.authorizeRuntime({
      principal: {
        tenant_id: tenantId,
        subject_id: "organization-admin",
        client_id: "genio-one-bot",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
      },
      correlation_id: "demo-gemini-model-allowed",
      bot_id: "installed-demo-bot",
      runtime_id: "codex",
      capability_id: "model.invoke",
      action: "invoke",
    })
    assert.equal(modelAllowed.decision, "ALLOW")
    assert.equal(modelAllowed.reason_code, "RULE_ALLOW:allow-model-invoke")

    const shellDenied = await modules.botAccessPolicy.authorizeRuntime({
      principal: {
        tenant_id: tenantId,
        subject_id: "organization-admin",
        client_id: "genio-one-bot",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
      },
      correlation_id: "demo-shell-denied",
      bot_id: "installed-demo-bot",
      runtime_id: "codex",
      capability_id: "shell.exec",
      action: "invoke",
    })
    assert.equal(shellDenied.decision, "DENY")
    assert.equal(shellDenied.reason_code, "DEFAULT_DENY")

    const denied = await modules.botAccessPolicy.authorizeRuntime({
      principal: {
        tenant_id: tenantId,
        subject_id: "organization-admin",
        client_id: "console",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
      },
      correlation_id: "demo-codex-wrong-client",
      bot_id: "installed-demo-bot",
      runtime_id: "codex",
      capability_id: "codex.subscription",
      action: "use",
    })
    assert.equal(denied.decision, "DENY")
    assert.equal(denied.reason_code, "POLICY_SCOPE_NOT_ALLOWED")

    const current = policies[0]!
    await modules.botAccessPolicy.publishRuntimePolicy({
      tenantId,
      policyId: current.policy_id,
      baseRevision: current.revision,
      publishedBy: "organization-admin",
      definition: {
        display_name: current.display_name,
        scope: current.scope,
        rules: current.rules.slice(0, 1),
      },
    })
    const migrated = await request(app, "organizationAdmin", "POST", `/v1/tenants/${tenantId}/demo-project/install`, {
      organization_id: organization.organization_id,
    })
    assert.equal(migrated.statusCode, 200, migrated.body)
    const revisions = await modules.botAccessPolicy.listRuntimePolicyRevisions(tenantId)
    assert.equal(revisions.length, 3)
    assert.equal(revisions[0]?.revision, 3)
    assert.equal(revisions[0]?.rules.length, 2)
  } finally {
    await app.close()
  }
})

test("demo installation store preserves an installed first writer against a concurrent skip", async () => {
  const sql = new FirstWriteRaceSql()
  const store = createPostgresDemoInstallationStore(sql)

  const skipped = await store.skip({ tenantId })
  assert.equal(skipped.installation, "INSTALLED")
  assert.equal(skipped.organization_id, "demo-organization")
  assert.ok(sql.statements.some((statement) =>
    statement.includes("where genio_one_demo_installations.installation = 'SKIPPED'"),
  ))
  assert.ok(sql.statements.every((statement) => !statement.includes("for update")))

  await assert.rejects(
    () => store.saveInstalled({
      tenantId,
      organizationId: "other-organization",
      resourceIds: [],
    }),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error &&
      error.code === "DEMO_PROJECT_ORGANIZATION_CONFLICT",
  )
})

test("demo project binds Gemini to an opaque managed credential profile", async () => {
  const { app, modules, organization } = await createApi({ geminiCredentialRef: "genio-demo-gemini" })
  try {
    const installed = await request(app, "organizationAdmin", "POST", `/v1/tenants/${tenantId}/demo-project/install`, {
      organization_id: organization.organization_id,
    })
    assert.equal(installed.statusCode, 200, installed.body)
    const profile = await modules.providerCredentials.getLatest({
      tenantId,
      profileId: "genio.demo.gemini-credential",
    })
    assert.deepEqual(profile && {
      owner_organization_id: profile.owner_organization_id,
      strategy: profile.strategy,
    }, {
      owner_organization_id: organization.organization_id,
      strategy: { kind: "STATIC_SECRET_REFERENCE", secret_ref: "genio-demo-gemini" },
    })
    const [connection] = await modules.connections.list({ tenantId, resourceId: "genio.demo.gemini" })
    assert.deepEqual(connection?.provider_credential_profile && {
      profile_id: connection.provider_credential_profile.profile_id,
      revision: connection.provider_credential_profile.revision,
    }, {
      profile_id: "genio.demo.gemini-credential",
      revision: 1,
    })
    assert.equal(connection?.credential_ref, null)
    const resource = await modules.resources.getResource({ tenantId, resourceId: "genio.demo.gemini" })
    assert.deepEqual(resource.capabilities, [{ capability_id: "model.invoke", display_name: "Gemini 3.8 Flash" }])
  } finally {
    await app.close()
  }
})

test("demo project can resume after skip and rejects another organization", async () => {
  const { app, organization, otherOrganization } = await createApi()
  try {
    const skipped = await request(app, "organizationAdmin", "POST", `/v1/tenants/${tenantId}/demo-project/skip`)
    assert.equal(skipped.statusCode, 200, skipped.body)
    assert.equal(skipped.json().installation, "SKIPPED")

    const installed = await request(app, "organizationAdmin", "POST", `/v1/tenants/${tenantId}/demo-project/install`, {
      organization_id: organization.organization_id,
    })
    assert.equal(installed.statusCode, 200, installed.body)

    const conflict = await request(app, "admin", "POST", `/v1/tenants/${tenantId}/demo-project/install`, {
      organization_id: otherOrganization.organization_id,
    })
    assert.equal(conflict.statusCode, 409)
    assert.equal(conflict.json().code, "DEMO_PROJECT_ORGANIZATION_CONFLICT")

    const denied = await request(app, "user", "GET", `/v1/tenants/${tenantId}/demo-project`)
    assert.equal(denied.statusCode, 403)
  } finally {
    await app.close()
  }
})
