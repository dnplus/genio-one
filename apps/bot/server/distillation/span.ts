import { exportOtel, otelResource, traceIdentity } from "@genioone/telemetry/otlp-observability"

export interface DistillationDecision {
  tenantId: string
  botId: string
  threadId: string
  turnId: string
  relevant: boolean
  scope: string
  sensitivity: string
  classifierVersion: string
  outcome: "unrelated" | "marker" | "unavailable"
}

export function distillationDecisionAttributes(input: DistillationDecision): Array<[string, string]> {
  return [
    ["genio.tenant.id", input.tenantId],
    ["genio.bot.id", input.botId],
    ["genio.thread.id", input.threadId],
    ["genio.turn.id", input.turnId],
    ["genio.distillation.relevant", input.relevant ? "true" : "false"],
    ["genio.distillation.scope", input.scope],
    ["genio.distillation.sensitivity", input.sensitivity],
    ["genio.distillation.classifier", input.classifierVersion],
    ["genio.distillation.outcome", input.outcome],
  ]
}

export function emitDistillationDecision(input: DistillationDecision): void {
  const identity = traceIdentity(undefined)
  const startedAt = BigInt(Date.now()) * 1_000_000n
  const attributes = distillationDecisionAttributes(input).map(([key, value]) => ({ key, value: { stringValue: value } }))
  exportOtel("traces", {
    resourceSpans: [{
      resource: otelResource("genio-one-bot", input.tenantId),
      scopeSpans: [{
        scope: { name: "genio.distillation" },
        spans: [{
          ...identity,
          name: "distillation.decision",
          kind: 1,
          startTimeUnixNano: String(startedAt),
          endTimeUnixNano: String(startedAt),
          attributes,
          status: { code: 1 },
        }],
      }],
    }],
  })
}
