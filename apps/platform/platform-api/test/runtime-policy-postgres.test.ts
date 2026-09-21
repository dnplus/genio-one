import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { createPostgresGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/postgres"
import { createPostgresRuntimePolicyStore } from "../src/capabilities/one-policy/runtime-postgres"
import type { RuntimePolicyDefinition } from "../src/capabilities/one-policy/runtime"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"

test("PostgreSQL runtime policy revisions are durable and immutable", { skip: process.env.GENIO_ONE_RUNTIME_POLICY_PERSISTENCE_TEST !== "1" }, async () => {
  const url = process.env.GENIO_ONE_DATABASE_URL
  assert.ok(url)
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  const schema = `runtimepolicyqa_${randomUUID().replaceAll("-", "")}`
  const setup = createPostgresSqlAdapter({ url })
  await setup.query(`create schema ${schema}`)
  const sql = createPostgresSqlAdapter({ url, options: { max: 2, connection: { search_path: schema } } })
  try {
    await sql.query(await readFile(new URL("../migrations/001_platform_baseline.sql", import.meta.url), "utf8"))
    const audit = createPostgresGatewayAuthorizationAuditStore({ sql })
    const store = createPostgresRuntimePolicyStore({ sql, now: () => 1_757_000_000, audit })
    const initial = await store.ensureDefault({ tenantId: "tenant-qa" })
    assert.equal(initial.revision, 1)
    const definition: RuntimePolicyDefinition = {
      display_name: "QA runtime access",
      scope: { subject_ids: ["person-qa"], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] },
      rules: [{
        rule_id: "allow-codex",
        target: { runtime_id: "codex", capability_id: "codex.subscription" },
        actions: ["use"],
        effect: "ALLOW",
        constraints: [],
        obligations: [],
      }],
    }
    const published = await store.publish({ tenantId: "tenant-qa", policyId: "one-policy.runtime.capabilities", baseRevision: 1, definition, publishedBy: "person-admin" })
    assert.equal(published.revision, 2)
    const reloaded = await createPostgresRuntimePolicyStore({ sql }).getLatest({ tenantId: "tenant-qa", policyId: "one-policy.runtime.capabilities" })
    assert.deepEqual(reloaded, published)
    const disabled = await store.setEnabled({ tenantId: "tenant-qa", policyId: "one-policy.runtime.capabilities", expectedRevision: 2, enabled: false, publishedBy: "person-admin", correlationId: "runtime-disable" })
    assert.equal(disabled.revision, 3)
    assert.equal(disabled.enabled, false)
    assert.deepEqual((await store.list("tenant-qa")).map((revision) => revision.revision), [3, 2, 1])
    const disableAudit = await audit.query({ tenantId: "tenant-qa", correlationId: "runtime-disable", offset: 0, limit: 10 })
    assert.deepEqual(disableAudit.events.map((event) => event.kind === "POLICY_CHANGE" ? {
      policy_key: event.policy_key,
      action: event.action,
      enabled: event.enabled,
      subject_id: event.subject.subject_id,
      actor_subject_id: event.actor_subject.subject_id,
      base_revision: event.base_revision,
      published_revision: event.published_revision,
    } : null), [{
      policy_key: "runtime-capability:one-policy.runtime.capabilities",
      action: "DISABLED",
      enabled: false,
      subject_id: "person-admin",
      actor_subject_id: "person-admin",
      base_revision: 2,
      published_revision: 3,
    }])
    const concurrent = await Promise.allSettled([
      store.publish({ tenantId: "tenant-qa", policyId: "one-policy.runtime.capabilities", baseRevision: 3, definition, publishedBy: "person-admin" }),
      store.setEnabled({ tenantId: "tenant-qa", policyId: "one-policy.runtime.capabilities", expectedRevision: 3, enabled: true, publishedBy: "person-admin", correlationId: "runtime-enable-concurrent" }),
    ])
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1)
    const conflict = concurrent.find((result) => result.status === "rejected") as PromiseRejectedResult
    assert.equal(conflict.reason.code, "POLICY_REVISION_CONFLICT")
    assert.equal((await store.getLatest({ tenantId: "tenant-qa", policyId: "one-policy.runtime.capabilities" }))?.revision, 4)
  } finally {
    await sql.end({ timeout: 1 })
    await setup.query(`drop schema ${schema} cascade`)
    await setup.end({ timeout: 1 })
  }
})

