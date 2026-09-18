import { expect, test } from "bun:test"
import { isTemporarySessionFailure } from "./session-recovery"

test("temporary outages preserve the login while rejected credentials require authentication", () => {
  expect(isTemporarySessionFailure(new Error("PRODUCT_API_REQUEST_FAILED_502"))).toBe(true)
  expect(isTemporarySessionFailure(new TypeError("Failed to fetch"))).toBe(true)
  expect(isTemporarySessionFailure(Object.assign(new Error("unavailable"), { status: 503 }))).toBe(true)
  expect(isTemporarySessionFailure(Object.assign(new Error("rejected"), { status: 401 }))).toBe(false)
  expect(isTemporarySessionFailure(new Error("MANAGEMENT_SCOPE_REQUIRED"))).toBe(false)
})
