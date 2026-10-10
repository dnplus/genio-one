import { describe, expect, test } from "bun:test"

import { operationalError, writeOperationalEvent } from "./operational-log"

describe("Gateway operational errors", () => {
  const message = `failed https://person:password@example.test/path?access_token=top-secret\nAuthorization: Bearer abc.def ${"x".repeat(3_000)}`

  // OTel receives the full, raw message (no truncation): the collector redacts once, server side.
  test("keeps the complete error for telemetry", () => {
    expect(operationalError(new Error(message))).toEqual({ error_name: "Error", error_message: message })
  })

  // stdout/stderr bypass the collector, so that line alone is redacted and log-injection safe.
  test("redacts the console line without truncating it", () => {
    const original = process.stderr.write
    let line = ""
    process.stderr.write = ((chunk: string) => { line += chunk; return true }) as typeof process.stderr.write
    try { writeOperationalEvent("processor", "ERROR", "processor.failed", operationalError(new Error(message))) } finally { process.stderr.write = original }
    const written = JSON.parse(line)
    expect(written.error_message).toBe(`failed https://[REDACTED]@example.test/path?access_token=[REDACTED] Authorization: Bearer [REDACTED] ${"x".repeat(3_000)}`)
  })
})

function captureOutput(run: () => void) {
  const stdoutWrite = process.stdout.write
  const stderrWrite = process.stderr.write
  const captured = { stdout: "", stderr: "" }
  process.stdout.write = ((chunk: string | Uint8Array) => { captured.stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(); return true }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => { captured.stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(); return true }) as typeof process.stderr.write
  try { run() } finally {
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
  }
  return captured
}

test("operational events recursively redact string values without mutating their input", () => {
  const fields = {
    nested: {
      url: "https://fixture-user:fixture-pass@example.test/path?api_key=fixture-api&token=fixture-token&password=fixture-password&safe=visible",
      values: ["Bearer fixture-bearer", { url: "http://other-fixture@example.test/?ACCESS_TOKEN=fixture-access&secret=fixture-secret&key=fixture-key" }],
    },
    count: 7, success: false, absent: null, numbers: [1, 2.5],
  }
  const before = structuredClone(fields)
  const captured = captureOutput(() => writeOperationalEvent("gateway-runtime", "INFO", "fixture.recursive", fields))
  expect(captured.stderr).toBe("")
  expect(JSON.parse(captured.stdout)).toEqual({
    nested: {
      url: "https://[REDACTED]@example.test/path?api_key=[REDACTED]&token=[REDACTED]&password=[REDACTED]&safe=visible",
      values: ["Bearer [REDACTED]", { url: "http://[REDACTED]@example.test/?ACCESS_TOKEN=[REDACTED]&secret=[REDACTED]&key=[REDACTED]" }],
    },
    count: 7, success: false, absent: null, numbers: [1, 2.5],
    component: "gateway-runtime", event: "fixture.recursive", level: "INFO",
  })
  expect(fields).toEqual(before)
})

test("operational severity selects its sink and fields cannot overwrite event identity", () => {
  for (const level of ["INFO", "WARN", "ERROR"] as const) {
    const captured = captureOutput(() => writeOperationalEvent("authorizer", level, "fixture.identity", { component: "spoofed", event: "spoofed.event", level: "spoofed-level", count: 0 }))
    const line = level === "ERROR" ? captured.stderr : captured.stdout
    expect(level === "ERROR" ? captured.stdout : captured.stderr).toBe("")
    expect(JSON.parse(line)).toEqual({ component: "authorizer", event: "fixture.identity", level, count: 0 })
    expect(line.endsWith("\n")).toBe(true)
    expect(line.split("\n")).toHaveLength(2)
  }
})

test("nested controls cannot inject extra stdout or stderr log records", () => {
  const fields = { messages: [" \nfirst\r\nsecond\u0000\u001fthird\u007f ", { text: "\tinner\nline\t" }] }
  for (const level of ["WARN", "ERROR"] as const) {
    const captured = captureOutput(() => writeOperationalEvent("processor", level, "fixture.controls", fields))
    const line = level === "ERROR" ? captured.stderr : captured.stdout
    expect(JSON.parse(line).messages).toEqual(["first second third", { text: "inner line" }])
    expect(line.slice(0, -1)).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(line.split("\n")).toHaveLength(2)
  }
})

test("redaction removes multiple mixed-case credentials while preserving surrounding diagnostics", () => {
  const captured = captureOutput(() => writeOperationalEvent("processor", "ERROR", "fixture.credentials", {
    detail: "retry Bearer fixture-one then bEaReR fixture-two at https://fixture-login:fixture-password@example.test/path?Token=fixture-query&safe=diagnostic",
  }))
  expect(JSON.parse(captured.stderr).detail).toBe("retry Bearer [REDACTED] then Bearer [REDACTED] at https://[REDACTED]@example.test/path?Token=[REDACTED]&safe=diagnostic")
})
