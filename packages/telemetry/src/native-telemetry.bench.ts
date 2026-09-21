import { performance } from "node:perf_hooks"

function generateTelemetryPayload(numGroups = 20, logsPerGroup = 100) {
  const resourceLogs: any[] = []
  for (let g = 0; g < numGroups; g++) {
    const scopeLogs: any[] = []
    for (let s = 0; s < 5; s++) {
      const logRecords: any[] = []
      for (let l = 0; l < logsPerGroup; l++) {
        logRecords.push({
          timeUnixNano: "1600000000000000000",
          severityText: "INFO",
          body: { stringValue: `log message ${l}` },
          attributes: [
            { key: "http.method", value: { stringValue: "GET" } },
            { key: "http.status_code", value: { intValue: "200" } },
            { key: "genio.tenant.id", value: { stringValue: "fake-tenant" } },
            { key: "genio.subject.id", value: { stringValue: "fake-subject" } },
            { key: "custom.key", value: { stringValue: "value" } },
          ],
        })
      }
      scopeLogs.push({ scope: { name: "test-logger" }, logRecords })
    }
    resourceLogs.push({
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "test-service" } },
          { key: "genio.tenant.id", value: { stringValue: "fake-tenant" } },
          { key: "genio.runtime.session.id", value: { stringValue: "fake-session" } },
        ],
      },
      scopeLogs,
    })
  }
  return { resourceLogs }
}

export function runBenchmark(removeClaimedIdentityFn: (val: any) => void, iterations = 50) {
  const payload = generateTelemetryPayload()
  const copies = Array.from({ length: iterations }, () => structuredClone(payload))

  // Warmup
  removeClaimedIdentityFn(structuredClone(payload))

  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    removeClaimedIdentityFn(copies[i])
  }
  const totalMs = performance.now() - start
  const msPerOp = totalMs / iterations
  return { totalMs, msPerOp, iterations }
}

import { removeClaimedIdentity } from "./native-telemetry"

if (import.meta.main) {
  const CLAIMED_KEYS_ARRAY = ["genio.tenant.id", "genio.subject.id", "genio.runtime.session.id"]
  const removeClaimedIdentityOriginal = (value: any): void => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value.attributes)) value.attributes = value.attributes.filter((attribute: any) => !CLAIMED_KEYS_ARRAY.includes(attribute.key))
    for (const nested of Object.values(value)) { if (Array.isArray(nested)) for (const item of nested) removeClaimedIdentityOriginal(item); else if (nested && typeof nested === "object") removeClaimedIdentityOriginal(nested) }
  }

  const baseline = runBenchmark(removeClaimedIdentityOriginal)
  const optimized = runBenchmark(removeClaimedIdentity)

  console.log(`Baseline benchmark:  ${baseline.totalMs.toFixed(2)} ms total (${baseline.msPerOp.toFixed(3)} ms/op)`)
  console.log(`Optimized benchmark: ${optimized.totalMs.toFixed(2)} ms total (${optimized.msPerOp.toFixed(3)} ms/op)`)
  console.log(`Speedup: ${(baseline.totalMs / optimized.totalMs).toFixed(2)}x faster`)
}
