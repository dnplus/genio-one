import { expect, test } from "bun:test"
import { emitBotInvocationFailure } from "./telemetry"

test("invocation failure exports correlation and reports collector rejection without failing the caller", async () => {
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  let body: any
  const warnings: string[] = []
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body))
    return new Response("", { status: 503 })
  }) as typeof fetch
  console.warn = (line) => { warnings.push(String(line)) }
  try {
    await emitBotInvocationFailure({ invocation_id: "test-invocation", target_bot_id: "test-bot", thread_id: "test-thread", phase: "thread", native_code: -32600, reason: "ACTIVE_WRITER" })
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0]
    expect(record.severityText).toBe("ERROR")
    expect(record.attributes).toContainEqual({ key: "thread_id", value: { stringValue: "test-thread" } })
    expect(record.attributes).toContainEqual({ key: "reason", value: { stringValue: "ACTIVE_WRITER" } })
    expect(warnings.map((line) => JSON.parse(line).event)).toEqual(["bot.telemetry.export_failed"])
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn }
})
