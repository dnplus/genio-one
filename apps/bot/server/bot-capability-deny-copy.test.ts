import { describe, expect, test } from "bun:test"

import {
  allDenialAcceptanceRows,
  assertNoProtocolLeak,
  denialCopyFor,
  humanDenialFor,
  resolveDenialKind,
  sanitizeUserFacingError,
} from "./bot-capability-deny-copy"

describe("UX P0 capability deny copy", () => {
  test("four denial kinds each have human status + CTA", () => {
    const rows = allDenialAcceptanceRows()
    expect(rows.map((r) => r.kind)).toEqual(["exposure", "entitlement", "connection", "execution"])
    for (const row of rows) {
      expect(["可用", "需連線", "需申請", "無法使用", "審批中"]).toContain(row.statusLabel)
      expect(row.message.length).toBeGreaterThan(0)
      expect(row.ctaLabel.length).toBeGreaterThan(0)
      assertNoProtocolLeak(row.statusLabel, row.message, row.ctaLabel, row.nextStep ?? "")
    }
  })

  test("Exposure deny aligns with 無法使用", () => {
    const copy = denialCopyFor("exposure")
    expect(copy.statusLabel).toBe("無法使用")
    expect(copy.ctaLabel).toBe("無法使用")
    expect(copy.ctaDisabled).toBe(true)
  })

  test("Connection deny is 需連線 with 連接 CTA", () => {
    const copy = denialCopyFor("connection")
    expect(copy.statusLabel).toBe("需連線")
    expect(copy.ctaLabel).toBe("連接")
    expect(copy.ctaDisabled).toBe(false)
  })

  test("does not leak PEP / HTTP / enum tokens", () => {
    expect(() => assertNoProtocolLeak("無法使用 · 此能力未開放")).not.toThrow()
    expect(() => assertNoProtocolLeak("runtime_expose_deny")).toThrow(/DENY_COPY_LEAKS/)
    expect(() => assertNoProtocolLeak("PEP deny")).toThrow(/DENY_COPY_LEAKS/)
    expect(() => assertNoProtocolLeak("HTTP 403")).toThrow(/DENY_COPY_LEAKS/)
    expect(() => assertNoProtocolLeak("NEEDS_CONNECTION")).toThrow(/DENY_COPY_LEAKS/)
    expect(() => assertNoProtocolLeak("DENIED")).toThrow(/DENY_COPY_LEAKS/)
  })

  test("sanitize strips protocol errors to human fallback", () => {
    expect(sanitizeUserFacingError("BOT_ACCESS_DENIED")).toContain("權限")
    expect(sanitizeUserFacingError("runtime_invoke_deny")).toContain("執行")
    expect(sanitizeUserFacingError("agent-runtime-pep expose")).toContain("開放")
    const ok = sanitizeUserFacingError("連線完成，可以繼續")
    expect(ok).toBe("連線完成，可以繼續")
  })

  test("resolveDenialKind maps phases without false positives on success", () => {
    expect(resolveDenialKind({ addState: "CONNECTED", reasonCode: "reuse_existing_connection" })).toBeNull()
    expect(resolveDenialKind({ addState: "AUTO_GRANT", reasonCode: "auto_grant_eligible" })).toBeNull()
    expect(resolveDenialKind({ addState: "NEEDS_CONNECTION" })).toBe("connection")
    expect(resolveDenialKind({ addState: "DENIED", reasonCode: "no_entitlement" })).toBe("entitlement")
    expect(resolveDenialKind({ runtimeEffective: "DENY", phase: "expose" })).toBe("exposure")
    expect(resolveDenialKind({ reasonCode: "runtime_invoke_deny", phase: "invoke" })).toBe("execution")
  })

  test("humanDenialFor request → 需申請", () => {
    const copy = humanDenialFor({ addState: "REQUEST" })
    expect(copy?.statusLabel).toBe("需申請")
    expect(copy?.ctaLabel).toBe("申請")
  })
})
