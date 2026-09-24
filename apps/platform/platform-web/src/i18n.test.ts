import assert from "node:assert/strict"
import test from "node:test"

import i18n from "@/i18n"

test("audit export success copy states included provenance without claiming integrity verification", () => {
  const key = "Includes Policy Version {{policy}} and Decision Correlation ID {{correlation}}."
  const options = { policy: "one-policy@7", correlation: "decision-correlation-1" }

  assert.equal(
    i18n.t(key, { ...options, lng: "en" }),
    "Includes Policy Version one-policy@7 and Decision Correlation ID decision-correlation-1.",
  )
  assert.equal(
    i18n.t(key, { ...options, lng: "zh-TW" }),
    "包含政策版本 one-policy@7 與決策關聯 ID decision-correlation-1。",
  )
})
