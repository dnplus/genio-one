import assert from "node:assert/strict"
import test from "node:test"
import { createPolicyDraftStore, runtimePolicyDraftKey } from "../src/capabilities/one-policy/drafts"
import { createInMemoryRuntimePolicyStore } from "../src/capabilities/one-policy/runtime-memory"
import type { RuntimePolicyDefinition } from "../src/capabilities/one-policy/runtime"

const definition: RuntimePolicyDefinition = {
  display_name: "Draft publication",
  scope: { subject_ids: [], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] },
  rules: [],
}

test("runtime draft publication consumes the exact version and rejects concurrent retries", async () => {
  const drafts = createPolicyDraftStore()
  const store = createInMemoryRuntimePolicyStore({ drafts })
  const key = runtimePolicyDraftKey("policy")
  await drafts.save("tenant", key, { expected_version: 0, base_revision: 0, content: { kind: "RUNTIME_CAPABILITY", definition } })
  const request = { tenantId: "tenant", policyId: "policy", expectedVersion: 1, publishedBy: "admin" }
  const results = await Promise.allSettled([store.publishDraft(request), store.publishDraft(request)])
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal((await store.list("tenant")).length, 1)
  assert.equal(await drafts.get("tenant", key), null)
  const next = await drafts.save("tenant", key, { expected_version: 0, base_revision: 1, content: { kind: "RUNTIME_CAPABILITY", definition } })
  assert.equal(next.version, 2)
  await assert.rejects(store.publishDraft(request), { code: "POLICY_DRAFT_CONFLICT" })
  assert.deepEqual(await drafts.get("tenant", key), next)
})

test("runtime publication failure retains the draft and the previous revision", async () => {
  const drafts = createPolicyDraftStore()
  const store = createInMemoryRuntimePolicyStore({ drafts })
  const key = runtimePolicyDraftKey("policy")
  const draft = await drafts.save("tenant", key, { expected_version: 0, base_revision: 1, content: { kind: "RUNTIME_CAPABILITY", definition } })
  await assert.rejects(store.publishDraft({ tenantId: "tenant", policyId: "policy", expectedVersion: 1, publishedBy: "admin" }), { code: "POLICY_REVISION_CONFLICT" })
  assert.equal((await store.list("tenant")).length, 0)
  assert.deepEqual(await drafts.get("tenant", key), draft)
})
