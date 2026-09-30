import { expect, test } from "bun:test"

import { isAccountMethodAllowed, SUPPORTED_CLIENT_METHODS } from "./codex"

test("allows account logout through the Codex subscription route", () => {
  expect(SUPPORTED_CLIENT_METHODS.has("account/logout")).toBe(true)
  expect(isAccountMethodAllowed("account/logout", "codex-subscription")).toBe(true)
})

test("keeps account methods unavailable to the Genio Gateway route", () => {
  for (const method of ["account/read", "account/login/start", "account/login/cancel", "account/logout"]) {
    expect(isAccountMethodAllowed(method, "genio-gateway")).toBe(false)
  }
})

test("does not broaden the account allowlist to other native account methods", () => {
  expect(SUPPORTED_CLIENT_METHODS.has("account/usage/read")).toBe(false)
  expect(isAccountMethodAllowed("account/usage/read", "codex-subscription")).toBe(false)
})
