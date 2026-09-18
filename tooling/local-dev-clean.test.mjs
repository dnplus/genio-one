import assert from "node:assert/strict"
import test from "node:test"

import { cleanPlan, confirmationPhrase } from "./local-dev-clean.mjs"

test("local clean requires an explicit confirmation phrase", () => {
  assert.equal(confirmationPhrase, "CLEAN LOCAL GENIO DATA")
})

test("local clean preserves the login foundation", () => {
  assert.ok(cleanPlan.some((item) => item.includes("Identity")))
  assert.ok(cleanPlan.some((item) => item.includes("Keycloak realm")))
  assert.ok(cleanPlan.some((item) => item.includes("bot-registry.sqlite")))
  assert.ok(cleanPlan.some((item) => item.includes("first-party Bot seed")))
})
