import assert from "node:assert/strict"
import test from "node:test"
import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

const tenantId = "permission-preview-test"
const payload = { subject_id: "user", runtime_id: "codex", client_id: "genio-one-bot", bot_id: "genio.personal-bot" }

async function setup() {
  const modules = createInMemoryPlatformModules({ connectionEnabled: async () => true })
  await modules.identity.bootstrap({ tenantId, subjects: [
    { subject_id: "admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" },
    { subject_id: "user", kind: "PERSON", display_name: "Test user", role: "USER" },
  ] })
  const org = await modules.organizations.create({ tenantId, display_name: "Engineering", member_subject_ids: ["user"] })
  await modules.botAccessPolicy.publishRuntimePolicy({ tenantId, policyId: "engineering", baseRevision: 0, publishedBy: "admin", definition: {
    display_name: "Engineering", scope: { subject_ids: [], organization_ids: [org.organization_id], roles: ["USER"], client_ids: ["genio-one-bot"], bot_ids: [], runtime_ids: ["codex"] },
    rules: [{ rule_id: "subscription", group_id: "engineering-group", individual_settings: true, target: { runtime_id: "codex", capability_id: "codex.subscription" }, actions: ["use"], effect: "ALLOW", constraints: [], obligations: [{ kind: "audit", parameters: {} }] }],
  } })
  const principalAuthenticator = createStaticPrincipalAuthenticator(Object.fromEntries(["admin", "user"].map((id) => [id, { tenant_id: tenantId, subject_id: id, client_id: "console", role: id === "admin" ? "TENANT_ADMINISTRATOR" : "USER", organization_ids: [], scopes: ["genioone-management"] }])))
  const app = await createManagementApi({ modules, principalAuthenticator, resourceCatalog: modules.resources })
  return { app, modules, org }
}

