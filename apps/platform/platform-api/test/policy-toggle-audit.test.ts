import assert from "node:assert/strict"
import test from "node:test"

import { createInMemoryGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/memory"
import type { PolicyChangeAuditEvent } from "../src/capabilities/audit-events/contract"
import type { GatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/module"
import { createDefaultOnePolicy, POLICY_ID } from "../src/capabilities/one-policy/default"
import { createInMemoryRuntimePolicyStore } from "../src/capabilities/one-policy/runtime-memory"
import type { RuntimePolicyDefinition } from "../src/capabilities/one-policy/runtime"

const runtimeDefinition: RuntimePolicyDefinition = {
  display_name: "Toggle audit policy",
  scope: { subject_ids: [], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] },
  rules: [],
}

test("in-memory policy toggles append attributable audit events and serialize stale runtime writes", async () => {
  const audit = createInMemoryGatewayAuthorizationAuditStore()
  const botPolicy = createDefaultOnePolicy({ policyAuditSink: audit, now: () => 1_757_000_000 })
  const botDisabled = await botPolicy.setFirstPartyBotSeedEnabled({
    tenantId: "tenant-toggle",
    enabled: false,
    publishedBy: "admin-toggle",
    correlationId: "bot-disable",
  })
  assert.equal(botDisabled.policy_revision, 2)
  assert.equal(botDisabled.enabled, false)
  const botAudit = await audit.query({ tenantId: "tenant-toggle", correlationId: "bot-disable", offset: 0, limit: 10 })
  assert.deepEqual(botAudit.events.map((event) => event.kind === "POLICY_CHANGE" ? {
    policy_key: event.policy_key,
    action: event.action,
    enabled: event.enabled,
    subject_id: event.subject.subject_id,
    actor_subject_id: event.actor_subject.subject_id,
    base_revision: event.base_revision,
    published_revision: event.published_revision,
  } : null), [{
    policy_key: POLICY_ID,
    action: "DISABLED",
    enabled: false,
    subject_id: "admin-toggle",
    actor_subject_id: "admin-toggle",
    base_revision: 1,
    published_revision: 2,
  }])

  const runtime = createInMemoryRuntimePolicyStore({ audit, now: () => 1_757_000_001 })
  const published = await runtime.publish({
    tenantId: "tenant-toggle",
    policyId: "runtime-toggle",
    baseRevision: 0,
    definition: runtimeDefinition,
    publishedBy: "admin-toggle",
    correlationId: "runtime-publish",
  })
  assert.equal(published.revision, 1)
  const toggles = await Promise.allSettled([
    runtime.setEnabled({
      tenantId: "tenant-toggle",
      policyId: "runtime-toggle",
      expectedRevision: 1,
      enabled: false,
      publishedBy: "admin-toggle",
      correlationId: "runtime-disable",
    }),
    runtime.setEnabled({
      tenantId: "tenant-toggle",
      policyId: "runtime-toggle",
      expectedRevision: 1,
      enabled: true,
      publishedBy: "admin-toggle",
      correlationId: "runtime-enable",
    }),
  ])
  assert.equal(toggles.filter((result) => result.status === "fulfilled").length, 1)
  const conflict = toggles.find((result) => result.status === "rejected") as PromiseRejectedResult
  assert.equal(conflict.reason.code, "POLICY_REVISION_CONFLICT")
  assert.equal((await runtime.getLatest({ tenantId: "tenant-toggle", policyId: "runtime-toggle" }))?.revision, 2)
  const runtimeAudit = await audit.query({ tenantId: "tenant-toggle", kind: "POLICY_CHANGE", offset: 0, limit: 20 })
  const runtimeToggles = runtimeAudit.events.filter((event): event is PolicyChangeAuditEvent => event.kind === "POLICY_CHANGE" && event.policy_key === "runtime-capability:runtime-toggle")
  assert.equal(runtimeToggles.filter((event) => event.action === "ENABLED" || event.action === "DISABLED").length, 1)
})

test("in-memory policy toggles fail closed before committing their revision when audit recording fails", async () => {
  const persisted = createInMemoryGatewayAuthorizationAuditStore()
  let rejectAudit = false
  const audit: GatewayAuthorizationAuditStore = {
    async record(input) {
      if (rejectAudit) throw new Error("AUDIT_WRITE_FAILED")
      return persisted.record(input)
    },
    query: persisted.query,
    findRuntimeAuthorization: persisted.findRuntimeAuthorization,
    findRuntimeReport: persisted.findRuntimeReport,
  }
  const botPolicy = createDefaultOnePolicy({ policyAuditSink: audit })
  const initialBotSeed = await botPolicy.getFirstPartyBotSeed({ tenantId: "tenant-toggle-failure" })
  rejectAudit = true
  await assert.rejects(botPolicy.setFirstPartyBotSeedEnabled({
    tenantId: "tenant-toggle-failure",
    enabled: false,
    publishedBy: "admin-toggle",
    correlationId: "bot-disable-failure",
  }), /AUDIT_WRITE_FAILED/)
  const botSeed = await botPolicy.getFirstPartyBotSeed({ tenantId: "tenant-toggle-failure" })
  assert.deepEqual(botSeed, initialBotSeed)

  rejectAudit = false
  const runtime = createInMemoryRuntimePolicyStore({ audit })
  const published = await runtime.publish({
    tenantId: "tenant-toggle-failure",
    policyId: "runtime-toggle-failure",
    baseRevision: 0,
    definition: runtimeDefinition,
    publishedBy: "admin-toggle",
    correlationId: "runtime-publish-failure",
  })
  rejectAudit = true
  await assert.rejects(runtime.setEnabled({
    tenantId: "tenant-toggle-failure",
    policyId: "runtime-toggle-failure",
    expectedRevision: published.revision,
    enabled: false,
    publishedBy: "admin-toggle",
    correlationId: "runtime-disable-failure",
  }), /AUDIT_WRITE_FAILED/)
  const runtimePolicy = await runtime.getLatest({ tenantId: "tenant-toggle-failure", policyId: "runtime-toggle-failure" })
  assert.equal(runtimePolicy?.revision, 1)
  assert.equal(runtimePolicy?.enabled, true)
})
