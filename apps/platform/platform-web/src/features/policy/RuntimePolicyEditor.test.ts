import { expect, test } from "bun:test"
import type { RuntimePolicyDefinition } from "@/lib/product-api"
import { finalRuntimePolicyDefinition } from "./RuntimePolicyEditor"

test("policy editor keeps placement and other constraints for explicit validation", () => {
  const definition: RuntimePolicyDefinition = {
    display_name: "Hands placement",
    scope: { subject_ids: [], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] },
    rules: [{
      rule_id: "hands",
      target: { runtime_id: "codex", capability_id: "remote_hands.use" },
      actions: ["use"],
      effect: "ALLOW",
      constraints: [
        { kind: "execution_placement", parameters: { execution_domain: "MANAGED_CLOUD" } },
        { kind: "path_allowlist", parameters: { paths: ["/workspace"] } },
      ],
      obligations: [{ kind: "audit", parameters: {} }],
    }],
  }
  const finalized = finalRuntimePolicyDefinition(definition)
  expect(finalized.rules[0]?.constraints).toEqual(definition.rules[0]?.constraints)
  expect(finalized.rules[0]?.constraints).not.toBe(definition.rules[0]?.constraints)
})
