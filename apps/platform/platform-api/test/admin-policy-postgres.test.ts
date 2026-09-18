import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"
import { createPolicyDraftStore, defaultBotRules } from "../src/capabilities/one-policy/drafts"
import { createPostgresOnePolicySeedStore } from "../src/capabilities/one-policy/postgres"

test("PostgreSQL drafts reload as objects and publish immutable attributed revisions", { skip: process.env.GENIO_ONE_ADMIN_POLICY_PERSISTENCE_TEST !== "1" }, async () => {
  const url = process.env.GENIO_ONE_DATABASE_URL
  assert.ok(url)
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  const schema = `policyqa_${crypto.randomUUID().replaceAll("-", "")}`
  const setup = createPostgresSqlAdapter({ url })
  await setup.query(`create schema ${schema}`)
  const sql = createPostgresSqlAdapter({ url, options: { max: 1, connection: { search_path: schema } } })
  try {
    for (const filename of ["084_first_party_policy_seeds.sql", "085_policy_authoring_drafts.sql", "087_bot_policy_revision_history.sql", "088_policy_authoring_revision_constraints.sql", "090_policy_draft_monotonic_versions.sql"]) {
      await sql.query(await readFile(new URL(`../migrations/${filename}`, import.meta.url), "utf8"))
    }
    const policies = createPostgresOnePolicySeedStore({ sql })
    const initial = await policies.getOrCreate({ tenantId: "qa" })
    const store = createPolicyDraftStore(sql)
    await store.save("qa", initial.policy_id, { expected_version: 0, base_revision: 1, content: { kind: "BOT_ACCESS", definition: defaultBotRules } })
    const draft = await createPolicyDraftStore(sql).get("qa", initial.policy_id)
    assert.equal(typeof draft, "object")
    assert.equal(draft?.version, 1)
    await assert.rejects(store.save("qa", initial.policy_id, { expected_version: 0, base_revision: 1, content: { kind: "BOT_ACCESS", definition: defaultBotRules } }))
    await policies.publish({ tenantId: "qa", baseRevision: 1, rules: { allowed_roles: [], allowed_subject_ids: [] }, publishedBy: "qa-admin" })
    const reloaded = await createPostgresOnePolicySeedStore({ sql }).getOrCreate({ tenantId: "qa" })
    assert.equal(reloaded.policy_revision, 2)
    assert.deepEqual(reloaded.rules, { allowed_roles: [], allowed_subject_ids: [] })
    assert.equal((await policies.revisions("qa"))[0]?.published_by, "qa-admin")
    await assert.rejects(policies.publish({ tenantId: "qa", baseRevision: 1, rules: defaultBotRules, publishedBy: "stale" }))
    assert.equal((await policies.revisions("qa")).length, 2)
    assert.equal(await store.remove("qa", initial.policy_id, 1), true)
    assert.equal(await store.get("qa", initial.policy_id), null)
    const next = await store.save("qa", initial.policy_id, { expected_version: 0, base_revision: 2, content: { kind: "BOT_ACCESS", definition: defaultBotRules } })
    await sql.query(`create function reject_draft_clear() returns trigger language plpgsql as $$ begin if NEW.value = 'null'::jsonb then raise exception 'SIMULATED_REMOVE_FAILURE'; end if; return NEW; end; $$`)
    await sql.query(`create trigger reject_draft_clear before update on genio_one_policy_drafts for each row execute function reject_draft_clear()`)
    await assert.rejects(policies.publishDraft({ tenantId: "qa", expectedVersion: next.version, publishedBy: "admin" }), /SIMULATED_REMOVE_FAILURE/)
    assert.equal((await policies.getOrCreate({ tenantId: "qa" })).policy_revision, 2)
    assert.equal((await store.get("qa", initial.policy_id))?.version, next.version)
    await sql.query("drop trigger reject_draft_clear on genio_one_policy_drafts")
    await policies.publishDraft({ tenantId: "qa", expectedVersion: next.version, publishedBy: "admin" })
    assert.equal((await policies.getOrCreate({ tenantId: "qa" })).policy_revision, 3)
    assert.equal(await store.get("qa", initial.policy_id), null)

    assert.deepEqual(await store.list("qa"), [])
    const successor = await store.save("qa", initial.policy_id, { expected_version: 0, base_revision: 2, content: { kind: "BOT_ACCESS", definition: defaultBotRules } })
    assert.equal(successor.version, 3)
    assert.equal(await store.remove("qa", initial.policy_id, 1), false)
    await assert.rejects(store.save("qa", initial.policy_id, { expected_version: 1, base_revision: 2, content: successor.content }))
  } finally {
    await sql.end({ timeout: 1 })
    await setup.query(`drop schema ${schema} cascade`)
    await setup.end({ timeout: 1 })
  }
})
