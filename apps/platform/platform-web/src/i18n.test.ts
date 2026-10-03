import assert from "node:assert/strict"
import test from "node:test"

import i18n from "@/i18n"

test("Redirect URI copy controls and recovery feedback exist in both supported locales", () => {
  const errorKey = "Could not copy Redirect URI. Try again or select and copy it manually."

  for (const language of ["en", "zh-TW"]) {
    assert.equal(i18n.exists("Copy Redirect URI", { lng: language, fallbackLng: false }), true)
    assert.equal(i18n.exists(errorKey, { lng: language, fallbackLng: false }), true)
  }

  assert.equal(i18n.t("Copy Redirect URI", { lng: "en" }), "Copy Redirect URI")
  assert.equal(i18n.t("Copy Redirect URI", { lng: "zh-TW" }), "複製重新導向 URI")
  assert.equal(i18n.t(errorKey, { lng: "en" }), errorKey)
  assert.equal(i18n.t(errorKey, { lng: "zh-TW" }), "無法複製重新導向 URI。請重試，或選取 URI 後手動複製。")
})

test("request-rule removal names include their row and localized unnamed fallback", () => {
  const key = "Remove rule {{index}}: {{name}}"

  for (const language of ["en", "zh-TW"]) {
    assert.equal(i18n.exists(key, { lng: language, fallbackLng: false }), true)
    assert.equal(i18n.exists("unnamed", { lng: language, fallbackLng: false }), true)
  }

  assert.equal(i18n.t(key, { index: 2, name: "x-region", lng: "en" }), "Remove rule 2: x-region")
  assert.equal(i18n.t(key, { index: 2, name: "x-region", lng: "zh-TW" }), "移除第 2 列規則：x-region")
  assert.equal(i18n.t(key, { index: 1, name: i18n.t("unnamed", { lng: "en" }), lng: "en" }), "Remove rule 1: unnamed")
  assert.equal(i18n.t(key, { index: 1, name: i18n.t("unnamed", { lng: "zh-TW" }), lng: "zh-TW" }), "移除第 1 列規則：未命名")
})

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
