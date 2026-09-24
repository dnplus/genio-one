import assert from "node:assert/strict"
import test from "node:test"

import { assertDevStopped, cleanPlan, confirmationPhrase, devServicePorts } from "./local-dev-clean.mjs"

test("local clean requires an explicit confirmation phrase", () => {
  assert.equal(confirmationPhrase, "CLEAN LOCAL GENIO DATA")
})

test("local clean preserves the login foundation", () => {
  assert.ok(cleanPlan.some((item) => item.includes("Identity")))
  assert.ok(cleanPlan.some((item) => item.includes("Keycloak realm")))
  assert.ok(cleanPlan.some((item) => item.includes("bot-registry.sqlite")))
  assert.ok(cleanPlan.some((item) => item.includes("first-party Bot seed")))
})

test("local clean refuses to run while the distillation triage service is listening", () => {
  assert.ok(devServicePorts.includes(8182))
  assert.throws(() => assertDevStopped({
    findRunningPids(port) {
      return port === 8182 ? ["48291"] : []
    },
  }), /8182\/48291/)
})
