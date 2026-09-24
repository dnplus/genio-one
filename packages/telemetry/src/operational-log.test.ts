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
