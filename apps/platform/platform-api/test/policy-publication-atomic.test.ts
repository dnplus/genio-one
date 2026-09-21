import assert from "node:assert/strict"
import test from "node:test"

import { createInMemoryGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/memory"
import type { GatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/module"
import { createDefaultOnePolicy } from "../src/capabilities/one-policy/default"
import { defaultBotRules } from "../src/capabilities/one-policy/drafts"
import { createInMemoryRuntimePolicyStore } from "../src/capabilities/one-policy/runtime-memory"

const tenantId = "atomic-policy-test"
const definition = {
  display_name: "Atomic test",
  scope: { subject_ids: [], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] },
  rules: [],
}

interface PublicationScenario {
  read(): Promise<{ revision: number; author: string | null }>
  publish(author: string): Promise<unknown>
}

const scenarios: Record<string, (audit: GatewayAuthorizationAuditStore) => Promise<PublicationScenario>> = {
  async bot(audit) {
    const policy = createDefaultOnePolicy({ policyAuditSink: audit })
    await policy.getFirstPartyBotSeed({ tenantId })
    return {
      async read() {
        const seed = await policy.getFirstPartyBotSeed({ tenantId })
        const history = await policy.listFirstPartyBotPolicyRevisions(tenantId)
        return { revision: seed.policy_revision, author: history[0]?.published_by ?? null }
      },
      publish(author) {
        return policy.publishFirstPartyBotPolicy({ tenantId, baseRevision: 1, rules: defaultBotRules, publishedBy: author, correlationId: author })
      },
    }
  },
  async runtime(audit) {
    const policy = createInMemoryRuntimePolicyStore({ audit })
    await policy.publish({ tenantId, policyId: "runtime-test", baseRevision: 0, definition, publishedBy: "initial" })
    return {
      async read() {
        const current = await policy.getLatest({ tenantId, policyId: "runtime-test" })
        return { revision: current?.revision ?? 0, author: current?.published_by_subject_id ?? null }
      },
      publish(author) {
        return policy.publish({ tenantId, policyId: "runtime-test", baseRevision: 1, definition, publishedBy: author, correlationId: author })
      },
    }
  },
}

for (const [name, setup] of Object.entries(scenarios)) {
  test(`${name} memory publication remains invisible until audit succeeds and preserves the queued publisher`, async () => {
    const audit = createInMemoryGatewayAuthorizationAuditStore()
    const scenario = await setup(audit)
    const before = await scenario.read()
    const record = audit.record.bind(audit)
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let firstCall = true
    audit.record = async (input) => {
      if (firstCall) {
        firstCall = false
        entered.resolve()
        await resume.promise
      }
      return record(input)
    }

    const rejected = assert.rejects(scenario.publish("failed-author"), /AUDIT_DOWN/)
    await entered.promise
    assert.deepEqual(await scenario.read(), before)
    const successor = scenario.publish("successful-author")
    resume.reject(new Error("AUDIT_DOWN"))
    await rejected
    await successor

    assert.deepEqual(await scenario.read(), { revision: 2, author: "successful-author" })
    const events = await audit.query({ tenantId, kind: "POLICY_CHANGE", offset: 0, limit: 20 })
    assert.equal(events.events.some((event) => event.subject.subject_id === "failed-author"), false)
    assert.equal(events.events.filter((event) => event.subject.subject_id === "successful-author").length, 1)
  })
}
