import assert from "node:assert/strict"
import test from "node:test"

import { handsProviderDomain, handsProviderForDomain, isHandsExecutionPlacementTarget, readHandsExecutionPlacement } from "./hands-placement"

test("execution placement maps only the two supported Hands domains", () => {
  assert.equal(handsProviderForDomain("ON_PREM"), "e2b-self-hosted")
  assert.equal(handsProviderForDomain("MANAGED_CLOUD"), "cloudflare-hands")
  assert.equal(handsProviderDomain("e2b-self-hosted"), "ON_PREM")
  assert.equal(handsProviderDomain("cloudflare-hands"), "MANAGED_CLOUD")
  assert.equal(isHandsExecutionPlacementTarget("codex", "remote_hands.use", "use"), true)
  assert.equal(isHandsExecutionPlacementTarget("codex", "shell.exec", "execute"), false)
})

test("placement requires an exact domain and rejects unrelated or conflicting constraints", () => {
  assert.equal(readHandsExecutionPlacement([]), null)
  assert.equal(readHandsExecutionPlacement([{ kind: "execution_placement", parameters: { execution_domain: "MANAGED_CLOUD" } }]), "MANAGED_CLOUD")
  assert.throws(() => readHandsExecutionPlacement([{ kind: "execution_placement", parameters: { execution_domain: "MANAGED_CLOUD", provider: "cloudflare-hands" } }]), /POLICY_PLACEMENT_INVALID/)
  assert.throws(() => readHandsExecutionPlacement([{ kind: "execution_placement", parameters: { execution_domain: "UNKNOWN" } }]), /POLICY_PLACEMENT_INVALID/)
  assert.throws(() => readHandsExecutionPlacement([{ kind: "path_allowlist", parameters: { paths: [] } }]), /RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED/)
  assert.throws(() => readHandsExecutionPlacement([
    { kind: "execution_placement", parameters: { execution_domain: "ON_PREM" } },
    { kind: "execution_placement", parameters: { execution_domain: "MANAGED_CLOUD" } },
  ]), /POLICY_PLACEMENT_CONFLICT/)
})
