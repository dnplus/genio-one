import assert from "node:assert/strict"
import test from "node:test"
import { createPolicyDraftStore, defaultBotRules } from "../src/capabilities/one-policy/drafts"
import { createDefaultOnePolicy, POLICY_ID } from "../src/capabilities/one-policy/default"

test("First-party draft is consumed once with its revision, preserving conflicting drafts", async () => {
  const drafts = createPolicyDraftStore()
  const policy = createDefaultOnePolicy({ drafts })
  await policy.getFirstPartyBotSeed({ tenantId: "qa" })
  const draft = await drafts.save("qa", POLICY_ID, { expected_version: 0, base_revision: 1, content: { kind: "BOT_ACCESS", definition: { ...defaultBotRules, allowed_subject_ids: ["dylan"] } } })
  const validated = await drafts.validate("qa", POLICY_ID, { expectedVersion: draft.version, expectedContentDigest: draft.content_digest })
  const reviewed = await drafts.review("qa", POLICY_ID, { expectedVersion: validated.version, expectedContentDigest: validated.content_digest })
  const input = { tenantId: "qa", expectedVersion: reviewed.version, expectedContentDigest: reviewed.content_digest, publishedBy: "admin" }
  const results = await Promise.allSettled([policy.publishFirstPartyBotPolicyDraft(input), policy.publishFirstPartyBotPolicyDraft(input)])
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
  assert.equal(await drafts.get("qa", POLICY_ID), null)
  assert.equal((await policy.getFirstPartyBotSeed({ tenantId: "qa" })).policy_revision, 2)
  const stale = await drafts.save("qa", POLICY_ID, { expected_version: 0, base_revision: 1, content: { kind: "BOT_ACCESS", definition: defaultBotRules } })
  const staleValidated = await drafts.validate("qa", POLICY_ID, { expectedVersion: stale.version, expectedContentDigest: stale.content_digest })
  const staleReviewed = await drafts.review("qa", POLICY_ID, { expectedVersion: staleValidated.version, expectedContentDigest: staleValidated.content_digest })
  await assert.rejects(policy.publishFirstPartyBotPolicyDraft({ ...input, expectedVersion: staleReviewed.version, expectedContentDigest: staleReviewed.content_digest }), { code: "POLICY_REVISION_CONFLICT" })
  assert.equal((await drafts.get("qa", POLICY_ID))?.version, stale.version)
  assert.equal((await policy.getFirstPartyBotSeed({ tenantId: "qa" })).policy_revision, 2)
})
