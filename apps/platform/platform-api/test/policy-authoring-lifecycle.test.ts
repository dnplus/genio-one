import assert from "node:assert/strict"
import test from "node:test"

import { createPolicyDraftStore, defaultBotRules, policyDraftFromStoredValue, requireBotPolicyDraft } from "../src/capabilities/one-policy/drafts"
import { createInMemoryGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/memory"
import type { GatewayAuthorizationAuditIngest } from "../src/capabilities/audit-events/contract"
import type { GatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/module"
import { createDefaultOnePolicy, POLICY_ID } from "../src/capabilities/one-policy/default"
import { createInMemoryRuntimePolicyStore } from "../src/capabilities/one-policy/runtime-memory"
import { runtimePolicyDraftKey, resourcePolicyKey } from "../src/capabilities/one-policy/drafts"
import type { EnforcementChainCompiler } from "../src/capabilities/enforcement/module"
import { createInMemoryEnforcementChainReader } from "../src/capabilities/enforcement/memory"

test("draft lifecycle persists validation and review evidence, resets after save, and enforces a distinct reviewer when configured", async () => {
  let at = 1_000
  const drafts = createPolicyDraftStore({
    now: () => at++,
    requireDistinctReviewer: true,
  })
  const saved = await drafts.save("tenant", "bot", {
    expected_version: 0,
    base_revision: 1,
    content: { kind: "BOT_ACCESS", definition: defaultBotRules },
  }, { actorSubjectId: "author", correlationId: "save-1" })
  assert.equal(saved.lifecycle, "DRAFT")
  assert.equal(saved.created_by_subject_id, "author")
  assert.equal(saved.validation, null)
  const validated = await drafts.validate("tenant", "bot", {
    expectedVersion: saved.version,
    expectedContentDigest: saved.content_digest,
    context: { actorSubjectId: "validator", correlationId: "validate-1" },
  })
  assert.equal(validated.lifecycle, "VALIDATED")
  assert.equal(validated.validation?.correlation_id, "validate-1")
  await assert.rejects(drafts.review("tenant", "bot", {
    expectedVersion: validated.version,
    expectedContentDigest: validated.content_digest,
    context: { actorSubjectId: "author", correlationId: "review-1" },
  }), { code: "POLICY_DISTINCT_REVIEWER_REQUIRED" })
  const reviewed = await drafts.review("tenant", "bot", {
    expectedVersion: validated.version,
    expectedContentDigest: validated.content_digest,
    context: { actorSubjectId: "validator", correlationId: "review-2" },
  })
  assert.equal(reviewed.lifecycle, "REVIEWED")
  assert.equal(reviewed.review?.actor_subject_id, "validator")
  assert.deepEqual(requireBotPolicyDraft(reviewed, reviewed.version, reviewed.content_digest).rules, defaultBotRules)
  const changed = await drafts.save("tenant", "bot", {
    expected_version: reviewed.version,
    base_revision: 1,
    content: { kind: "BOT_ACCESS", definition: { allowed_roles: [], allowed_subject_ids: ["person"] } },
  }, { actorSubjectId: "author", correlationId: "save-2" })
  assert.equal(changed.lifecycle, "DRAFT")
  assert.equal(changed.validation, null)
  assert.equal(changed.review, null)
  assert.notEqual(changed.content_digest, reviewed.content_digest)
  await assert.rejects(
    Promise.resolve().then(() => requireBotPolicyDraft(changed, changed.version, changed.content_digest)),
    { code: "POLICY_DRAFT_NOT_REVIEWED" },
  )
})

test("draft persistence rejects legacy and malformed lifecycle values", () => {
  assert.throws(() => policyDraftFromStoredValue({
    policy_key: "bot",
    version: 1,
    base_revision: 0,
    content: { kind: "BOT_ACCESS", definition: defaultBotRules },
    updated_at: 1,
  }), { code: "POLICY_DRAFT_DATA_INVALID" })
  assert.throws(() => policyDraftFromStoredValue("not-json"), { code: "POLICY_DRAFT_DATA_INVALID" })
})

test("draft mutations commit only with their audit event and transition retries do not duplicate it", async () => {
  const persisted = createInMemoryGatewayAuthorizationAuditStore()
  let rejectWrites = true
  const audit: GatewayAuthorizationAuditStore = {
    async record(input) {
      if (rejectWrites) throw new Error("AUDIT_WRITE_FAILED")
      return persisted.record(input)
    },
    query: persisted.query,
    findRuntimeAuthorization: persisted.findRuntimeAuthorization,
    findRuntimeReport: persisted.findRuntimeReport,
  }
  const drafts = createPolicyDraftStore({ audit, now: () => 1_000 })
  const value = {
    expected_version: 0,
    base_revision: 0,
    content: { kind: "BOT_ACCESS" as const, definition: defaultBotRules },
  }
  await assert.rejects(drafts.save("tenant", "bot", value, {
    actorSubjectId: "author",
    correlationId: "save-failed",
  }), /AUDIT_WRITE_FAILED/)
  assert.equal(await drafts.get("tenant", "bot"), null)

  rejectWrites = false
  const saved = await drafts.save("tenant", "bot", value, {
    actorSubjectId: "author",
    correlationId: "save",
  })

  rejectWrites = true
  await assert.rejects(drafts.validate("tenant", "bot", {
    expectedVersion: saved.version,
    expectedContentDigest: saved.content_digest,
    context: { actorSubjectId: "validator", correlationId: "validate-failed" },
  }), /AUDIT_WRITE_FAILED/)
  assert.equal((await drafts.get("tenant", "bot"))?.lifecycle, "DRAFT")

  rejectWrites = false
  const validated = await drafts.validate("tenant", "bot", {
    expectedVersion: saved.version,
    expectedContentDigest: saved.content_digest,
    context: { actorSubjectId: "validator", correlationId: "validate" },
  })
  await drafts.validate("tenant", "bot", {
    expectedVersion: validated.version,
    expectedContentDigest: validated.content_digest,
    context: { actorSubjectId: "validator", correlationId: "validate-retry" },
  })

  rejectWrites = true
  await assert.rejects(drafts.review("tenant", "bot", {
    expectedVersion: validated.version,
    expectedContentDigest: validated.content_digest,
    context: { actorSubjectId: "reviewer", correlationId: "review-failed" },
  }), /AUDIT_WRITE_FAILED/)
  assert.equal((await drafts.get("tenant", "bot"))?.lifecycle, "VALIDATED")

  rejectWrites = false
  const reviewed = await drafts.review("tenant", "bot", {
    expectedVersion: validated.version,
    expectedContentDigest: validated.content_digest,
    context: { actorSubjectId: "reviewer", correlationId: "review" },
  })
  await drafts.review("tenant", "bot", {
    expectedVersion: reviewed.version,
    expectedContentDigest: reviewed.content_digest,
    context: { actorSubjectId: "reviewer", correlationId: "review-retry" },
  })

  rejectWrites = true
  await assert.rejects(drafts.remove("tenant", "bot", reviewed.version, {
    actorSubjectId: "author",
    correlationId: "discard-failed",
  }), /AUDIT_WRITE_FAILED/)
  assert.equal((await drafts.get("tenant", "bot"))?.version, reviewed.version)

  rejectWrites = false
  assert.equal(await drafts.remove("tenant", "bot", reviewed.version, {
    actorSubjectId: "author",
    correlationId: "discard",
  }), true)
  const events = await persisted.query({ tenantId: "tenant", kind: "POLICY_CHANGE", offset: 0, limit: 10 })
  assert.deepEqual(events.events.map((event: any) => event.action).sort(), ["DISCARDED", "DRAFT_SAVED", "REVIEWED", "VALIDATED"])
})

test("draft consumption serializes against a concurrent stale save", async () => {
  const drafts = createPolicyDraftStore()
  const saved = await drafts.save("tenant", "bot", {
    expected_version: 0,
    base_revision: 0,
    content: { kind: "BOT_ACCESS", definition: defaultBotRules },
  })
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const startedPublishing = new Promise<void>((resolve) => { started = resolve })
  const consuming = drafts.consumeAsync("tenant", "bot", saved.version, async () => {
    started!()
    await new Promise<void>((resolve) => { release = resolve })
    return "published"
  })
  await startedPublishing
  const staleSave = drafts.save("tenant", "bot", {
    expected_version: saved.version,
    base_revision: 0,
    content: { kind: "BOT_ACCESS", definition: { allowed_roles: [], allowed_subject_ids: ["new"] } },
  })
  release!()
  assert.equal(await consuming, "published")
  await assert.rejects(staleSave, { code: "POLICY_DRAFT_CONFLICT" })
  assert.equal(await drafts.get("tenant", "bot"), null)
})

test("authorization audit retries are idempotent and conflicting payloads cannot overwrite the first event", async () => {
  const audit = createInMemoryGatewayAuthorizationAuditStore()
  const event: GatewayAuthorizationAuditIngest = {
    audit_event_id: "audit-immutable",
    correlation_id: "audit-correlation",
    kind: "ONE_POLICY_DECISION" as const,
    outcome: "ALLOW" as const,
    subject: { subject_id: "person", evidence_level: "VERIFIED" as const },
    target_subject_id: null,
    actor_subject: null,
    acting_client: { acting_client_id: "client", evidence_level: "VERIFIED" as const },
    resource_id: "resource",
    capability_id: "invoke",
    device_id: null,
    endpoint_version: null,
    desired_state_revision: null,
    applied_state_revision: null,
    applied_policy_version: "policy-1",
    policy_proposal_id: null,
    proposed_policy_version: null,
    access_group_id: null,
    destination_host: null,
    routing_policy_rule_id: null,
    route: "MANAGED" as const,
    missing_deployment_capability: null,
    decision: {
      decision_id: "decision-1",
      correlation_id: "audit-correlation",
      policy_version: "policy-1",
      winning_rule_id: null,
      reason: "ALLOW",
      visibility: "VISIBLE" as const,
      access: "ENTITLED" as const,
      route: "MANAGED" as const,
      obligations: [],
      entitlement_conditions: {
        required_verified_acting_client_id: null,
        requires_device: false,
      },
      entitlement_id: null,
      auto_grant_valid_for: null,
      input_receipt: {
        requested_model_id: null,
        effective_model_id: null,
      },
    },
    access_request_id: null,
    entitlement_id: null,
    enforcement_point_id: "AI_GATEWAY" as const,
    obligation_kind: null,
    runaway_trigger: null,
    upstream_attempted: false,
    occurred_at: 1_000,
  }
  const first = await audit.record({ tenantId: "tenant", event })
  const retry = await audit.record({ tenantId: "tenant", event })
  assert.deepEqual(retry, first)
  await assert.rejects(audit.record({
    tenantId: "tenant",
    event: { ...event, outcome: "DENY" },
  }), { code: "AUDIT_EVENT_CONFLICT" })
  const query = await audit.query({ tenantId: "tenant", offset: 0, limit: 10 })
  assert.equal(query.events.length, 1)
  assert.equal(query.events[0]?.outcome, "ALLOW")
})

test("audit failure rolls back every in-memory draft publication", async () => {
  const failingAudit: GatewayAuthorizationAuditStore = {
    async record() { throw new Error("AUDIT_WRITE_FAILED") },
    async query() { return { events: [], hasMore: false, sourceRevision: 0 } },
    async findRuntimeAuthorization() { return null },
    async findRuntimeReport() { return null },
  }
  const botDrafts = createPolicyDraftStore()
  const bot = createDefaultOnePolicy({ drafts: botDrafts, policyAuditSink: failingAudit })
  await bot.getFirstPartyBotSeed({ tenantId: "tenant" })
  const botDraft = await botDrafts.save("tenant", POLICY_ID, { expected_version: 0, base_revision: 1, content: { kind: "BOT_ACCESS", definition: defaultBotRules } })
  const botValidated = await botDrafts.validate("tenant", POLICY_ID, { expectedVersion: botDraft.version, expectedContentDigest: botDraft.content_digest })
  const botReviewed = await botDrafts.review("tenant", POLICY_ID, { expectedVersion: botValidated.version, expectedContentDigest: botValidated.content_digest })
  await assert.rejects(bot.publishFirstPartyBotPolicyDraft({ tenantId: "tenant", expectedVersion: botReviewed.version, expectedContentDigest: botReviewed.content_digest, publishedBy: "admin", correlationId: "bot-publish" }), /AUDIT_WRITE_FAILED/)
  assert.equal((await bot.getFirstPartyBotSeed({ tenantId: "tenant" })).policy_revision, 1)
  assert.deepEqual(await botDrafts.get("tenant", POLICY_ID), botReviewed)

  const runtimeDrafts = createPolicyDraftStore()
  const runtime = createInMemoryRuntimePolicyStore({ drafts: runtimeDrafts, audit: failingAudit })
  const runtimeKey = runtimePolicyDraftKey("runtime")
  const runtimeDefinition = { display_name: "Runtime", scope: { subject_ids: [], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] }, rules: [] }
  const runtimeDraft = await runtimeDrafts.save("tenant", runtimeKey, { expected_version: 0, base_revision: 0, content: { kind: "RUNTIME_CAPABILITY", definition: runtimeDefinition } })
  const runtimeValidated = await runtimeDrafts.validate("tenant", runtimeKey, { expectedVersion: runtimeDraft.version, expectedContentDigest: runtimeDraft.content_digest })
  const runtimeReviewed = await runtimeDrafts.review("tenant", runtimeKey, { expectedVersion: runtimeValidated.version, expectedContentDigest: runtimeValidated.content_digest })
  await assert.rejects(runtime.publishDraft({ tenantId: "tenant", policyId: "runtime", expectedVersion: runtimeReviewed.version, expectedContentDigest: runtimeReviewed.content_digest, publishedBy: "admin", correlationId: "runtime-publish" }), /AUDIT_WRITE_FAILED/)
  assert.equal((await runtime.getLatest({ tenantId: "tenant", policyId: "runtime" })), null)
  assert.deepEqual(await runtimeDrafts.get("tenant", runtimeKey), runtimeReviewed)

  const resourceDrafts = createPolicyDraftStore()
  const compiler: EnforcementChainCompiler = {
    async listEligibleConnectionIds() { return ["connection"] },
    async compile({ tenantId, value }) {
      return {
        chain_id: "chain",
        tenant_id: tenantId,
        resource_id: value.resource_id,
        capability_id: value.capability_id,
        eligible_connection_ids: value.eligible_connection_ids,
        one_policy_revision: value.one_policy_revision,
        steps: value.steps,
        request_filter_order: ["authorize"],
        response_filter_order: [],
      }
    },
  }
  const resource = createInMemoryEnforcementChainReader({ drafts: resourceDrafts, compiler, audit: failingAudit })
  const resourceKey = resourcePolicyKey("resource", "invoke")
  const resourceDefinition = {
    one_policy_revision: 1,
    eligible_connection_ids: ["connection"],
    steps: [
      { step_id: "authenticate", kind: "AUTHENTICATE" as const, phase: "REQUEST" as const, implementation: "NATIVE" as const, config: { schema_version: "genio.one.auth.jwt.v1" as const, provider: "keycloak", issuer: "https://identity.example.test", audiences: ["genio-one"], remote_jwks_uri: "https://identity.example.test/jwks", subject_claim: "sub", client_claim: "azp" } },
      { step_id: "authorize", kind: "AUTHORIZE" as const, phase: "REQUEST" as const, implementation: "EXT_AUTH" as const, depends_on: ["authenticate"] },
      { step_id: "route", kind: "ROUTE" as const, phase: "ROUTING" as const, implementation: "AIGW_NATIVE" as const, depends_on: ["authorize"] },
    ],
  }
  const resourceDraft = await resourceDrafts.save("tenant", resourceKey, { expected_version: 0, base_revision: 0, content: { kind: "RESOURCE_CAPABILITY", definition: resourceDefinition } })
  const resourceValidated = await resourceDrafts.validate("tenant", resourceKey, { expectedVersion: resourceDraft.version, expectedContentDigest: resourceDraft.content_digest })
  const resourceReviewed = await resourceDrafts.review("tenant", resourceKey, { expectedVersion: resourceValidated.version, expectedContentDigest: resourceValidated.content_digest })
  await assert.rejects(resource.publishDraft({ tenantId: "tenant", resourceId: "resource", capabilityId: "invoke", expectedVersion: resourceReviewed.version, expectedContentDigest: resourceReviewed.content_digest, publishedBySubjectId: "admin", correlationId: "resource-publish" }), /AUDIT_WRITE_FAILED/)
  assert.equal(await resource.getLatest({ tenantId: "tenant", resourceId: "resource", capabilityId: "invoke" }), null)
  assert.deepEqual(await resourceDrafts.get("tenant", resourceKey), resourceReviewed)
})
