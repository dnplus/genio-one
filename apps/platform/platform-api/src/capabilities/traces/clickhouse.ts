import type { TraceSummary, TelemetryLog } from "./contract"
import type { TraceStore } from "./module"
import type { HttpFetch } from "../../../../../../runtimes/gateway/services/shared/http-fetch"

interface TraceRow {
  trace_id: string
  span_id: string
  parent_span_id: string
  span_name: string
  service_name: string
  started_at_millis: number
  duration_nanos: number
  status_code: string
  correlation_id: string
  attributes?: Record<string, string>
  resource_attributes?: Record<string, string>
}

function quote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
}

function status(value: string): "OK" | "ERROR" | "UNSET" {
  if (value === "Ok") return "OK"
  if (value === "Error") return "ERROR"
  return "UNSET"
}


function mapSpan(row: TraceRow): TraceSummary["spans"][number] {
  return { trace_id: row.trace_id, span_id: row.span_id, parent_span_id: row.parent_span_id || null, name: row.span_name,
    service: row.service_name, started_at: Number(row.started_at_millis), duration_millis: Number(row.duration_nanos) / 1_000_000,
    status: status(row.status_code), correlation_id: row.correlation_id || null, attributes: row.attributes ?? {}, resource_attributes: row.resource_attributes ?? {} }
}

function traceStatus(spans: TraceSummary["spans"]): TraceSummary["status"] {
  if (spans.some((span) => span.status === "ERROR")) return "ERROR"
  if (spans.some((span) => span.status === "OK")) return "OK"
  return "UNSET"
}

