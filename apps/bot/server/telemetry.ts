export function emitBotFeedbackLog(params?: {
  classification?: string
  reason?: string
  threadId?: string
  tags?: Record<string, unknown>
}) {
  const classification = params?.classification ?? "unspecified"
  const reason = params?.reason ?? ""
  const threadId = params?.threadId ?? ""
  const tags = params?.tags ?? {}

  console.info(JSON.stringify({
    event: "codex.feedback.submitted",
    classification,
    reason,
    threadId,
    tags,
  }))

  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    process.env.GENIO_ONE_OTEL_COLLECTOR_ORIGIN?.trim() ||
    (process.env.GENIO_ONE_OTEL_HTTP_PORT ? `http://127.0.0.1:${process.env.GENIO_ONE_OTEL_HTTP_PORT}` : "http://127.0.0.1:4318")

  fetch(`${otelEndpoint}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resourceLogs: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "genio-one-bot" } },
          ],
        },
        scopeLogs: [{
          scope: { name: "genio.bot.feedback" },
          logRecords: [{
            timeUnixNano: String(Date.now() * 1_000_000),
            severityText: "INFO",
            body: { stringValue: `User feedback: ${classification}` },
            attributes: [
              { key: "feedback.classification", value: { stringValue: String(classification) } },
              { key: "feedback.reason", value: { stringValue: String(reason) } },
              { key: "feedback.thread_id", value: { stringValue: String(threadId) } },
            ],
          }],
        }],
      }],
    }),
  }).catch(() => undefined)
}

export async function emitBotInvocationFailure(event: {
  invocation_id: string
  target_bot_id: string
  thread_id?: string
  phase: "thread" | "turn"
  native_code?: number
  reason: "ACTIVE_WRITER" | "NATIVE_REQUEST_FAILED"
}) {
  const name = "bot.invocation.native_request_failed"
  console.error(JSON.stringify({ event: name, ...event }))
  const origin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || process.env.GENIO_ONE_OTEL_COLLECTOR_ORIGIN?.trim() || `http://127.0.0.1:${process.env.GENIO_ONE_OTEL_HTTP_PORT || "4318"}`
  try {
    const response = await fetch(`${origin.replace(/\/$/, "")}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(2_000),
      body: JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "genio-one-bot" } }] }, scopeLogs: [{ scope: { name: "genio.bot.invocation" }, logRecords: [{ timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), severityNumber: 17, severityText: "ERROR", body: { stringValue: name }, attributes: Object.entries(event).filter(([, value]) => value !== undefined).map(([key, value]) => ({ key, value: { stringValue: String(value) } })) }] }] }] }),
    })
    if (!response.ok) throw new Error("OTEL_EXPORT_REJECTED")
  } catch {
    console.warn(JSON.stringify({ event: "bot.telemetry.export_failed", source_event: name, invocation_id: event.invocation_id }))
  }
}
