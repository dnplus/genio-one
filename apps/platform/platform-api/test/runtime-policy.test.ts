import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import type { ResourceConnectionRegistry } from "../src/capabilities/connections/module"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import { PERSONAL_BOT_RESOURCE_ID, evaluateRuntimePolicy } from "../src/capabilities/one-policy/runtime"
import {
  RUNTIME_REPORT_KEY_ID_HEADER,
  RUNTIME_REPORT_SIGNATURE_HEADER,
  signRuntimeReport,
} from "../../../../runtimes/gateway/services/shared/runtime-report-attestation"

const tenantId = "tenant-runtime-policy"
const adminHeaders = { authorization: "Bearer admin" }
const runtimeReportKeys = generateKeyPairSync("ed25519")
const runtimeReportPrivateKeyPem = runtimeReportKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const runtimeReportPublicKeyPem = runtimeReportKeys.publicKey.export({ type: "spki", format: "pem" }).toString()

function runtimeDefinition(scope: Record<string, unknown>, effect: "ALLOW" | "DENY" = "ALLOW") {
  return {
    kind: "RUNTIME_CAPABILITY" as const,
    definition: {
      display_name: "Codex subscription access",
      scope,
      rules: [{
        rule_id: `${effect.toLowerCase()}-codex-subscription`,
        target: { runtime_id: "codex", capability_id: "codex.subscription" },
        actions: ["use" as const],
        effect,
        constraints: [],
        obligations: [],
      }],
    },
  }
}

function principals() {
  return createStaticPrincipalAuthenticator({
    admin: {
      tenant_id: tenantId,
      subject_id: "person-admin",
      client_id: "console",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: [],
      scopes: ["genioone-management", "genioone-invocation"],
    },
    anrita: {
      tenant_id: tenantId,
      subject_id: "person-uat-anrita",
      client_id: "genio-one-bot",
      role: "USER",
      organization_ids: ["org-executive"],
      scopes: ["genioone-management", "genioone-invocation"],
    },
    dylan: {
      tenant_id: tenantId,
      subject_id: "person-uat-dylan",
      client_id: "genio-one-bot",
      role: "USER",
      organization_ids: ["org-engineering"],
      scopes: ["genioone-management", "genioone-invocation"],
    },
  })
}

async function reviewRuntimeDraft(
  app: import("fastify").FastifyInstance,
  draftPath: string,
  draft: { version: number; content_digest: string },
) {
  const validated = await app.inject({
    method: "POST",
    url: `${draftPath}/validate`,
    headers: adminHeaders,
    payload: { expected_version: draft.version, expected_content_digest: draft.content_digest },
  })
  assert.equal(validated.statusCode, 200, validated.body)
  const validatedValue = validated.json() as { version: number; content_digest: string }
  const reviewed = await app.inject({
    method: "POST",
    url: `${draftPath}/review`,
    headers: adminHeaders,
    payload: { expected_version: validatedValue.version, expected_content_digest: validatedValue.content_digest },
  })
  assert.equal(reviewed.statusCode, 200, reviewed.body)
  return reviewed.json() as { version: number; content_digest: string }
}

function platformModulesWithBotConnection(
  initialLifecycle: "ENABLED" | "DISABLED" = "ENABLED",
  options: { runtimeReportKeyId?: string; runtimeReportPublicKeyPem?: string } = {},
) {
  let lifecycle = initialLifecycle
  let connections: ResourceConnectionRegistry | undefined
  const modules = createInMemoryPlatformModules({
    ...options,
    connectionEnabled: async ({ tenantId, botId }) => {
      if (botId !== PERSONAL_BOT_RESOURCE_ID || !connections) return false
      try {
        const values = await connections.list({ tenantId, resourceId: PERSONAL_BOT_RESOURCE_ID })
        return values.some((connection) => connection.resource_id === PERSONAL_BOT_RESOURCE_ID && connection.connection_id === PERSONAL_BOT_RESOURCE_ID && connection.lifecycle === "ENABLED")
      } catch {
        return false
      }
    },
  })
  connections = {
    ...modules.connections,
    async list(input) {
      if (input.resourceId === PERSONAL_BOT_RESOURCE_ID) {
        return [{
          tenant_id: input.tenantId,
          resource_id: PERSONAL_BOT_RESOURCE_ID,
          connection_id: PERSONAL_BOT_RESOURCE_ID,
          lifecycle,
        } as never]
      }
      return modules.connections.list(input)
    },
  }
  return {
    modules,
    setLifecycle(value: "ENABLED" | "DISABLED") {
      lifecycle = value
    },
  }
}