export function createClickHouseTraceStore(options: {
  origin: string
  database: string
  username: string
  password: string
  fetch?: HttpFetch
}): TraceStore {
  const request = options.fetch ?? fetch
  const origin = options.origin.replace(/\/$/, "")
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`
  return {
    async spans({ tenantId, traceId, after, limit = 200 }) {
      const query = `select distinct TraceId as trace_id, SpanId as span_id, ParentSpanId as parent_span_id, SpanName as span_name, ServiceName as service_name,
        toUnixTimestamp64Milli(Timestamp) as started_at_millis, Duration as duration_nanos, StatusCode as status_code,
        SpanAttributes['genio.correlation.id'] as correlation_id, SpanAttributes as attributes, ResourceAttributes as resource_attributes
        from ${options.database}.otel_traces where TraceId = ${quote(traceId)}
        and (ResourceAttributes['genio.tenant.id'] = ${quote(tenantId)} or SpanAttributes['genio.tenant.id'] = ${quote(tenantId)})
        ${after ? `and SpanId > ${quote(after)}` : ""} order by SpanId limit 1 by SpanId limit ${limit + 1} settings max_block_size=128, max_threads=2 format JSONEachRow`
      const response = await request(`${origin}/`, { method: "POST", headers: { authorization, "content-type": "text/plain" }, body: query, signal: AbortSignal.timeout(30000) })
      if (!response.ok) throw new Error(`CLICKHOUSE_SPAN_QUERY_FAILED:${response.status}`)
      const rows = (await response.text()).split("\n").filter(Boolean).map(line => JSON.parse(line) as TraceRow)
      const spans = rows.slice(0, limit).map(mapSpan)
      return { spans, next_cursor: rows.length > limit ? spans.at(-1)!.span_id : null }
    },
    async logs({ tenantId, limit = 50, from, until, search, cursor, record_id, timestamp_nanos, event }) {
      const conditions = [`(ResourceAttributes['genio.tenant.id'] = ${quote(tenantId)} or LogAttributes['genio.tenant.id'] = ${quote(tenantId)})`]
      if (event) conditions.push(`Body = ${quote(event)}`)
      if (from !== undefined) conditions.push(`Timestamp >= fromUnixTimestamp64Milli(${from})`)
      if (until !== undefined) conditions.push(`Timestamp <= fromUnixTimestamp64Milli(${until})`)
      if (search) conditions.push(`(positionCaseInsensitiveUTF8(concat(ServiceName, Body, TraceId, SpanId), ${quote(search)}) > 0 or arrayExists(value -> positionCaseInsensitiveUTF8(value, ${quote(search)}) > 0, mapValues(LogAttributes)))`)
      if (record_id) {
        if (!timestamp_nanos) throw Object.assign(new Error("LOG_TIMESTAMP_REQUIRED"), { statusCode: 400 })
        conditions.push(`record_id = ${quote(record_id)} and Timestamp = fromUnixTimestamp64Nano(${timestamp_nanos})`)
        limit = 1
      }
      if (cursor) {
        let decoded: { timestamp?: string; id?: string }
        try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString()) } catch { throw Object.assign(new Error("INVALID_LOG_CURSOR"), { statusCode: 400 }) }
        if (!/^\d{1,20}$/.test(decoded.timestamp ?? "") || !/^[A-F0-9]{32}$/.test(decoded.id ?? "")) throw Object.assign(new Error("INVALID_LOG_CURSOR"), { statusCode: 400 })
        conditions.push(`(Timestamp, record_id) < (fromUnixTimestamp64Nano(${decoded.timestamp}), ${quote(decoded.id!)})`)
      }
      const query = `select distinct hex(sipHash128(Timestamp, ServiceName, TraceId, SpanId, Body, LogAttributes, ResourceAttributes)) as record_id,
        toString(toUnixTimestamp64Nano(Timestamp)) as timestamp_nanos, toUnixTimestamp64Milli(Timestamp) as timestamp_millis,
        ServiceName as service, SeverityText as severity, ${record_id ? "Body" : "substringUTF8(Body, 1, 160)"} as body, ${record_id ? "true" : "false"} as details_loaded, TraceId as trace_id, SpanId as span_id,
        LogAttributes['genio.correlation.id'] as correlation_id, ${record_id ? "LogAttributes" : "NULL"} as attributes, ${record_id ? "ResourceAttributes" : "NULL"} as resource_attributes
        from ${options.database}.otel_logs where ${conditions.join(" and ")} order by Timestamp desc, record_id desc limit ${limit + 1} settings max_block_size=128, max_threads=2 format JSONEachRow`
      const response = await request(`${origin}/`, { method: "POST", headers: { authorization, "content-type": "text/plain" }, body: query, signal: AbortSignal.timeout(30000) })
      if (!response.ok) throw new Error(`CLICKHOUSE_LOG_QUERY_FAILED:${response.status}`)
      const rows = (await response.text()).split("\n").filter(Boolean).map(line => JSON.parse(line) as TelemetryLog)
      const records = rows.slice(0, limit)
      const last = records.at(-1)
      return { records, next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ timestamp: last.timestamp_nanos, id: last.record_id })).toString("base64url") : null }
    },
    async list({ tenantId, limit, before, beforeTraceId, correlationId, search, from, until }) {
      const conditions = [`(ResourceAttributes['genio.tenant.id'] = ${quote(tenantId)} or SpanAttributes['genio.tenant.id'] = ${quote(tenantId)})`]
      const having: string[] = []
      if (from !== undefined) having.push(`min(toUnixTimestamp64Milli(Timestamp)) >= ${from}`)
      if (until !== undefined) having.push(`min(toUnixTimestamp64Milli(Timestamp)) <= ${until}`)
      if (correlationId) having.push(`countIf(SpanAttributes['genio.correlation.id'] = ${quote(correlationId)}) > 0`)
      if (search) having.push(`countIf(positionCaseInsensitiveUTF8(concat(TraceId, ServiceName, SpanName, toJSONString(SpanAttributes)), ${quote(search)}) > 0) > 0`)
      if (before !== undefined) having.push(`(min(toUnixTimestamp64Milli(Timestamp)), TraceId) < (${before}, ${quote(beforeTraceId ?? "ffffffffffffffffffffffffffffffff")})`)
      const query = `
        select distinct
          TraceId as trace_id,
          SpanId as span_id,
          ParentSpanId as parent_span_id,
          SpanName as span_name,
          ServiceName as service_name,
          toUnixTimestamp64Milli(Timestamp) as started_at_millis,
          Duration as duration_nanos,
          StatusCode as status_code,
          SpanAttributes['genio.correlation.id'] as correlation_id,
          SpanAttributes as attributes,
          ResourceAttributes as resource_attributes
        from ${options.database}.otel_traces
        where (ResourceAttributes['genio.tenant.id'] = ${quote(tenantId)} or SpanAttributes['genio.tenant.id'] = ${quote(tenantId)})
          and TraceId in (
          select TraceId
          from ${options.database}.otel_traces
          where ${conditions.join(" and ")}
          group by TraceId
          ${having.length ? `having ${having.join(" and ")}` : ""}
          order by min(toUnixTimestamp64Milli(Timestamp)) desc, TraceId desc
          limit ${Math.max(1, Math.min(100, limit))}
        )
        order by Timestamp asc
        limit 2001 by TraceId
        limit ${Math.max(1, Math.min(100, limit)) * 2001}
        format JSONEachRow`
      const response = await request(`${origin}/`, {
        method: "POST",
        headers: { authorization, "content-type": "text/plain; charset=utf-8" },
        body: query,
      })
      if (!response.ok) throw new Error(`CLICKHOUSE_TRACE_QUERY_FAILED:${response.status}`)
      const rows = (await response.text()).split("\n").filter(Boolean).map(
        (line) => JSON.parse(line) as TraceRow,
      )
      const grouped = new Map<string, TraceRow[]>()
      for (const row of rows) grouped.set(row.trace_id, [...(grouped.get(row.trace_id) ?? []), row])
      return [...grouped.entries()].map(([traceId, traceRows]) => {
        const uniqueRows = [...new Map(traceRows.map(row => [row.span_id, row])).values()]
        const spans = uniqueRows.slice(0, 2000).map(mapSpan).sort((left, right) => left.started_at - right.started_at)
        const startedAt = Math.min(...spans.map((span) => span.started_at))
        const finishedAt = Math.max(...spans.map((span) => span.started_at + span.duration_millis))
        const root = spans.find((span) => span.parent_span_id === null) ?? spans[0]!
        return {
          trace_id: traceId,
          correlation_id: correlationId ?? spans.find((span) => span.correlation_id)?.correlation_id ?? null,
          started_at: startedAt,
          duration_millis: Math.max(0, finishedAt - startedAt),
          status: traceStatus(spans),
          root_service: root.service,
          span_count: spans.length,
          spans_truncated: uniqueRows.length > 2000,
          spans,
        }
      }).sort((left, right) => right.started_at - left.started_at || right.trace_id.localeCompare(left.trace_id)).slice(0, limit)
    },
  }
}