test("preview uses canonical user membership, distinct operations and actor-owned preview audit", async () => {
  const { app, modules, org } = await setup()
  try {
    const response = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/permission-preview`, headers: { authorization: "Bearer admin" }, payload })
    assert.equal(response.statusCode, 200, response.body)
    const result = response.json()
    assert.equal(result.role, "USER")
    assert.equal(result.bot_access.decision, "DENY")
    assert.ok(result.runtime_decisions.every((value: any) => value.effective_decision === "DENY"))
    assert.deepEqual(result.organization_ids, [org.organization_id])
    assert.equal(result.actor_subject_id, "admin")
    assert.equal(result.runtime_decisions.find((value: any) => value.capability_id === "codex.subscription" && value.action === "use").decision, "ALLOW")
    assert.equal(result.runtime_decisions.find((value: any) => value.capability_id === "codex.subscription" && value.action === "expose").decision, "DENY")
    assert.equal(result.runtime_decisions.find((value: any) => value.capability_id === "computer.use" && value.action === "expose").decision, "DENY")
    assert.equal(result.runtime_decisions.find((value: any) => value.capability_id === "computer.use" && value.action === "invoke").decision, "DENY")
    const audit = await modules.auditEvents.query({ tenantId, subjectId: "admin", offset: 0, limit: 100 })
    const previews = audit.events.filter((event: any) => event.phase === "PREVIEW")
    assert.equal(previews.length, result.runtime_decisions.length)
    assert.ok(previews.every((event: any) => event.actor_subject.subject_id === "admin" && event.target_subject_id === "user"))
    assert.equal(await modules.auditEvents.findRuntimeAuthorization({ tenantId, correlationId: previews[0]!.correlation_id }), null)
    assert.equal((await modules.auditEvents.query({ tenantId, subjectId: "user", offset: 0, limit: 100 })).events.length, 0)
    const seed = await modules.botAccessPolicy.getFirstPartyBotSeed({ tenantId })
    await modules.botAccessPolicy.publishFirstPartyBotPolicy({ tenantId, baseRevision: seed.policy_revision, rules: { ...seed.rules, allowed_subject_ids: ["user"] }, publishedBy: "admin" })
    const allowed = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/permission-preview`, headers: { authorization: "Bearer admin" }, payload })
    assert.equal(allowed.json().bot_access.decision, "ALLOW")
    assert.equal(allowed.json().runtime_decisions.find((value: any) => value.capability_id === "codex.subscription" && value.action === "use").effective_decision, "ALLOW")
    const published = await modules.botAccessPolicy.getRuntimePolicy({ tenantId, policyId: "engineering" })
    assert.equal(published.rules[0]!.group_id, "engineering-group")
    assert.equal(published.rules[0]!.individual_settings, true)
    const alternateClient = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/permission-preview`, headers: { authorization: "Bearer admin" }, payload: { ...payload, client_id: "console" } })
    assert.equal(alternateClient.json().runtime_decisions.find((value: any) => value.capability_id === "codex.subscription" && value.action === "use").decision, "DENY")
  } finally { await app.close() }
})

test("preview applies the computer use gate to computer decisions and preview audit", async () => {
  const { app, modules } = await setup()
  try {
    await modules.botAccessPolicy.publishRuntimePolicy({ tenantId, policyId: "desktop-preview", baseRevision: 0, publishedBy: "admin", definition: {
      display_name: "Desktop preview",
      scope: { subject_ids: ["user"], organization_ids: [], roles: [], client_ids: ["genio-one-bot"], bot_ids: [], runtime_ids: ["codex"] },
      rules: [
        { rule_id: "desktop-expose", target: { runtime_id: "codex", capability_id: "computer.use" }, actions: ["expose"], effect: "ALLOW", constraints: [], obligations: [{ kind: "audit", parameters: {} }] },
        { rule_id: "desktop-invoke", target: { runtime_id: "codex", capability_id: "computer.use" }, actions: ["invoke"], effect: "ALLOW", constraints: [], obligations: [{ kind: "audit", parameters: {} }] },
      ],
    } })
    const seed = await modules.botAccessPolicy.getFirstPartyBotSeed({ tenantId })
    await modules.botAccessPolicy.publishFirstPartyBotPolicy({ tenantId, baseRevision: seed.policy_revision, rules: { ...seed.rules, allowed_subject_ids: ["user"] }, publishedBy: "admin" })

    const disabled = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/permission-preview`, headers: { authorization: "Bearer admin" }, payload })
    assert.equal(disabled.statusCode, 200, disabled.body)
    const disabledResult = disabled.json()
    assert.equal(disabledResult.bot_access.decision, "ALLOW")
    const disabledComputer = disabledResult.runtime_decisions.filter((value: any) => value.capability_id === "computer.use")
    assert.deepEqual(disabledComputer.map((value: any) => ({ action: value.action, decision: value.decision, effective_decision: value.effective_decision, reason_code: value.reason_code })), [
      { action: "expose", decision: "ALLOW", effective_decision: "DENY", reason_code: "COMPUTER_USE_NOT_IN_DEFAULT_POLICY" },
      { action: "invoke", decision: "ALLOW", effective_decision: "DENY", reason_code: "COMPUTER_USE_NOT_IN_DEFAULT_POLICY" },
    ])
    const disabledAudit = await modules.auditEvents.query({ tenantId, correlationId: disabledComputer[0]!.correlation_id, offset: 0, limit: 100 })
    const disabledComputerAudit = disabledAudit.events.filter((event: any) => event.phase === "PREVIEW" && event.capability_id === "computer.use").sort((left: any, right: any) => left.action.localeCompare(right.action))
    assert.deepEqual(disabledComputerAudit.map((event: any) => ({ action: event.action, outcome: event.outcome, decision: event.decision, reason_code: event.reason_code })), [
      { action: "expose", outcome: "DENY", decision: "DENY", reason_code: "COMPUTER_USE_NOT_IN_DEFAULT_POLICY" },
      { action: "invoke", outcome: "DENY", decision: "DENY", reason_code: "COMPUTER_USE_NOT_IN_DEFAULT_POLICY" },
    ])

    const enabledSeed = await modules.botAccessPolicy.getFirstPartyBotSeed({ tenantId })
    await modules.botAccessPolicy.publishFirstPartyBotPolicy({ tenantId, baseRevision: enabledSeed.policy_revision, rules: { ...enabledSeed.rules, computer_use_enabled: true }, publishedBy: "admin" })
    const enabled = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/permission-preview`, headers: { authorization: "Bearer admin" }, payload })
    assert.equal(enabled.statusCode, 200, enabled.body)
    const enabledComputer = enabled.json().runtime_decisions.filter((value: any) => value.capability_id === "computer.use")
    assert.equal(enabledComputer.length, 2)
    assert.ok(enabledComputer.every((value: any) => value.decision === "ALLOW" && value.effective_decision === "ALLOW" && value.reason_code.startsWith("RULE_ALLOW:")))
    const enabledAudit = await modules.auditEvents.query({ tenantId, correlationId: enabledComputer[0]!.correlation_id, offset: 0, limit: 100 })
    const enabledComputerAudit = enabledAudit.events.filter((event: any) => event.phase === "PREVIEW" && event.capability_id === "computer.use")
    assert.equal(enabledComputerAudit.length, 2)
    assert.ok(enabledComputerAudit.every((event: any) => event.outcome === "ALLOW" && event.decision === "ALLOW" && event.reason_code.startsWith("RULE_ALLOW:")))
  } finally { await app.close() }
})

test("preview rejects non-admin, cross-tenant and unknown subjects; response contains no private data", async () => {
  const { app } = await setup()
  try {
    for (const [token, tenant, subject, expected] of [["user", tenantId, "user", 403], ["admin", "other-tenant", "user", 403], ["admin", tenantId, "missing", 404]] as const) {
      const response = await app.inject({ method: "POST", url: `/v1/tenants/${tenant}/one-policy/permission-preview`, headers: { authorization: `Bearer ${token}` }, payload: { ...payload, subject_id: subject } })
      assert.equal(response.statusCode, expected, response.body)
    }
    const response = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/permission-preview`, headers: { authorization: "Bearer admin" }, payload })
    assert.equal(response.headers["cache-control"], "no-store")
    assert.deepEqual(Object.keys(response.json()).sort(), ["access_group_ids", "actor_subject_id", "bot_access", "bot_id", "capabilities", "client_id", "evaluated_at", "organization_ids", "role", "runtime_decisions", "runtime_id", "subject_display_name", "subject_id"].sort())
    assert.doesNotMatch(response.body, /access_token|refresh_token|conversation|attachment|memory/)
  } finally { await app.close() }
})

