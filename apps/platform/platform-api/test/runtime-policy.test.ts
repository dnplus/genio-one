import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import type { ResourceConnectionRegistry } from "../src/capabilities/connections/module"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import { PERSONAL_BOT_RESOURCE_ID, evaluateRuntimePolicies, evaluateRuntimePolicy } from "../src/capabilities/one-policy/runtime"
import { validateRuntimePolicyForPublication } from "../src/capabilities/one-policy/runtime-policy-validator"
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

function placementDefinition(domain: "ON_PREM" | "MANAGED_CLOUD") {
  return {
    kind: "RUNTIME_CAPABILITY" as const,
    definition: {
      display_name: "Hands placement",
      scope: { subject_ids: ["person-uat-dylan"], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] },
      rules: [{
        rule_id: "allow-hands",
        target: { runtime_id: "codex", capability_id: "remote_hands.use" },
        actions: ["use" as const],
        effect: "ALLOW" as const,
        constraints: [{ kind: "execution_placement" as const, parameters: { execution_domain: domain } }],
        obligations: [],
      }],
    },
  }
}

test("published Hands placement resolves to the policy domain and ignores a requested backend", { timeout: 30_000 }, async () => {
  const { modules } = platformModulesWithBotConnection("ENABLED", { runtimeReportKeyId: "runtime-policy-test", runtimeReportPublicKeyPem })
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: principals() })
  const policyPath = `/v1/tenants/${tenantId}/one-policy/runtime-policies/hands-placement`
  try {
    const saved = await app.inject({ method: "PUT", url: `${policyPath}/draft`, headers: adminHeaders, payload: { expected_version: 0, base_revision: 0, content: placementDefinition("MANAGED_CLOUD") } })
    assert.equal(saved.statusCode, 200, saved.body)
    const reviewed = await reviewRuntimeDraft(app, `${policyPath}/draft`, saved.json())
    const published = await app.inject({ method: "POST", url: `${policyPath}/draft/publish`, headers: adminHeaders, payload: { expected_version: reviewed.version, expected_content_digest: reviewed.content_digest } })
    assert.equal(published.statusCode, 200, published.body)
    const reopened = await app.inject({ method: "GET", url: policyPath, headers: adminHeaders })
    assert.equal(reopened.statusCode, 200, reopened.body)
    assert.deepEqual(reopened.json().rules[0].constraints, placementDefinition("MANAGED_CLOUD").definition.rules[0]?.constraints)
    const effectiveUrl = `/v1/tenants/${tenantId}/one-policy/runtime-effective?bot_id=managed-genio-bot&runtime_id=codex&capability_id=remote_hands.use&action=use`
    const effective = await app.inject({ method: "GET", url: `${effectiveUrl}&provider=e2b-self-hosted`, headers: { authorization: "Bearer dylan" } })
    assert.equal(effective.statusCode, 200, effective.body)
    assert.equal(effective.json().decision, "ALLOW")
    assert.deepEqual(effective.json().constraints, [{ kind: "execution_placement", parameters: { execution_domain: "MANAGED_CLOUD" } }])
    const authorized = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-authorize`, headers: { authorization: "Bearer dylan" }, payload: { correlation_id: "hands-placement-1", bot_id: "managed-genio-bot", runtime_id: "codex", capability_id: "remote_hands.use", action: "use", provider: "e2b-self-hosted" } })
    assert.equal(authorized.statusCode, 200, authorized.body)
    assert.deepEqual(authorized.json().constraints, effective.json().constraints)
    const reportBody = { tenant_id: tenantId, correlation_id: "hands-placement-1", bot_id: "managed-genio-bot", runtime_id: "codex", capability_id: "remote_hands.use", action: "use", outcome: "FAILED", reason_code: "POLICY_PLACEMENT_CHANGED" }
    const report = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: {
      authorization: "Bearer dylan",
      [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test",
      [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(reportBody, runtimeReportPrivateKeyPem),
    }, payload: reportBody })
    assert.equal(report.statusCode, 201, report.body)
    assert.equal(report.json().reason_code, "POLICY_PLACEMENT_CHANGED")
    assert.equal(report.json().authorization_audit_event_id, "hands-placement-1:authorize")
  } finally {
    await app.close()
  }
})

test("publication rejects unsupported targets and conflicting placement domains", () => {
  const definition = placementDefinition("ON_PREM").definition
  assert.doesNotThrow(() => validateRuntimePolicyForPublication(definition))
  assert.throws(() => validateRuntimePolicyForPublication({ ...definition, rules: [{ ...definition.rules[0]!, actions: ["expose"] }] } as never), /RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED/)
  assert.throws(() => validateRuntimePolicyForPublication({ ...definition, rules: [{ ...definition.rules[0]!, constraints: [{ kind: "path_allowlist", parameters: { paths: ["/workspace"] } }] }] } as never), /RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED/)
  assert.throws(() => validateRuntimePolicyForPublication({ ...definition, rules: [definition.rules[0]!, { ...definition.rules[0]!, rule_id: "allow-hands-cloud", constraints: [{ kind: "execution_placement", parameters: { execution_domain: "MANAGED_CLOUD" } }] }] } as never), /POLICY_PLACEMENT_CONFLICT/)
  assert.throws(() => validateRuntimePolicyForPublication({ ...definition, rules: [{ ...definition.rules[0]!, constraints: [{ kind: "execution_placement", parameters: { execution_domain: "UNKNOWN" } }] }] } as never), /POLICY_PLACEMENT_INVALID/)
})

test("independently published placement policies fail closed when their domains conflict", () => {
  const revision = (policyId: string, domain: "ON_PREM" | "MANAGED_CLOUD") => ({
    tenant_id: tenantId,
    policy_id: policyId,
    revision: 1,
    provenance: "TENANT_AUTHORED" as const,
    enabled: true,
    ...placementDefinition(domain).definition,
    display_name: policyId,
    published_by_subject_id: "person-admin",
    created_at: 1,
    published_at: 1,
  })
  const result = evaluateRuntimePolicies([revision("on-prem", "ON_PREM"), revision("managed", "MANAGED_CLOUD")], {
    tenant_id: tenantId,
    subject_id: "person-uat-dylan",
    client_id: "genio-one-bot",
    role: "USER",
    organization_ids: [],
    bot_id: "managed-genio-bot",
    runtime_id: "codex",
    capability_id: "remote_hands.use",
    action: "use",
    evaluated_at: 1,
  })
  assert.equal(result.decision, "DENY")
  assert.equal(result.reason_code, "POLICY_PLACEMENT_CONFLICT")
})

test("JavaScript execution can publish and resolve independently of shell execution", { timeout: 30_000 }, async () => {
  const { modules } = platformModulesWithBotConnection()
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: principals() })
  const policyPath = `/v1/tenants/${tenantId}/one-policy/runtime-policies/javascript-execution`
  try {
    const content = {
      kind: "RUNTIME_CAPABILITY",
      definition: {
        display_name: "JavaScript execution",
        scope: { subject_ids: ["person-uat-dylan"], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] },
        rules: [{ rule_id: "allow-javascript", target: { runtime_id: "codex", capability_id: "code.javascript" }, actions: ["execute"], effect: "ALLOW", constraints: [], obligations: [] }],
      },
    }
    const saved = await app.inject({ method: "PUT", url: `${policyPath}/draft`, headers: adminHeaders, payload: { expected_version: 0, base_revision: 0, content } })
    assert.equal(saved.statusCode, 200, saved.body)
    const reviewed = await reviewRuntimeDraft(app, `${policyPath}/draft`, saved.json())
    const published = await app.inject({ method: "POST", url: `${policyPath}/draft/publish`, headers: adminHeaders, payload: { expected_version: reviewed.version, expected_content_digest: reviewed.content_digest } })
    assert.equal(published.statusCode, 200, published.body)
    const effective = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/one-policy/runtime-effective?bot_id=managed-genio-bot&runtime_id=codex&capability_id=code.javascript&action=execute`, headers: { authorization: "Bearer dylan" } })
    assert.equal(effective.statusCode, 200, effective.body)
    assert.equal(effective.json().decision, "ALLOW")
    const shell = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/one-policy/runtime-effective?bot_id=managed-genio-bot&runtime_id=codex&capability_id=shell.exec&action=execute`, headers: { authorization: "Bearer dylan" } })
    assert.equal(shell.statusCode, 200, shell.body)
    assert.equal(shell.json().decision, "DENY")
  } finally {
    await app.close()
  }
})

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

test("runtime authorization rejects mismatched report signers before recording an authorization", async () => {
  const { modules } = platformModulesWithBotConnection("ENABLED", { runtimeReportKeyId: "runtime-policy-test", runtimeReportPublicKeyPem })
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: principals() })
  const wrongKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const body = (correlationId: string) => ({ tenant_id: tenantId, operation: "AUTHORIZE" as const, correlation_id: correlationId, bot_id: "managed-genio-bot", runtime_id: "codex", capability_id: "codex.subscription", action: "use" as const })
  const signature = (payload: Record<string, unknown>) => signRuntimeReport(payload, runtimeReportPrivateKeyPem)
  const keyHeader = { [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test" }
  const cases = [
    { payload: body("missing-key-id"), headers: { [RUNTIME_REPORT_SIGNATURE_HEADER]: signature(body("missing-key-id")) }, code: "RUNTIME_REPORT_ATTESTATION_REQUIRED" },
    { payload: body("missing-signature"), headers: keyHeader, code: "RUNTIME_REPORT_ATTESTATION_REQUIRED" },
    { payload: body("missing-headers"), headers: {}, code: "RUNTIME_REPORT_ATTESTATION_REQUIRED" },
    { payload: body("wrong-key-id"), headers: { [RUNTIME_REPORT_KEY_ID_HEADER]: "other-key", [RUNTIME_REPORT_SIGNATURE_HEADER]: signature(body("wrong-key-id")) }, code: "RUNTIME_REPORT_ATTESTATION_INVALID" },
    { payload: body("wrong-key-pair"), headers: { ...keyHeader, [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(body("wrong-key-pair"), wrongKey) }, code: "RUNTIME_REPORT_ATTESTATION_INVALID" },
    { payload: { ...body("tampered-body"), bot_id: "other-bot" }, headers: { ...keyHeader, [RUNTIME_REPORT_SIGNATURE_HEADER]: signature(body("tampered-body")) }, code: "RUNTIME_REPORT_ATTESTATION_INVALID" },
    { payload: { ...body("wrong-tenant"), tenant_id: "other-tenant" }, headers: { ...keyHeader, [RUNTIME_REPORT_SIGNATURE_HEADER]: signature({ ...body("wrong-tenant"), tenant_id: "other-tenant" }) }, code: "RUNTIME_REPORT_TENANT_CONFLICT" },
    { payload: { ...body("missing-operation"), operation: undefined }, headers: { ...keyHeader, [RUNTIME_REPORT_SIGNATURE_HEADER]: signature(body("missing-operation")) }, code: "RUNTIME_REPORT_ATTESTATION_REQUIRED" },
    { payload: { correlation_id: "missing-marker", bot_id: "managed-genio-bot", runtime_id: "codex", capability_id: "codex.subscription", action: "use" }, headers: { ...keyHeader, [RUNTIME_REPORT_SIGNATURE_HEADER]: signature(body("missing-marker")) }, code: "RUNTIME_REPORT_ATTESTATION_REQUIRED" },
  ]
  try {
    for (const item of cases) {
      const result = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-authorize`, headers: { authorization: "Bearer dylan", ...item.headers }, payload: item.payload })
      assert.equal(result.statusCode, 403, `${item.payload.correlation_id}: ${result.body}`)
      assert.equal(result.json().code, item.code)
      assert.equal(await modules.auditEvents.findRuntimeAuthorization({ tenantId, correlationId: item.payload.correlation_id }), null)
    }
  } finally {
    await app.close()
  }
})

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

    const authorizeBody = { correlation_id: "corr-runtime-1", bot_id: "managed-genio-bot", runtime_id: "codex", capability_id: "codex.subscription", action: "use" as const }
    const attestedAuthorizeBody = { tenant_id: tenantId, operation: "AUTHORIZE" as const, ...authorizeBody }
    const authorizeHeaders = { authorization: "Bearer dylan", [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test", [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(attestedAuthorizeBody, runtimeReportPrivateKeyPem) }
    const authorized = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-authorize`, headers: authorizeHeaders, payload: attestedAuthorizeBody })
    assert.equal(authorized.statusCode, 200, authorized.body)
    assert.equal(authorized.json().decision, "ALLOW")
    const retry = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-authorize`, headers: authorizeHeaders, payload: attestedAuthorizeBody })
    assert.equal(retry.statusCode, 200, retry.body)
    assert.deepEqual(retry.json(), authorized.json())

    const reportBody = { tenant_id: tenantId, ...authorizeBody, outcome: "COMPLETED" as const }
    await assert.rejects(modules.botAccessPolicy.reportRuntime({
      ...reportBody,
      tenantId,
      principal: { tenant_id: "another-tenant", subject_id: "person-uat-dylan", client_id: "genio-one-bot", role: "USER", organization_ids: [] },
      reportAttestation: { keyId: "runtime-policy-test", signature: signRuntimeReport(reportBody, runtimeReportPrivateKeyPem) },
    }), { code: "RUNTIME_REPORT_TENANT_CONFLICT", statusCode: 403 })
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

    const tokenlessAuthorization = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-authorize`, headers: { authorization: "Bearer dylan" }, payload: { ...authorizeBody, correlation_id: "corr-runtime-tokenless" } })
    assert.equal(tokenlessAuthorization.statusCode, 200, tokenlessAuthorization.body)
    const tokenlessBody = { ...reportBody, correlation_id: "corr-runtime-tokenless" }
    const tokenlessReport = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: {
      [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test",
      [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(tokenlessBody, runtimeReportPrivateKeyPem),
    }, payload: tokenlessBody })
    assert.equal(tokenlessReport.statusCode, 201, tokenlessReport.body)
    assert.equal(tokenlessReport.json().subject.subject_id, authorized.json().subject_id)
    assert.equal(tokenlessReport.json().acting_client.acting_client_id, authorized.json().client_id)

    const replay = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: {
      [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test",
      [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(reportBody, runtimeReportPrivateKeyPem),
    }, payload: reportBody })
    assert.equal(replay.statusCode, 201, replay.body)
    assert.deepEqual(replay.json(), report.json())

    const invalidBearer = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: {
      authorization: "Bearer invalid",
      [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test",
      [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(reportBody, runtimeReportPrivateKeyPem),
    }, payload: reportBody })
    assert.equal(invalidBearer.statusCode, 401)

    const tampered = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: {
      [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test",
      [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(reportBody, runtimeReportPrivateKeyPem),
    }, payload: { ...reportBody, outcome: "FAILED" } })
    assert.equal(tampered.statusCode, 403)

    const unknownKey = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: {
      [RUNTIME_REPORT_KEY_ID_HEADER]: "different-key",
      [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(reportBody, runtimeReportPrivateKeyPem),
    }, payload: reportBody })
    assert.equal(unknownKey.statusCode, 403)

    const mismatchedActionBody = { ...reportBody, action: "invoke" }
    const mismatchedAction = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: {
      [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test",
      [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(mismatchedActionBody, runtimeReportPrivateKeyPem),
    }, payload: mismatchedActionBody })
    assert.equal(mismatchedAction.statusCode, 409)

    const otherTenantPrincipal = { tenant_id: "another-tenant", subject_id: "person-uat-dylan", client_id: "genio-one-bot", role: "USER" as const, organization_ids: [] }
    const otherTenantAuthorization = await modules.botAccessPolicy.authorizeRuntime({ ...authorizeBody, principal: otherTenantPrincipal })
    assert.equal(otherTenantAuthorization.correlation_id, authorizeBody.correlation_id)
    const wrongTenant = await app.inject({ method: "POST", url: "/v1/tenants/another-tenant/one-policy/runtime-report", headers: {
      [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test",
      [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(reportBody, runtimeReportPrivateKeyPem),
    }, payload: reportBody })
    assert.equal(wrongTenant.statusCode, 403)
    assert.equal(wrongTenant.json().code, "RUNTIME_REPORT_TENANT_CONFLICT")
    assert.equal(await modules.auditEvents.findRuntimeReport({ tenantId: "another-tenant", correlationId: authorizeBody.correlation_id }), null)

    const tamperedTenant = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: {
      [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test",
      [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(reportBody, runtimeReportPrivateKeyPem),
    }, payload: { ...reportBody, tenant_id: "another-tenant" } })
    assert.equal(tamperedTenant.statusCode, 403)
    assert.equal(tamperedTenant.json().code, "RUNTIME_REPORT_ATTESTATION_INVALID")

    const signedOtherTenantBody = { ...reportBody, tenant_id: "another-tenant" }
    const signedOtherTenant = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: {
      [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test",
      [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(signedOtherTenantBody, runtimeReportPrivateKeyPem),
    }, payload: signedOtherTenantBody })
    assert.equal(signedOtherTenant.statusCode, 403)
    assert.equal(signedOtherTenant.json().code, "RUNTIME_REPORT_TENANT_CONFLICT")

    const unsignedTenantBody = { ...authorizeBody, outcome: "COMPLETED" as const }
    const missingTenant = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: {
      [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test",
      [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(unsignedTenantBody, runtimeReportPrivateKeyPem),
    }, payload: unsignedTenantBody })
    assert.equal(missingTenant.statusCode, 400)
    assert.equal(missingTenant.json().code, "REQUEST_VALIDATION_FAILED")

    const changedReasonBody = { ...reportBody, reason_code: "DIFFERENT_RESULT" }
    const changedReason = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: {
      [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test",
      [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(changedReasonBody, runtimeReportPrivateKeyPem),
    }, payload: changedReasonBody })
    assert.equal(changedReason.statusCode, 409)

    const noBearerOtherRoute = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-authorize`, headers: {
      [RUNTIME_REPORT_KEY_ID_HEADER]: "runtime-policy-test",
      [RUNTIME_REPORT_SIGNATURE_HEADER]: signRuntimeReport(authorizeBody, runtimeReportPrivateKeyPem),
    }, payload: authorizeBody })
    assert.equal(noBearerOtherRoute.statusCode, 401)

    const spoofed = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: reportHeaders, payload: { ...reportBody, policy_revision: 999, constraints: [{ kind: "unknown", parameters: {} }] } })
    assert.equal(spoofed.statusCode, 201)
    assert.equal(spoofed.json().policy_revision, 1)
    assert.deepEqual(spoofed.json().constraints, [])

    const missingAttestation = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, headers: { authorization: "Bearer dylan" }, payload: reportBody })
    assert.equal(missingAttestation.statusCode, 403)

    const missingBearerAndAttestation = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/one-policy/runtime-report`, payload: reportBody })
    assert.equal(missingBearerAndAttestation.statusCode, 401)

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
    assert.deepEqual((runtimeOnly.json() as Array<{ audit_event_id: string }>).map((event) => event.audit_event_id).sort(), [
      "corr-runtime-1:authorize",
      "corr-runtime-1:authorize:report",
      "corr-runtime-tokenless:authorize",
      "corr-runtime-tokenless:authorize:report",
    ])
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

    const reportBody = { tenant_id: tenantId, ...invocation, outcome: "COMPLETED" as const }
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