test("runtime policy catalog composes scoped rows with deny precedence and nullable unconfigured revision", async () => {
  const { modules } = platformModulesWithBotConnection()
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: principals() })
  const effectiveUrl = `/v1/tenants/${tenantId}/one-policy/runtime-effective?bot_id=managed-genio-bot&runtime_id=codex&capability_id=codex.subscription&action=use`
  try {
    const unconfigured = await app.inject({ method: "GET", url: effectiveUrl, headers: { authorization: "Bearer anrita" } })
    assert.equal(unconfigured.statusCode, 200)
    assert.equal(unconfigured.json().decision, "DENY")
    assert.equal(unconfigured.json().policy_id, null)
    assert.equal(unconfigured.json().policy_revision, null)
    assert.equal(unconfigured.json().reason_code, "POLICY_NOT_CONFIGURED")

    const denyDraft = await app.inject({ method: "PUT", url: `/v1/tenants/${tenantId}/one-policy/runtime-policies/runtime-anrita-deny/draft`, headers: adminHeaders, payload: { expected_version: 0, base_revision: 0, content: runtimeDefinition({ subject_ids: ["person-uat-anrita"], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] }, "DENY") } })
    assert.equal(denyDraft.statusCode, 200, denyDraft.body)
    const denyReviewed = await reviewRuntimeDraft(app, `/v1/tenants/${tenantId}/one-policy/runtime-policies/runtime-anrita-deny/draft`, denyDraft.json())
    const denyRevision = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-policies/runtime-anrita-deny/draft/publish`, headers: adminHeaders, payload: { expected_version: denyReviewed.version, expected_content_digest: denyReviewed.content_digest } })
    assert.equal(denyRevision.statusCode, 200, denyRevision.body)
    assert.equal(denyRevision.json().revision, 1)

    const allowDraft = await app.inject({ method: "PUT", url: `/v1/tenants/${tenantId}/one-policy/runtime-policies/runtime-anrita-allow/draft`, headers: adminHeaders, payload: { expected_version: 0, base_revision: 0, content: runtimeDefinition({ subject_ids: ["person-uat-anrita"], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] }) } })
    assert.equal(allowDraft.statusCode, 200, allowDraft.body)
    const allowReviewed = await reviewRuntimeDraft(app, `/v1/tenants/${tenantId}/one-policy/runtime-policies/runtime-anrita-allow/draft`, allowDraft.json())
    const allowRevision = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-policies/runtime-anrita-allow/draft/publish`, headers: adminHeaders, payload: { expected_version: allowReviewed.version, expected_content_digest: allowReviewed.content_digest } })
    assert.equal(allowRevision.statusCode, 200, allowRevision.body)

    const denied = await app.inject({ method: "GET", url: effectiveUrl, headers: { authorization: "Bearer anrita" } })
    assert.equal(denied.statusCode, 200)
    assert.equal(denied.json().decision, "DENY")
    assert.match(denied.json().reason_code, /^RULE_DENY:/)

    const dylanPolicy = await app.inject({ method: "PUT", url: `/v1/tenants/${tenantId}/one-policy/runtime-policies/runtime-dylan-allow/draft`, headers: adminHeaders, payload: { expected_version: 0, base_revision: 0, content: runtimeDefinition({ subject_ids: ["person-uat-dylan"], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] }) } })
    assert.equal(dylanPolicy.statusCode, 200, dylanPolicy.body)
    const dylanReviewed = await reviewRuntimeDraft(app, `/v1/tenants/${tenantId}/one-policy/runtime-policies/runtime-dylan-allow/draft`, dylanPolicy.json())
    const dylanPublished = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-policies/runtime-dylan-allow/draft/publish`, headers: adminHeaders, payload: { expected_version: dylanReviewed.version, expected_content_digest: dylanReviewed.content_digest } })
    assert.equal(dylanPublished.statusCode, 200, dylanPublished.body)

    const dylanAllowed = await app.inject({ method: "GET", url: effectiveUrl, headers: { authorization: "Bearer dylan" } })
    assert.equal(dylanAllowed.statusCode, 200)
    assert.equal(dylanAllowed.json().decision, "ALLOW")
    assert.equal(dylanAllowed.json().policy_id, "runtime-dylan-allow")
    assert.equal(dylanAllowed.json().policy_display_name, "Codex subscription access")

    const policies = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/one-policy/runtime-policies`, headers: adminHeaders })
    assert.equal(policies.statusCode, 200)
    assert.deepEqual(policies.json().map((item: { policy_id: string }) => item.policy_id), ["runtime-anrita-allow", "runtime-anrita-deny", "runtime-dylan-allow"])
  } finally {
    await app.close()
  }
})

