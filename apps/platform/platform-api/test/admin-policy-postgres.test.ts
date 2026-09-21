import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"
import { createPolicyDraftStore, defaultBotRules } from "../src/capabilities/one-policy/drafts"
import { createPostgresOnePolicySeedStore } from "../src/capabilities/one-policy/postgres"
import { createPostgresGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/postgres"
import type { GatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/module"

test("PostgreSQL drafts reload as objects and publish immutable attributed revisions", { skip: process.env.GENIO_ONE_ADMIN_POLICY_PERSISTENCE_TEST !== "1" }, async () => {
  const url = process.env.GENIO_ONE_DATABASE_URL
  assert.ok(url)
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  const schema = `policyqa_${crypto.randomUUID().replaceAll("-", "")}`
  const setup = createPostgresSqlAdapter({ url })
  await setup.query(`create schema ${schema}`)
  const sql = createPostgresSqlAdapter({ url, options: { max: 1, connection: { search_path: schema } } })
  try {
    await sql.query(await readFile(new URL("../migrations/001_platform_baseline.sql", import.meta.url), "utf8"))
    const policies = createPostgresOnePolicySeedStore({ sql })
    const initial = await policies.getOrCreate({ tenantId: "qa" })
    const store = createPolicyDraftStore(sql)
    assert.equal(await store.get("qa", initial.policy_id), null)
    await store.save("qa", initial.policy_id, { expected_version: 0, base_revision: 1, content: { kind: "BOT_ACCESS", definition: defaultBotRules } })
    const draft = await createPolicyDraftStore(sql).get("qa", initial.policy_id)
    assert.equal(typeof draft, "object")
    assert.equal(draft?.version, 1)
    await assert.rejects(store.save("qa", initial.policy_id, { expected_version: 0, base_revision: 1, content: { kind: "BOT_ACCESS", definition: defaultBotRules } }))
    await policies.publish({ tenantId: "qa", baseRevision: 1, rules: { allowed_roles: [], allowed_subject_ids: [], computer_use_enabled: true }, publishedBy: "qa-admin" })
    const reloaded = await createPostgresOnePolicySeedStore({ sql }).getOrCreate({ tenantId: "qa" })
    assert.equal(reloaded.policy_revision, 2)
    assert.deepEqual(reloaded.rules, { allowed_roles: [], allowed_subject_ids: [], computer_use_enabled: true })
    assert.equal((await policies.revisions("qa"))[0]?.published_by, "qa-admin")
    await assert.rejects(policies.publish({ tenantId: "qa", baseRevision: 1, rules: defaultBotRules, publishedBy: "stale" }))
    assert.equal((await policies.revisions("qa")).length, 2)
    assert.equal(await store.remove("qa", initial.policy_id, 1), true)
    assert.equal(await store.get("qa", initial.policy_id), null)
    const next = await store.save("qa", initial.policy_id, { expected_version: 0, base_revision: 2, content: { kind: "BOT_ACCESS", definition: defaultBotRules } })
    const validated = await store.validate("qa", initial.policy_id, { expectedVersion: next.version, expectedContentDigest: next.content_digest })
    const reviewed = await store.review("qa", initial.policy_id, { expectedVersion: validated.version, expectedContentDigest: validated.content_digest })
    await sql.query(`create function reject_draft_clear() returns trigger language plpgsql as $$ begin if NEW.value = 'null'::jsonb then raise exception 'SIMULATED_REMOVE_FAILURE'; end if; return NEW; end; $$`)
    await sql.query(`create trigger reject_draft_clear before update on genio_one_policy_drafts for each row execute function reject_draft_clear()`)
    await assert.rejects(policies.publishDraft({ tenantId: "qa", expectedVersion: reviewed.version, expectedContentDigest: reviewed.content_digest, publishedBy: "admin" }), /SIMULATED_REMOVE_FAILURE/)
    assert.equal((await policies.getOrCreate({ tenantId: "qa" })).policy_revision, 2)
    assert.equal((await store.get("qa", initial.policy_id))?.version, reviewed.version)
    await sql.query("drop trigger reject_draft_clear on genio_one_policy_drafts")
    await policies.publishDraft({ tenantId: "qa", expectedVersion: reviewed.version, expectedContentDigest: reviewed.content_digest, publishedBy: "admin" })
    assert.equal((await policies.getOrCreate({ tenantId: "qa" })).policy_revision, 3)
    assert.equal(await store.get("qa", initial.policy_id), null)

    assert.deepEqual(await store.list("qa"), [])
    const successor = await store.save("qa", initial.policy_id, { expected_version: 0, base_revision: 2, content: { kind: "BOT_ACCESS", definition: defaultBotRules } })
    assert.equal(successor.version, 3)
    assert.equal(await store.remove("qa", initial.policy_id, 1), false)
    await assert.rejects(store.save("qa", initial.policy_id, { expected_version: 1, base_revision: 2, content: successor.content }))

    await sql.query("insert into genio_one_policy_authoring_settings (tenant_id, require_distinct_reviewer) values ($1, true)", ["qa"])
    const configuredSettings = await store.getAuthoringSettings("qa")
    assert.equal(configuredSettings.revision, 1)
    assert.equal(configuredSettings.require_distinct_reviewer, true)
    const updatedSettings = await store.saveAuthoringSettings("qa", {
      expected_revision: configuredSettings.revision,
      require_distinct_reviewer: true,
    }, {
      actorSubjectId: "settings-admin",
      correlationId: "settings-update",
      at: 1_234,
    })
    assert.deepEqual(updatedSettings, {
      tenant_id: "qa",
      revision: 2,
      require_distinct_reviewer: true,
      updated_at: 1_234,
    })
    const guarded = await store.save("qa", "distinct-review", { expected_version: 0, base_revision: 0, content: { kind: "BOT_ACCESS", definition: defaultBotRules } }, { actorSubjectId: "author", correlationId: "save" })
    const guardedValidated = await store.validate("qa", "distinct-review", { expectedVersion: guarded.version, expectedContentDigest: guarded.content_digest, context: { actorSubjectId: "validator", correlationId: "validate" } })
    await assert.rejects(store.review("qa", "distinct-review", { expectedVersion: guardedValidated.version, expectedContentDigest: guardedValidated.content_digest, context: { actorSubjectId: "author", correlationId: "review" } }), { code: "POLICY_DISTINCT_REVIEWER_REQUIRED" })
    const guardedReviewed = await store.review("qa", "distinct-review", { expectedVersion: guardedValidated.version, expectedContentDigest: guardedValidated.content_digest, context: { actorSubjectId: "validator", correlationId: "review-2" } })
    assert.equal(guardedReviewed.lifecycle, "REVIEWED")
  } finally {
    await sql.end({ timeout: 1 })
    await setup.query(`drop schema ${schema} cascade`)
    await setup.end({ timeout: 1 })
  }
})

test("PostgreSQL draft mutations roll back both state and inserted audits on an audit failure", { skip: process.env.GENIO_ONE_ADMIN_POLICY_PERSISTENCE_TEST !== "1" }, async () => {
  const url = process.env.GENIO_ONE_DATABASE_URL
  assert.ok(url)
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  const schema = `policyaudit_${crypto.randomUUID().replaceAll("-", "")}`
  const setup = createPostgresSqlAdapter({ url })
  await setup.query(`create schema ${schema}`)
  const sql = createPostgresSqlAdapter({ url, options: { max: 1, connection: { search_path: schema } } })
  try {
    await sql.query(await readFile(new URL("../migrations/001_platform_baseline.sql", import.meta.url), "utf8"))
    const durableAudit = createPostgresGatewayAuthorizationAuditStore({ sql })
    const failingAudit: GatewayAuthorizationAuditStore = {
      record: durableAudit.record,
      async recordInTransaction(input) {
        await durableAudit.recordInTransaction!(input)
        throw new Error("SIMULATED_AUDIT_FAILURE")
      },
      query: durableAudit.query,
      findRuntimeAuthorization: durableAudit.findRuntimeAuthorization,
      findRuntimeReport: durableAudit.findRuntimeReport,
    }
    const baseline = createPolicyDraftStore(sql)
    const drafts = createPolicyDraftStore({ sql, audit: failingAudit })
    const value = {
      expected_version: 0,
      base_revision: 0,
      content: { kind: "BOT_ACCESS" as const, definition: defaultBotRules },
    }

    await assert.rejects(drafts.save("qa", "save", value, {
      actorSubjectId: "author",
      correlationId: "save",
    }), /SIMULATED_AUDIT_FAILURE/)
    assert.equal(await baseline.get("qa", "save"), null)

    const validating = await baseline.save("qa", "validate", value, {
      actorSubjectId: "author",
      correlationId: "validate-save",
    })
    await assert.rejects(drafts.validate("qa", "validate", {
      expectedVersion: validating.version,
      expectedContentDigest: validating.content_digest,
      context: { actorSubjectId: "validator", correlationId: "validate" },
    }), /SIMULATED_AUDIT_FAILURE/)
    assert.equal((await baseline.get("qa", "validate"))?.lifecycle, "DRAFT")

    const reviewing = await baseline.save("qa", "review", value, {
      actorSubjectId: "author",
      correlationId: "review-save",
    })
    const reviewedValidation = await baseline.validate("qa", "review", {
      expectedVersion: reviewing.version,
      expectedContentDigest: reviewing.content_digest,
      context: { actorSubjectId: "validator", correlationId: "review-validate" },
    })
    await assert.rejects(drafts.review("qa", "review", {
      expectedVersion: reviewedValidation.version,
      expectedContentDigest: reviewedValidation.content_digest,
      context: { actorSubjectId: "reviewer", correlationId: "review" },
    }), /SIMULATED_AUDIT_FAILURE/)
    assert.equal((await baseline.get("qa", "review"))?.lifecycle, "VALIDATED")

    const discarding = await baseline.save("qa", "discard", value, {
      actorSubjectId: "author",
      correlationId: "discard-save",
    })
    await assert.rejects(drafts.remove("qa", "discard", discarding.version, {
      actorSubjectId: "author",
      correlationId: "discard",
    }), /SIMULATED_AUDIT_FAILURE/)
    assert.equal((await baseline.get("qa", "discard"))?.version, discarding.version)
    assert.equal((await durableAudit.query({ tenantId: "qa", kind: "POLICY_CHANGE", offset: 0, limit: 10 })).events.length, 0)
  } finally {
    await sql.end({ timeout: 1 })
    await setup.query(`drop schema ${schema} cascade`)
    await setup.end({ timeout: 1 })
  }
})

test("PostgreSQL first-party policy toggles atomically append attributed audits and revisions", { skip: process.env.GENIO_ONE_ADMIN_POLICY_PERSISTENCE_TEST !== "1" }, async () => {
  const url = process.env.GENIO_ONE_DATABASE_URL
  assert.ok(url)
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  const schema = `policytoggleqa_${crypto.randomUUID().replaceAll("-", "")}`
  const setup = createPostgresSqlAdapter({ url })
  await setup.query(`create schema ${schema}`)
  const sql = createPostgresSqlAdapter({ url, options: { max: 3, connection: { search_path: schema } } })
  try {
    await sql.query(await readFile(new URL("../migrations/001_platform_baseline.sql", import.meta.url), "utf8"))
    const durableAudit = createPostgresGatewayAuthorizationAuditStore({ sql })
    const policies = createPostgresOnePolicySeedStore({ sql, now: () => 1_757_000_000, audit: durableAudit })
    const initial = await policies.getOrCreate({ tenantId: "toggle-qa" })
    assert.equal(initial.policy_revision, 1)
    const disabled = await policies.setEnabled({
      tenantId: "toggle-qa",
      enabled: false,
      publishedBy: "toggle-admin",
      correlationId: "toggle-disable",
    })
    assert.equal(disabled.policy_revision, 2)
    assert.equal(disabled.enabled, false)
    const disableAudit = await durableAudit.query({ tenantId: "toggle-qa", correlationId: "toggle-disable", offset: 0, limit: 10 })
    assert.deepEqual(disableAudit.events.map((event) => event.kind === "POLICY_CHANGE" ? {
      policy_key: event.policy_key,
      action: event.action,
      enabled: event.enabled,
      subject_id: event.subject.subject_id,
      actor_subject_id: event.actor_subject.subject_id,
      base_revision: event.base_revision,
      published_revision: event.published_revision,
    } : null), [{
      policy_key: "one-policy.first-party.bot-default",
      action: "DISABLED",
      enabled: false,
      subject_id: "toggle-admin",
      actor_subject_id: "toggle-admin",
      base_revision: 1,
      published_revision: 2,
    }])

    const concurrent = await Promise.allSettled([
      policies.setEnabled({ tenantId: "toggle-qa", enabled: true, publishedBy: "toggle-admin", correlationId: "toggle-enable" }),
      policies.setEnabled({ tenantId: "toggle-qa", enabled: false, publishedBy: "toggle-admin", correlationId: "toggle-disable-again" }),
    ])
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 2)
    const beforeRollback = await policies.getOrCreate({ tenantId: "toggle-qa" })
    assert.equal(beforeRollback.policy_revision, 4)
    assert.equal((await policies.revisions("toggle-qa")).length, 4)

    const failingAudit: GatewayAuthorizationAuditStore = {
      record: durableAudit.record,
      async recordInTransaction(input) {
        await durableAudit.recordInTransaction!(input)
        throw new Error("SIMULATED_TOGGLE_AUDIT_FAILURE")
      },
      query: durableAudit.query,
      findRuntimeAuthorization: durableAudit.findRuntimeAuthorization,
      findRuntimeReport: durableAudit.findRuntimeReport,
    }
    const failingPolicies = createPostgresOnePolicySeedStore({ sql, now: () => 1_757_000_000, audit: failingAudit })
    await assert.rejects(failingPolicies.setEnabled({
      tenantId: "toggle-qa",
      enabled: !beforeRollback.enabled,
      publishedBy: "toggle-admin",
      correlationId: "toggle-rollback",
    }), /SIMULATED_TOGGLE_AUDIT_FAILURE/)
    const afterRollback = await policies.getOrCreate({ tenantId: "toggle-qa" })
    assert.equal(afterRollback.policy_revision, beforeRollback.policy_revision)
    assert.equal(afterRollback.enabled, beforeRollback.enabled)
    assert.equal((await policies.revisions("toggle-qa")).length, 4)
    const rollbackAudit = await durableAudit.query({ tenantId: "toggle-qa", correlationId: "toggle-rollback", offset: 0, limit: 10 })
    assert.equal(rollbackAudit.events.length, 0)
  } finally {
    await sql.end({ timeout: 1 })
    await setup.query(`drop schema ${schema} cascade`)
    await setup.end({ timeout: 1 })
  }
})
