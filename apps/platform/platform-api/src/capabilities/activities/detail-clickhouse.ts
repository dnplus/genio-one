import type { GatewayActivityHttpMessageDetail } from "./detail-contract"
import type { GatewayActivityDetailStore } from "./detail-module"
import type { HttpFetch } from "../../../../../../runtimes/gateway/services/shared/http-fetch"
import { GATEWAY_DETAIL_RETENTION_SECONDS } from "../../../../../../packages/telemetry/src/otlp-detail-capture"

interface OTelTraceRow {
  captured_at_millis: number | string
  attributes: Record<string, string>
}

function quote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
}

function attribute(attributes: Record<string, string>, ...names: string[]): string | null {
  for (const name of names) {
    const value = attributes[name]
    if (value !== undefined && value !== "" && value !== "-") return value
  }
  return null
}

function integer(value: number | string): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function parseJsonBody(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function messageBody(value: string): string | null {
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    return value
  }
  if (!Array.isArray(decoded)) return JSON.stringify(decoded, null, 2)
  const hasPayload = decoded.some((message) => {
    if (typeof message === "string") return message.length > 0
    if (!message || typeof message !== "object" || Array.isArray(message)) return false
    const record = message as Record<string, unknown>
    return ["content", "parts", "tool_calls", "toolCalls", "audio", "refusal"].some((name) => {
      const candidate = record[name]
      return typeof candidate === "string" ? candidate.length > 0 : Array.isArray(candidate) && candidate.length > 0
    })
  })
  return hasPayload ? JSON.stringify(decoded, null, 2) : null
}

function messageAttributes(
  attributes: Record<string, string>,
  direction: "input" | "output",
): Record<string, string> {
  const prefix = direction === "input" ? "llm.input_messages." : "llm.output_messages."
  const messages = new Map<number, Record<string, string>>()
  for (const [name, value] of Object.entries(attributes)) {
    if (!name.startsWith(prefix)) continue
    const match = new RegExp(`^${prefix.replaceAll(".", "\\.")}(\\d+)\\.message\\.(role|content)$`).exec(name)
    if (!match) continue
    const index = Number(match[1])
    if (!Number.isSafeInteger(index) || index < 0) continue
    const message = messages.get(index) ?? {}
    message[match[2]!] = value
    messages.set(index, message)
  }
  return Object.fromEntries([...messages.entries()].sort(([left], [right]) => left - right).map(
    ([index, message]) => [`${index}`, JSON.stringify(message)],
  ))
}

function bodyFor(
  attributes: Record<string, string>,
  direction: "request" | "response",
): { body: string; contentType: string | null; redacted: string[]; truncated: boolean } | null {
  const input = direction === "request"
  const messageValue = input
    ? attribute(attributes, "gen_ai.input.messages")
    : attribute(attributes, "gen_ai.output.messages")
  const value = messageValue ?? (input
    ? attribute(attributes, "input.value")
    : attribute(attributes, "output.value"))
  const mimeType = input
    ? attribute(attributes, "gen_ai.input.mime_type", "input.mime_type")
    : attribute(attributes, "gen_ai.output.mime_type", "output.mime_type")
  const redacted = Object.entries(attributes)
    .filter(([, current]) => current === "__REDACTED__")
    .map(([name]) => name)
  const truncated = attribute(attributes, input ? "input.truncated" : "output.truncated") === "true"
  if (value !== null) {
    const body = messageValue === null ? parseJsonBody(value) : messageBody(value)
    if (body === null) return null
    return {
      body,
      contentType: mimeType ?? "application/json",
      redacted,
      truncated,
    }
  }

  const flattened = messageAttributes(attributes, input ? "input" : "output")
  if (Object.keys(flattened).length === 0) return null
  const messages = Object.entries(flattened).map(([index, message]) => ({
    index: Number(index),
    ...(JSON.parse(message) as Record<string, string>),
  })).sort((left, right) => left.index - right.index).map(({ index: _index, ...message }) => message)
  return {
    body: JSON.stringify({ messages }, null, 2),
    contentType: "application/json",
    redacted,
    truncated,
  }
}

function message(
  body: ReturnType<typeof bodyFor>,
): GatewayActivityHttpMessageDetail | null {
  if (!body) return null
  return {
    headers: [],
    body: body.body,
    body_truncated: body.truncated,
    content_type: body.contentType,
  }
}

export function createClickHouseGatewayActivityDetailStore(options: {
  origin: string
  database: string
  username: string
  password: string
  fetch?: HttpFetch
}): GatewayActivityDetailStore {
  const request = options.fetch ?? fetch
  const origin = options.origin.replace(/\/$/, "")
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`

  return {
    async get({ tenantId, correlationId }) {
      const query = `
        select
          toUnixTimestamp64Milli(Timestamp) as captured_at_millis,
          SpanAttributes as attributes
        from ${options.database}.otel_gateway_details
        where (
          ResourceAttributes['genio.tenant.id'] = ${quote(tenantId)}
          or SpanAttributes['genio.tenant.id'] = ${quote(tenantId)}
        )
          and (
            SpanAttributes['genio.correlation.id'] = ${quote(correlationId)}
            or SpanAttributes['guid:x-request-id'] = ${quote(correlationId)}
          )
          and Timestamp >= now() - interval ${GATEWAY_DETAIL_RETENTION_SECONDS} second
        order by Timestamp asc
        limit 2000
        format JSONEachRow`
      const response = await request(`${origin}/`, {
        method: "POST",
        headers: { authorization, "content-type": "text/plain; charset=utf-8" },
        body: query,
      })
      if (!response.ok) throw new Error(`CLICKHOUSE_ACTIVITY_DETAIL_QUERY_FAILED:${response.status}`)
      const rows = (await response.text()).split("\n").filter(Boolean).map(
        (line) => JSON.parse(line) as OTelTraceRow,
      )
      if (rows.length === 0) return null

      const requestBodies = rows.map((row) => bodyFor(row.attributes, "request")).filter(
        (value): value is NonNullable<ReturnType<typeof bodyFor>> => value !== null,
      )
      const responseBodies = rows.map((row) => bodyFor(row.attributes, "response")).filter(
        (value): value is NonNullable<ReturnType<typeof bodyFor>> => value !== null,
      )
      const redactedFields = [...new Set(rows.flatMap((row) => [
        ...Object.entries(row.attributes)
          .filter(([, value]) => value === "__REDACTED__")
          .map(([name]) => name),
        ...(bodyFor(row.attributes, "request")?.redacted ?? []),
        ...(bodyFor(row.attributes, "response")?.redacted ?? []),
      ]))]
      const capturedAt = rows.map((row) => integer(row.captured_at_millis)).find(
        (value): value is number => value !== null,
      )
      const requestBody = requestBodies[0] ?? null
      const responseBody = responseBodies[0] ?? null
      return {
        correlation_id: correlationId,
        availability: requestBody || responseBody ? "AVAILABLE" : "NOT_CAPTURED",
        captured_at: capturedAt === undefined ? null : Math.floor(capturedAt / 1_000),
        expires_at: capturedAt === undefined
          ? null
          : Math.floor(capturedAt / 1_000) + GATEWAY_DETAIL_RETENTION_SECONDS,
        redacted_fields: redactedFields,
        request: message(requestBody),
        response: message(responseBody),
      }
    },
  }
}