test("authorize is idempotent, report binds the verified decision, and policy disable creates a revision", async () => {
  const { modules } = platformModulesWithBotConnection("ENABLED", { runtimeReportKeyId: "runtime-policy-test", runtimeReportPublicKeyPem })
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: principals() })
  const policyPath = `/v1/tenants/${tenantId}/one-policy/runtime-policies/runtime-reportable`
  try {
    const saved = await app.inject({ method: "PUT", url: `${policyPath}/draft`, headers: adminHeaders, payload: { expected_version: 0, base_revision: 0, content: runtimeDefinition({ subject_ids: ["person-uat-dylan"], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] }) } })
    assert.equal(saved.statusCode, 200, saved.body)
    const reviewed = await reviewRuntimeDraft(app, `${policyPath}/draft`, saved.json())
    const published = await app.inject({ method: "POST", url: `${policyPath}/draft/publish`, headers: adminHeaders, payload: { expected_version: reviewed.version, expected_content_digest: reviewed.content_digest } })
    assert.equal(published.statusCode, 200, published.body)

    const authorizeBody = { correlation_id: "corr-runtime-1", bot_id: "managed-genio-bot", runtime_id: "codex", capability_id: "codex.subscription", action: "use" }
    const authorized = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-authorize`, headers: { authorization: "Bearer dylan" }, payload: authorizeBody })
    assert.equal(authorized.statusCode, 200, authorized.body)
    assert.equal(authorized.json().decision, "ALLOW")
    const retry = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-authorize`, headers: { authorization: "Bearer dylan" }, payload: authorizeBody })
    assert.equal(retry.statusCode, 200, retry.body)
    assert.deepEqual(retry.json(), authorized.json())

    const reportBody = { ...authorizeBody, outcome: "COMPLETED" as const }
    const reportHeaders = {
      authorization: "Bearer dylan",
      [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test",
      [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(reportBody, runtimeReportPrivateKeyPem),
    }
    const report = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: reportHeaders, payload: reportBody })
    assert.equal(report.statusCode, 201, report.body)
    assert.equal(report.json().phase, "REPORT")
    assert.equal(report.json().authorization_audit_event_id, "corr-runtime-1:authorize")
    assert.equal(report.json().policy_revision, 1)

    const spoofed = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: reportHeaders, payload: { ...reportBody, policy_revision: 999, constraints: [{ kind: "unknown", parameters: {} }] } })
    assert.equal(spoofed.statusCode, 201)
    assert.equal(spoofed.json().policy_revision, 1)
    assert.deepEqual(spoofed.json().constraints, [])

    const missingAttestation = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: { authorization: "Bearer dylan" }, payload: reportBody })
    assert.equal(missingAttestation.statusCode, 403)

    const disabled = await app.inject({ method: "PATCH", url: policyPath, headers: adminHeaders, payload: { expected_revision: 1, enabled: false } })
    assert.equal(disabled.statusCode, 200, disabled.body)
    assert.equal(disabled.json().revision, 2)
    assert.equal(disabled.json().enabled, false)
    const afterDisable = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/one-policy/runtime-effective?bot_id=managed-genio-bot&runtime_id=codex&capability_id=codex.subscription&action=use`, headers: { authorization: "Bearer dylan" } })
    assert.equal(afterDisable.statusCode, 200)
    assert.equal(afterDisable.json().decision, "DENY")
    assert.equal(afterDisable.json().reason_code, "POLICY_DISABLED")
    assert.equal(afterDisable.json().policy_revision, 2)

    const policyAudit = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/audit-events?kind=POLICY_CHANGE`, headers: adminHeaders })
    assert.equal(policyAudit.statusCode, 200, policyAudit.body)
    const disabledEvent = policyAudit.json().find((event: { action: string }) => event.action === "DISABLED")
    assert.deepEqual(disabledEvent && {
      policy_key: disabledEvent.policy_key,
      enabled: disabledEvent.enabled,
      subject_id: disabledEvent.subject.subject_id,
      actor_subject_id: disabledEvent.actor_subject.subject_id,
      base_revision: disabledEvent.base_revision,
      published_revision: disabledEvent.published_revision,
      correlation_id: typeof disabledEvent.correlation_id === "string" && disabledEvent.correlation_id.length > 0,
    }, {
      policy_key: "runtime-capability:runtime-reportable",
      enabled: false,
      subject_id: "person-admin",
      actor_subject_id: "person-admin",
      base_revision: 1,
      published_revision: 2,
      correlation_id: true,
    })

    const audit = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/audit-events?correlation_id=corr-runtime-1`, headers: adminHeaders })
    assert.equal(audit.statusCode, 200, audit.body)
    assert.deepEqual(audit.json().map((event: { phase: string }) => event.phase), ["REPORT", "AUTHORIZE"])
    const runtimeOnly = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/audit-events?enforcement_point_id=AGENT_RUNTIME`, headers: adminHeaders })
    assert.equal(runtimeOnly.statusCode, 200, runtimeOnly.body)
    assert.equal(runtimeOnly.json().length, 2)
  } finally {
    await app.close()
  }
})