test("group metadata survives draft publication without widening explicit permissions", async () => {
  const { app } = await setup()
  try {
    const rules = [
      { rule_id: "model", group_id: "team", target: { runtime_id: "codex", capability_id: "model.invoke" }, actions: ["invoke"], effect: "ALLOW", constraints: [], obligations: [{ kind: "audit", parameters: {} }] },
      { rule_id: "subscription", group_id: "team", individual_settings: true, target: { runtime_id: "codex", capability_id: "codex.subscription" }, actions: ["use"], effect: "ALLOW", constraints: [], obligations: [{ kind: "audit", parameters: {} }] },
    ]
    const url = `/v1/tenants/${tenantId}/one-policy/runtime-policies/group-roundtrip`
    const headers = { authorization: "Bearer admin" }
    const draft = await app.inject({ method: "PUT", url: `${url}/draft`, headers, payload: { expected_version: 0, base_revision: 0, content: { kind: "RUNTIME_CAPABILITY", definition: { display_name: "Group roundtrip", scope: { subject_ids: ["user"], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: ["codex"] }, rules } } } })
    assert.equal(draft.statusCode, 200, draft.body)
    const validated = await app.inject({ method: "POST", url: `${url}/draft/validate`, headers, payload: { expected_version: draft.json().version, expected_content_digest: draft.json().content_digest } })
    assert.equal(validated.statusCode, 200, validated.body)
    const reviewed = await app.inject({ method: "POST", url: `${url}/draft/review`, headers, payload: { expected_version: validated.json().version, expected_content_digest: validated.json().content_digest } })
    assert.equal(reviewed.statusCode, 200, reviewed.body)
    const published = await app.inject({ method: "POST", url: `${url}/draft/publish`, headers, payload: { expected_version: reviewed.json().version, expected_content_digest: reviewed.json().content_digest } })
    assert.equal(published.statusCode, 200, published.body)
    assert.deepEqual(published.json().rules, rules)
    const effective = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/one-policy/runtime-effective?bot_id=genio.personal-bot&runtime_id=codex&capability_id=model.invoke&action=expose`, headers: { authorization: "Bearer user" } })
    assert.equal(effective.json().decision, "DENY")
  } finally { await app.close() }
})