test("PostgreSQL runtime draft publication rolls back cleanup failures and serializes concurrent editors", { skip: process.env.GENIO_ONE_RUNTIME_POLICY_PERSISTENCE_TEST !== "1" }, async () => {
  const { createPolicyDraftStore, runtimePolicyDraftKey } = await import("../src/capabilities/one-policy/drafts")
  const url = process.env.GENIO_ONE_DATABASE_URL
  assert.ok(url)
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  const schema = `runtimedraftqa_${randomUUID().replaceAll("-", "")}`
  const setup = createPostgresSqlAdapter({ url })
  await setup.query(`create schema ${schema}`)
  const sql = createPostgresSqlAdapter({ url, options: { max: 3, connection: { search_path: schema } } })
  try {
    await sql.query(await readFile(new URL("../migrations/001_platform_baseline.sql", import.meta.url), "utf8"))
    const drafts = createPolicyDraftStore(sql)
    const store = createPostgresRuntimePolicyStore({ sql })
    const tenantId = "tenant-draft-qa"
    const policyId = "policy-draft-qa"
    const key = runtimePolicyDraftKey(policyId)
    const definition: RuntimePolicyDefinition = {
      display_name: "Draft QA",
      scope: { subject_ids: [], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] },
      rules: [],
    }
    const draft = await drafts.save(tenantId, key, { expected_version: 0, base_revision: 0, content: { kind: "RUNTIME_CAPABILITY", definition } })
    const validated = await drafts.validate(tenantId, key, { expectedVersion: draft.version, expectedContentDigest: draft.content_digest })
    const reviewed = await drafts.review(tenantId, key, { expectedVersion: validated.version, expectedContentDigest: validated.content_digest })
    const request = { tenantId, policyId, expectedVersion: reviewed.version, expectedContentDigest: reviewed.content_digest, publishedBy: "admin-qa" }
    await sql.query("create function reject_cleanup() returns trigger language plpgsql as $$ begin if new.value = 'null'::jsonb then raise exception 'SIMULATED_REMOVE_FAILURE'; end if; return new; end $$")
    await sql.query("create trigger reject_cleanup before update on genio_one_policy_drafts for each row execute function reject_cleanup()")
    await assert.rejects(store.publishDraft(request), /SIMULATED_REMOVE_FAILURE/)
    assert.equal(await store.getLatest({ tenantId, policyId }), null)
    assert.deepEqual(await drafts.get(tenantId, key), reviewed)
    await sql.query("create or replace function reject_cleanup() returns trigger language plpgsql as $$ begin if new.value = 'null'::jsonb then return null; end if; return new; end $$")
    await assert.rejects(store.publishDraft(request), { code: "POLICY_DRAFT_CONFLICT" })
    assert.equal(await store.getLatest({ tenantId, policyId }), null)
    assert.deepEqual(await drafts.get(tenantId, key), reviewed)
    await sql.query("drop trigger reject_cleanup on genio_one_policy_drafts")
    const concurrent = await Promise.allSettled([
      store.publishDraft(request),
      drafts.save(tenantId, key, { expected_version: reviewed.version, base_revision: 0, content: { kind: "RUNTIME_CAPABILITY", definition: { ...definition, display_name: "Concurrent edit" } } }),
    ])
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1)
    const remaining = await drafts.get(tenantId, key)
    if (remaining) {
      assert.equal(await store.getLatest({ tenantId, policyId }), null)
      assert.equal(remaining.version, 2)
      const nextValidated = await drafts.validate(tenantId, key, { expectedVersion: remaining.version, expectedContentDigest: remaining.content_digest })
      const nextReviewed = await drafts.review(tenantId, key, { expectedVersion: nextValidated.version, expectedContentDigest: nextValidated.content_digest })
      await store.publishDraft({ ...request, expectedVersion: nextReviewed.version, expectedContentDigest: nextReviewed.content_digest })
    }
    assert.equal(await drafts.get(tenantId, key), null)
    assert.equal((await store.list(tenantId)).length, 1)
    await assert.rejects(store.publishDraft(request), { code: "POLICY_DRAFT_CONFLICT" })
    assert.equal((await store.list(tenantId)).length, 1)
  } finally {
    await sql.end({ timeout: 1 })
    await setup.query(`drop schema ${schema} cascade`)
    await setup.end({ timeout: 1 })
  }
})

test("PostgreSQL runtime policy toggles roll back both the revision and inserted audit when audit recording throws", { skip: process.env.GENIO_ONE_RUNTIME_POLICY_PERSISTENCE_TEST !== "1" }, async () => {
  const url = process.env.GENIO_ONE_DATABASE_URL
  assert.ok(url)
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  const schema = `runtimepolicytoggleqa_${randomUUID().replaceAll("-", "")}`
  const setup = createPostgresSqlAdapter({ url })
  await setup.query(`create schema ${schema}`)
  const sql = createPostgresSqlAdapter({ url, options: { max: 2, connection: { search_path: schema } } })
  try {
    await sql.query(await readFile(new URL("../migrations/001_platform_baseline.sql", import.meta.url), "utf8"))
    const durableAudit = createPostgresGatewayAuthorizationAuditStore({ sql })
    const durableStore = createPostgresRuntimePolicyStore({ sql, now: () => 1_757_000_000, audit: durableAudit })
    const published = await durableStore.publish({
      tenantId: "tenant-runtime-toggle",
      policyId: "runtime-toggle",
      baseRevision: 0,
      definition: {
        display_name: "Runtime toggle",
        scope: { subject_ids: [], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] },
        rules: [],
      },
      publishedBy: "runtime-admin",
      correlationId: "runtime-toggle-publish",
    })
    const failingAudit = {
      ...durableAudit,
      async recordInTransaction(input: Parameters<NonNullable<typeof durableAudit.recordInTransaction>>[0]) {
        await durableAudit.recordInTransaction!(input)
        throw new Error("SIMULATED_RUNTIME_TOGGLE_AUDIT_FAILURE")
      },
    }
    const failingStore = createPostgresRuntimePolicyStore({ sql, now: () => 1_757_000_000, audit: failingAudit })
    await assert.rejects(failingStore.setEnabled({
      tenantId: "tenant-runtime-toggle",
      policyId: "runtime-toggle",
      expectedRevision: published.revision,
      enabled: false,
      publishedBy: "runtime-admin",
      correlationId: "runtime-toggle-rollback",
    }), /SIMULATED_RUNTIME_TOGGLE_AUDIT_FAILURE/)
    const reloaded = await durableStore.getLatest({ tenantId: "tenant-runtime-toggle", policyId: "runtime-toggle" })
    assert.equal(reloaded?.revision, published.revision)
    assert.equal(reloaded?.enabled, true)
    const rollbackAudit = await durableAudit.query({ tenantId: "tenant-runtime-toggle", correlationId: "runtime-toggle-rollback", offset: 0, limit: 10 })
    assert.equal(rollbackAudit.events.length, 0)
  } finally {
    await sql.end({ timeout: 1 })
    await setup.query(`drop schema ${schema} cascade`)
    await setup.end({ timeout: 1 })
  }
})