test("computer use independently authorizes discovery and desktop invocation with correlated audit", async () => {
  const { modules } = platformModulesWithBotConnection("ENABLED", { runtimeReportKeyId: "runtime-policy-test", runtimeReportPublicKeyPem })
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: principals() })
  const policyPath = `/v1/tenants/${tenantId}/one-policy/runtime-policies/desktop-control`
  const scope = { subject_ids: ["person-uat-dylan"], organization_ids: [], roles: [], client_ids: ["genio-one-bot"], bot_ids: [], runtime_ids: ["codex"] }
  try {
    const saved = await app.inject({ method: "PUT", url: `${policyPath}/draft`, headers: adminHeaders, payload: {
      expected_version: 0,
      base_revision: 0,
      content: {
        kind: "RUNTIME_CAPABILITY",
        definition: {
          display_name: "Desktop control",
          scope,
          rules: [
            { rule_id: "expose-computer", target: { runtime_id: "codex", capability_id: "computer.use" }, actions: ["expose"], effect: "ALLOW", constraints: [], obligations: [{ kind: "audit", enforcement_point_id: "AGENT_RUNTIME", parameters: { event_kind: "expose" } }] },
            { rule_id: "invoke-computer", target: { runtime_id: "codex", capability_id: "computer.use" }, actions: ["invoke"], effect: "ALLOW", constraints: [], obligations: [{ kind: "audit", enforcement_point_id: "AGENT_RUNTIME", parameters: { event_kind: "invoke" } }] },
          ],
        },
      },
    } })
    assert.equal(saved.statusCode, 200, saved.body)
    const reviewed = await reviewRuntimeDraft(app, `${policyPath}/draft`, saved.json())
    const published = await app.inject({ method: "POST", url: `${policyPath}/draft/publish`, headers: adminHeaders, payload: { expected_version: reviewed.version, expected_content_digest: reviewed.content_digest } })
    assert.equal(published.statusCode, 200, published.body)

    const discovery = { correlation_id: "corr-computer-expose", bot_id: "managed-genio-bot", runtime_id: "codex", capability_id: "computer.use", action: "expose" }
    const discoveryAuthorization = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-authorize`, headers: { authorization: "Bearer dylan" }, payload: discovery })
    assert.equal(discoveryAuthorization.statusCode, 200, discoveryAuthorization.body)
    assert.equal(discoveryAuthorization.json().decision, "ALLOW")

    const invocation = { correlation_id: "corr-computer-invoke", bot_id: "managed-genio-bot", runtime_id: "codex", capability_id: "computer.use", action: "invoke" }
    const invocationAuthorization = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-authorize`, headers: { authorization: "Bearer dylan" }, payload: invocation })
    assert.equal(invocationAuthorization.statusCode, 200, invocationAuthorization.body)
    assert.equal(invocationAuthorization.json().decision, "ALLOW")

    const reportBody = { ...invocation, outcome: "COMPLETED" as const }
    const report = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/one-policy/runtime-report`,
      headers: {
        authorization: "Bearer dylan",
        [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test",
        [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(reportBody, runtimeReportPrivateKeyPem),
      },
      payload: reportBody,
    })
    assert.equal(report.statusCode, 201, report.body)
    assert.equal(report.json().capability_id, "computer.use")
    assert.equal(report.json().action, "invoke")
    assert.equal(report.json().authorization_audit_event_id, "corr-computer-invoke:authorize")

    const audit = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/audit-events?correlation_id=corr-computer-invoke`, headers: adminHeaders })
    assert.equal(audit.statusCode, 200, audit.body)
    assert.deepEqual(audit.json().map((event: { phase: string }) => event.phase), ["REPORT", "AUTHORIZE"])
  } finally {
    await app.close()
  }
})

