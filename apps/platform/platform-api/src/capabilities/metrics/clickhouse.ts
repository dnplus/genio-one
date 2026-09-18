import type { GatewayMetricsStore } from "./module"
import type { HttpFetch } from "../../../../../../runtimes/gateway/services/shared/http-fetch"

interface SumRow {
  request_count: number
  success_count: number
  error_count: number
  provider_attempt_count: number
  sampled_at: number | null
}

interface HistogramRow {
  latency_samples: number
  latency_total_millis: number
  request_bytes: number
  response_bytes: number
}

function quote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
}

async function queryRow<T>(
  request: HttpFetch,
  origin: string,
  authorization: string,
  query: string,
): Promise<T> {
  const response = await request(`${origin}/`, {
    method: "POST",
    headers: { authorization, "content-type": "text/plain; charset=utf-8" },
    body: `${query}\nformat JSONEachRow`,
  })
  if (!response.ok) throw new Error(`CLICKHOUSE_METRICS_QUERY_FAILED:${response.status}`)
  const line = (await response.text()).trim()
  if (!line) throw new Error("CLICKHOUSE_METRICS_QUERY_EMPTY")
  return JSON.parse(line) as T
}

export function createClickHouseGatewayMetricsStore(options: {
  origin: string
  database: string
  username: string
  password: string
  fetch?: HttpFetch
}): GatewayMetricsStore {
  const request = options.fetch ?? fetch
  const origin = options.origin.replace(/\/$/, "")
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`
  return {
    async summarize({ tenantId, windowSeconds }) {
      const window = Math.max(60, Math.min(604_800, Math.floor(windowSeconds)))
      const tenant = quote(tenantId)
      const [sums, histograms] = await Promise.all([
        queryRow<SumRow>(request, origin, authorization, `
          select
            toUInt64(sumIf(Value, MetricName = 'listener.http.downstream_rq_completed'
              and match(Attributes['envoy.http_conn_manager_prefix'], '^http-[0-9]+$'))) as request_count,
            toUInt64(sumIf(Value, MetricName = 'listener.http.downstream_rq_xx'
              and match(Attributes['envoy.http_conn_manager_prefix'], '^http-[0-9]+$')
              and Attributes['envoy.response_code_class'] in ('2', '3'))) as success_count,
            toUInt64(sumIf(Value, MetricName = 'listener.http.downstream_rq_xx'
              and match(Attributes['envoy.http_conn_manager_prefix'], '^http-[0-9]+$')
              and Attributes['envoy.response_code_class'] in ('4', '5'))) as error_count,
            toUInt64(sumIf(Value, MetricName = 'cluster.external.upstream_rq_completed'
              and Attributes['envoy.cluster_name'] like '%-aigw/%')) as provider_attempt_count,
            if(count() = 0, null, toUnixTimestamp(max(TimeUnix))) as sampled_at
          from (
            select distinct ResourceAttributes, MetricName, Attributes, TimeUnix, StartTimeUnix, Value
            from ${options.database}.otel_metrics_sum
            where ResourceAttributes['genio.tenant.id'] = ${tenant}
              and TimeUnix >= now() - interval ${window} second
              and ((MetricName in ('listener.http.downstream_rq_completed', 'listener.http.downstream_rq_xx') and match(Attributes['envoy.http_conn_manager_prefix'], '^http-[0-9]+$'))
                or (MetricName = 'cluster.external.upstream_rq_completed' and Attributes['envoy.cluster_name'] like '%-aigw/%'))
          )`),
        queryRow<HistogramRow>(request, origin, authorization, `
          select
            toUInt64(sumIf(Count, MetricName = 'http.downstream_rq_time'
              and match(Attributes['envoy.http_conn_manager_prefix'], '^http-[0-9]+$'))) as latency_samples,
            sumIf(Sum, MetricName = 'http.downstream_rq_time'
              and match(Attributes['envoy.http_conn_manager_prefix'], '^http-[0-9]+$')) as latency_total_millis,
            toUInt64(round(sumIf(Sum, MetricName = 'cluster.upstream_rq_body_size'
              and Attributes['envoy.cluster_name'] like '%-aigw/%'))) as request_bytes,
            toUInt64(round(sumIf(Sum, MetricName = 'cluster.upstream_rs_body_size'
              and Attributes['envoy.cluster_name'] like '%-aigw/%'))) as response_bytes
          from (
            select distinct ResourceAttributes, MetricName, Attributes, TimeUnix, StartTimeUnix, Count, Sum
            from ${options.database}.otel_metrics_histogram
            where ResourceAttributes['genio.tenant.id'] = ${tenant}
              and TimeUnix >= now() - interval ${window} second
          )`),
      ])
      return {
        tenant_id: tenantId,
        enforcement_point_id: "AI_GATEWAY",
        window_seconds: window,
        sampled_at: sums.sampled_at === null ? null : Number(sums.sampled_at),
        request_count: Number(sums.request_count),
        success_count: Number(sums.success_count),
        error_count: Number(sums.error_count),
        provider_attempt_count: Number(sums.provider_attempt_count),
        average_latency_millis: Number(histograms.latency_samples) > 0
          ? Number(histograms.latency_total_millis) / Number(histograms.latency_samples)
          : null,
        request_bytes: Number(histograms.request_bytes),
        response_bytes: Number(histograms.response_bytes),
      }
    },
  }
}