test("unsupported persisted constraints are a deny decision", () => {
  const result = evaluateRuntimePolicy({
    tenant_id: tenantId,
    policy_id: "invalid-policy",
    revision: 1,
    display_name: "Invalid",
    provenance: "TENANT_AUTHORED",
    enabled: true,
    scope: { subject_ids: [], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] },
    rules: [{
      rule_id: "allow-with-unknown-constraint",
      target: { runtime_id: "codex", capability_id: "codex.subscription" },
      actions: ["use"],
      effect: "ALLOW",
      constraints: [{ kind: "unknown", parameters: {} }],
      obligations: [],
    }],
    published_by_subject_id: null,
    created_at: 1,
    published_at: 1,
  } as never, {
    tenant_id: tenantId,
    subject_id: "person-uat-dylan",
    client_id: "genio-one-bot",
    role: "USER",
    organization_ids: [],
    bot_id: "managed-genio-bot",
    runtime_id: "codex",
    capability_id: "codex.subscription",
    action: "use",
    evaluated_at: 1,
  })
  assert.equal(result.decision, "DENY")
  assert.equal(result.reason_code, "POLICY_INVALID")
})

test("adapter discovered capability identifiers stay open while unregistered capabilities deny", () => {
  const policy = {
    tenant_id: tenantId,
    policy_id: "adapter-capability-policy",
    revision: 1,
    display_name: "Adapter capabilities",
    provenance: "TENANT_AUTHORED" as const,
    enabled: true,
    scope: { subject_ids: [], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] },
    rules: [{
      rule_id: "allow-plugin-install",
      target: { runtime_id: "codex", capability_id: "plugin.install" },
      actions: ["execute" as const],
      effect: "ALLOW" as const,
      constraints: [],
      obligations: [],
    }],
    published_by_subject_id: null,
    created_at: 1,
    published_at: 1,
  }
  const input = {
    tenant_id: tenantId,
    subject_id: "person-uat-dylan",
    client_id: "genio-one-bot",
    role: "USER" as const,
    organization_ids: [],
    bot_id: "managed-genio-bot",
    runtime_id: "codex",
    capability_id: "plugin.install",
    action: "execute" as const,
    evaluated_at: 1,
  }
  assert.equal(evaluateRuntimePolicy(policy, input).reason_code, "RUNTIME_CAPABILITY_NOT_REGISTERED")
  assert.equal(evaluateRuntimePolicy(policy, input, { capability_registered: true }).decision, "ALLOW")
})

test("the managed personal Bot connection is a runtime gate", async () => {
  const { modules } = platformModulesWithBotConnection("DISABLED")
  const decision = await modules.botAccessPolicy.evaluateRuntime({
    principal: {
      tenant_id: tenantId,
      subject_id: "person-uat-dylan",
      client_id: "genio-one-bot",
      role: "USER",
      organization_ids: [],
    },
    bot_id: "bot-instance-uuid",
    runtime_id: "codex",
    capability_id: "codex.subscription",
    action: "use",
  })
  assert.equal(decision.decision, "DENY")
  assert.equal(decision.reason_code, "BOT_CONNECTION_DISABLED")
})

test("the installed Genio Bot lifecycle gates P_B_USE and runtime policy for Bot instances", async () => {
  const { modules, setLifecycle } = platformModulesWithBotConnection()
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: principals() })
  const botId = "bot-instance-uuid"
  const effectiveUrl = `/v1/tenants/${tenantId}/one-policy/runtime-effective?bot_id=${botId}&runtime_id=codex&capability_id=codex.subscription&action=use`
  const accessUrl = `/v1/tenants/${tenantId}/one-policy/bot-access?capability_id=personal_bot.use`
  const runtimePath = `/v1/tenants/${tenantId}/one-policy/runtime-policies/runtime-instance-allow`
  try {
    await modules.botAccessPolicy.publishFirstPartyBotPolicy({
      tenantId,
      baseRevision: 1,
      rules: { allowed_roles: ["USER"], allowed_subject_ids: [] },
      publishedBy: "person-admin",
    })
    const saved = await app.inject({ method: "PUT", url: `${runtimePath}/draft`, headers: adminHeaders, payload: { expected_version: 0, base_revision: 0, content: runtimeDefinition({ subject_ids: ["person-uat-dylan"], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] }) } })
    assert.equal(saved.statusCode, 200, saved.body)
    const reviewed = await reviewRuntimeDraft(app, `${runtimePath}/draft`, saved.json())
    const published = await app.inject({ method: "POST", url: `${runtimePath}/draft/publish`, headers: adminHeaders, payload: { expected_version: reviewed.version, expected_content_digest: reviewed.content_digest } })
    assert.equal(published.statusCode, 200, published.body)

    const enabledAccess = await app.inject({ method: "GET", url: accessUrl, headers: { authorization: "Bearer dylan" } })
    assert.equal(enabledAccess.json().decision, "ALLOW")
    const enabledEffective = await app.inject({ method: "GET", url: effectiveUrl, headers: { authorization: "Bearer dylan" } })
    assert.equal(enabledEffective.json().decision, "ALLOW")
    assert.equal(enabledEffective.json().bot_id, botId)
    const enabledAuthorization = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-authorize`, headers: { authorization: "Bearer dylan" }, payload: { correlation_id: "bot-instance-enabled", bot_id: botId, runtime_id: "codex", capability_id: "codex.subscription", action: "use" } })
    assert.equal(enabledAuthorization.json().decision, "ALLOW")
    assert.equal(enabledAuthorization.json().bot_id, botId)

    setLifecycle("DISABLED")
    const disabledAccess = await app.inject({ method: "GET", url: accessUrl, headers: { authorization: "Bearer dylan" } })
    assert.equal(disabledAccess.json().decision, "DENY")
    assert.equal(disabledAccess.json().reason_code, "BOT_CONNECTION_DISABLED")
    const disabledEffective = await app.inject({ method: "GET", url: effectiveUrl, headers: { authorization: "Bearer dylan" } })
    assert.equal(disabledEffective.json().decision, "DENY")
    assert.equal(disabledEffective.json().reason_code, "BOT_CONNECTION_DISABLED")
    assert.equal(disabledEffective.json().bot_id, botId)
    const disabledAuthorization = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-authorize`, headers: { authorization: "Bearer dylan" }, payload: { correlation_id: "bot-instance-disabled", bot_id: botId, runtime_id: "codex", capability_id: "codex.subscription", action: "use" } })
    assert.equal(disabledAuthorization.json().decision, "DENY")
    assert.equal(disabledAuthorization.json().reason_code, "BOT_CONNECTION_DISABLED")
    assert.equal(disabledAuthorization.json().bot_id, botId)

    setLifecycle("ENABLED")
    const reenabledAccess = await app.inject({ method: "GET", url: accessUrl, headers: { authorization: "Bearer dylan" } })
    assert.equal(reenabledAccess.json().decision, "ALLOW")
    const reenabledEffective = await app.inject({ method: "GET", url: effectiveUrl, headers: { authorization: "Bearer dylan" } })
    assert.equal(reenabledEffective.json().decision, "ALLOW")
    assert.equal(reenabledEffective.json().bot_id, botId)
  } finally {
    await app.close()
  }
})
