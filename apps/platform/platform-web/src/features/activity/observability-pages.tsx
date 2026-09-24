import { TelemetryLogs, localDateTime } from "./telemetry-logs"
import { Input } from "@/components/ui/input"
import { Fragment, useEffect, useMemo, useState } from "react"
import { ChevronDownIcon, ChevronRightIcon, RefreshCwIcon, Settings2Icon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { PageHeader } from "@/components/page-header"
import { RecordFilterBar } from "@/components/data-table/record-filter-bar"
import { TitleHelp } from "@/components/title-help"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { GatewayMetricsSummary, OverviewSnapshot, TraceSpan, TraceSummary } from "@/domain/contracts"
import { getGatewayMetrics, listTraces, listTraceSpans } from "@/lib/product-api"
import {
  EnforcementPointFilter,
  enforcementPointLabel,
  enforcementPointQueryKey,
  matchesEnforcementPoint,
  normalizeEnforcementPoint,
  readEnforcementPointFilter,
  writeEnforcementPointFilter,
  type EnforcementPointFilterValue,
  type EnforcementPointId,
} from "@/features/observability/enforcement-points"

function traceEnforcementPoint(trace: TraceSummary): EnforcementPointId | null {
  return trace.spans
    .map((span) => normalizeEnforcementPoint(span.service))
    .find((point) => point !== null) ?? normalizeEnforcementPoint(trace.root_service)
}

export function TracesPage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation()
  const [traces, setTraces] = useState<TraceSummary[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [correlationId, setCorrelationId] = useState(() => new URLSearchParams(window.location.search).get("correlation_id")?.trim() ?? "")
  const [enforcementPoint, setEnforcementPoint] = useState<EnforcementPointFilterValue>(() =>
    readEnforcementPointFilter(new URLSearchParams(window.location.search).get(enforcementPointQueryKey), "ALL"),
  )
  const [query, setQuery] = useState("")
  const [before, setBefore] = useState<{ before: number; before_trace_id: string }>()
  const [from, setFrom] = useState(() => localDateTime(Date.now() - 86400000))
  const [until, setUntil] = useState(() => Date.now())
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let active = true
    setError(null)
    setLoading(true)
    const timer = setTimeout(() => { void listTraces(tenantId, 20, { ...before, correlation_id: correlationId || undefined, search: query || undefined, from: from ? new Date(from).getTime() : undefined, until }).then(({ traces: next }) => {
      if (!active) return
      setTraces(next)
      setSelectedId((current) => next.some((trace) => trace.trace_id === current)
        ? current
        : next[0]?.trace_id ?? "")
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    })
    .finally(() => { if (active) setLoading(false) }) }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [tenantId, before, correlationId, query, from, until])
  const filteredTraces = traces.filter((trace) => {
    const tracePoint = traceEnforcementPoint(trace)
    if (enforcementPoint !== "ALL" && !matchesEnforcementPoint(tracePoint, enforcementPoint)) return false
    return true
  })
  useEffect(() => {
    if (selectedId && !filteredTraces.some((trace) => trace.trace_id === selectedId)) setSelectedId("")
  }, [filteredTraces, selectedId])
  const clearCorrelationFilter = () => {
    setCorrelationId("")
    setBefore(undefined)
    const url = new URL(window.location.href)
    url.searchParams.delete("correlation_id")
    window.history.replaceState({}, "", url)
  }
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("Traces")} description={t("Correlated execution paths across Gateway, policy, and upstream services.")} />
      <Card>
        <CardHeader className="border-b"><CardTitle><TitleHelp help={t("Select a trace to inspect its service path and timing.")}>{t("Trace explorer")}</TitleHelp></CardTitle><CardDescription>{t("Expand a trace to inspect its complete service path, timing, and span metadata.")}</CardDescription></CardHeader>
        <CardContent className="p-0">
          <RecordFilterBar query={query} onQueryChange={value => { setQuery(value); setBefore(undefined) }} searchPlaceholder={t("Search traces")} className="border-b px-5 py-3">
            <label className="text-sm">{t("Correlation ID")}<Input data-testid="trace-correlation-filter" type="search" value={correlationId} onChange={(event) => { setCorrelationId(event.target.value.trim()); setBefore(undefined) }} /></label>
            {correlationId ? <Button variant="outline" size="sm" onClick={clearCorrelationFilter}>{t("Clear filters")}</Button> : null}
            <label className="text-sm">{t("From")}<Input type="datetime-local" value={from} onChange={event => { setFrom(event.target.value); setBefore(undefined) }} /></label>
            <Button variant="outline" disabled={loading} onClick={() => { setBefore(undefined); setUntil(Date.now()) }}>{t("Refresh")}</Button>
            <EnforcementPointFilter
              value={enforcementPoint}
              onValueChange={(value) => {
                setEnforcementPoint(value)
                writeEnforcementPointFilter(value)
              }}
              testId="traces-enforcement-point-filter"
            />
          </RecordFilterBar>
          {error ? <div className="border-b px-5 py-4 text-sm text-destructive" role="alert">{error}</div> : null}
          <div className="min-w-0 overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>{t("Trace")}</TableHead><TableHead>{t("Correlation ID")}</TableHead><TableHead>{t("Service")}</TableHead><TableHead>{t("Enforcement point")}</TableHead><TableHead>{t("Duration")}</TableHead><TableHead>{t("Status")}</TableHead></TableRow></TableHeader>
              <TableBody>
                {filteredTraces.map((trace) => {
                  const expanded = trace.trace_id === selectedId
                  const tracePoint = traceEnforcementPoint(trace)
                  return (
                    <Fragment key={trace.trace_id}>
                      <TableRow
                        aria-expanded={expanded}
                        aria-label={expanded ? t("Collapse trace") : t("Expand trace")}
                        className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                        data-state={expanded ? "selected" : undefined}
                        onClick={() => setSelectedId((current) => current === trace.trace_id ? "" : trace.trace_id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault()
                            setSelectedId((current) => current === trace.trace_id ? "" : trace.trace_id)
                          }
                        }}
                        tabIndex={0}
                      >
                        <TableCell className="max-w-56 truncate font-mono text-xs" title={trace.trace_id}><span className="mr-2 inline-flex align-middle text-muted-foreground" aria-hidden="true">{expanded ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}</span>{trace.trace_id}</TableCell>
                        <TableCell className="max-w-56 truncate font-mono text-xs" title={trace.correlation_id ?? undefined}>{trace.correlation_id ?? "—"}</TableCell><TableCell>{trace.root_service}</TableCell><TableCell><Badge variant="outline">{tracePoint ? t(enforcementPointLabel(tracePoint)) : "—"}</Badge></TableCell><TableCell className="tabular-nums">{t("{{duration}} ms", { duration: trace.duration_millis.toFixed(1) })}</TableCell><TableCell><Badge variant={trace.status === "ERROR" ? "destructive" : "secondary"}>{t(trace.status)}</Badge></TableCell>
                      </TableRow>
                      {expanded ? <TableRow data-testid={`trace-detail-${trace.trace_id}`}><TableCell colSpan={6} className="bg-muted/20 p-0"><TraceDetails key={`${tenantId}:${trace.trace_id}:${until}`} tenantId={tenantId} trace={trace} /></TableCell></TableRow> : null}
                    </Fragment>
                  )
                })}
                {!error && filteredTraces.length === 0 ? <TableRow><TableCell colSpan={6} className="h-28 text-center text-muted-foreground">{t(traces.length || query || correlationId ? "No traces match the current filters" : "Run a governed request with trace collection enabled, then refresh to inspect its execution.")}</TableCell></TableRow> : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      <div className="flex gap-2"><Button variant="outline" disabled={loading || !before} onClick={() => setBefore(undefined)}>{t("First page")}</Button><Button variant="outline" disabled={loading || traces.length < 20} onClick={() => { const last = traces.at(-1); if (last) setBefore({ before: last.started_at, before_trace_id: last.trace_id }) }}>{t("Older records")}</Button></div>
      <TelemetryLogs tenantId={tenantId} />
    </div>
  )
}

function timelineSpans(trace: TraceSummary): Array<TraceSpan & { offsetMillis: number; offsetPercent: number; widthPercent: number }> {
  const duration = Math.max(trace.duration_millis, 0.001)
  return trace.spans.map((span) => ({
    ...span,
    offsetMillis: Math.max(0, span.started_at - trace.started_at),
    offsetPercent: Math.max(0, Math.min(100, ((span.started_at - trace.started_at) / duration) * 100)),
    widthPercent: Math.max(0.5, Math.min(100, (span.duration_millis / duration) * 100)),
  }))
}

function TraceDetails({ trace: initial, tenantId }: { trace: TraceSummary; tenantId: string }) {
  const [page, setPage] = useState<{ spans: TraceSpan[]; next_cursor: string | null }>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const trace = page ? { ...initial, spans: page.spans, spans_truncated: page.next_cursor !== null } : initial
  const loadPage = async (after?: string) => {
    setLoading(true)
    setError(undefined)
    try { setPage(await listTraceSpans(tenantId, initial.trace_id, after)) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }
  const { t } = useTranslation()
  const spans = useMemo(() => timelineSpans(trace), [trace])
  return (
    <div className="flex flex-col gap-6 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-heading text-lg font-medium">{t("Trace details")}<Badge variant={trace.status === "ERROR" ? "destructive" : "secondary"}>{t(trace.status)}</Badge></div>
          <p className="mt-1 text-sm text-muted-foreground">{t("Inspect the complete execution path and the metadata recorded for each span.")}</p>
        </div>
        <div className="rounded-lg border bg-card px-3 py-2 text-sm"><span className="text-muted-foreground">{t("Spans")}</span><span className="ml-2 font-semibold tabular-nums">{trace.span_count}</span></div>
      </div>
      {(initial.spans_truncated || page) && <div className="flex gap-2"><Button disabled={loading} variant="outline" onClick={() => { void loadPage() }}>{t("First page")}</Button><Button disabled={loading || (page !== undefined && page.next_cursor === null)} variant="outline" onClick={() => { void loadPage(page?.next_cursor ?? undefined) }}>{t("More spans")}</Button></div>}
      {error && <p role="alert">{error}</p>}
      {trace.spans_truncated && <p role="status">{t("Additional spans exist beyond this page")}</p>}
      <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="min-w-0"><dt className="text-xs text-muted-foreground">{t("Trace ID")}</dt><dd className="mt-1 truncate font-mono text-xs" title={trace.trace_id}>{trace.trace_id}</dd></div>
        <div className="min-w-0"><dt className="text-xs text-muted-foreground">{t("Correlation ID")}</dt><dd className="mt-1 truncate font-mono text-xs" title={trace.correlation_id ?? undefined}>{trace.correlation_id ?? "—"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{t("Root service")}</dt><dd className="mt-1 font-medium">{trace.root_service}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{t("Duration")}</dt><dd className="mt-1 font-medium tabular-nums">{t("{{duration}} ms", { duration: trace.duration_millis.toFixed(1) })}</dd></div>
      </dl>
      <section className="flex flex-col gap-3">
        <div><h3 className="font-medium">{t("Trace timeline")}</h3><p className="text-sm text-muted-foreground">{t("Relative span timing within this trace.")}</p></div>
        <div className="flex flex-col gap-2">
          {spans.map((span) => <div key={span.span_id} className="grid gap-2 sm:grid-cols-[minmax(12rem,0.35fr)_minmax(18rem,1fr)] sm:items-center"><div className="min-w-0"><div className="truncate text-sm font-medium" title={span.name}>{span.name}</div><div className="truncate font-mono text-xs text-muted-foreground" title={span.service}>{span.service}</div></div><div className="relative h-8 rounded-md bg-muted"><div className="absolute top-1 h-6 rounded bg-primary" style={{ left: `${span.offsetPercent}%`, width: `${span.widthPercent}%` }} /></div></div>)}
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="font-medium">{t("Span details")}</h3>
        <div className="overflow-x-auto rounded-lg border">
          <Table className="min-w-[60rem]">
            <TableHeader><TableRow><TableHead>{t("Span")}</TableHead><TableHead>{t("Service")}</TableHead><TableHead>{t("Span ID")}</TableHead><TableHead>{t("Parent Span")}</TableHead><TableHead>{t("Start offset")}</TableHead><TableHead>{t("Duration")}</TableHead><TableHead>{t("Status")}</TableHead></TableRow></TableHeader>
            <TableBody>{spans.map((span) => <TableRow key={span.span_id}><TableCell><div className="font-medium">{span.name}</div><div className="font-mono text-xs text-muted-foreground">{span.correlation_id ?? "—"}</div><details className="mt-2"><summary className="cursor-pointer text-sm">{t("Span metadata")}</summary>{Object.keys(span.attributes ?? {}).length || Object.keys(span.resource_attributes ?? {}).length ? <pre className="mt-2 max-h-96 max-w-2xl overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{JSON.stringify({ resource: span.resource_attributes ?? {}, span: span.attributes ?? {} }, null, 2)}</pre> : <p className="mt-2 text-muted-foreground">{t("Span metadata was not provided.")}</p>}</details></TableCell><TableCell>{span.service}</TableCell><TableCell className="font-mono text-xs">{span.span_id}</TableCell><TableCell className="font-mono text-xs">{span.parent_span_id ?? "—"}</TableCell><TableCell className="tabular-nums">{t("{{duration}} ms", { duration: `+${span.offsetMillis.toFixed(1)}` })}</TableCell><TableCell className="tabular-nums">{t("{{duration}} ms", { duration: span.duration_millis.toFixed(1) })}</TableCell><TableCell><Badge variant={span.status === "ERROR" ? "destructive" : "secondary"}>{t(span.status)}</Badge></TableCell></TableRow>)}</TableBody>
          </Table>
        </div>
      </section>
    </div>
  )
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`
  return `${(value / 1_048_576).toFixed(1)} MiB`
}

export function MetricsPage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation()
  const [summary, setSummary] = useState<GatewayMetricsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [enforcementPoint, setEnforcementPoint] = useState<EnforcementPointFilterValue>(() => {
    const requested = readEnforcementPointFilter(new URLSearchParams(window.location.search).get(enforcementPointQueryKey), "AI_GATEWAY")
    return requested === "ALL" ? "AI_GATEWAY" : requested
  })

  const load = () => {
    setLoading(true)
    setError(null)
    void getGatewayMetrics(tenantId).then(setSummary).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => setLoading(false))
  }

  useEffect(load, [tenantId])
  const selectedSummary = summary && matchesEnforcementPoint(summary.enforcement_point_id, enforcementPoint) ? summary : null

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("Metrics")}
        description={`${t("Metrics are grouped by enforcement point.")} ${t("Native Envoy Gateway traffic and provider signals from OpenTelemetry.")}`}
        actions={<Button variant="outline" disabled={loading} onClick={load}><RefreshCwIcon data-icon="inline-start" />{t("Refresh")}</Button>}
      />
      <RecordFilterBar className="px-0">
        <EnforcementPointFilter
          value={enforcementPoint}
          onValueChange={(value) => {
            if (value === "ALL") return
            setEnforcementPoint(value)
            writeEnforcementPointFilter(value)
          }}
          includeAll={false}
          testId="metrics-enforcement-point-filter"
        />
      </RecordFilterBar>
      <div className="flex items-center gap-2 text-sm" data-testid="metrics-enforcement-point"><span className="text-muted-foreground">{t("Enforcement point")}</span><Badge variant="outline">{t(enforcementPointLabel(enforcementPoint))}</Badge></div>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      {!loading && !error && !selectedSummary ? <Card><CardContent className="py-8 text-sm text-muted-foreground">{t("No metrics are currently collected for this enforcement point.")}</CardContent></Card> : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card><CardHeader><CardDescription>{t("Gateway requests")}</CardDescription><CardTitle className="text-2xl tabular-nums">{selectedSummary?.request_count ?? "—"}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>{t("Provider attempts")}</CardDescription><CardTitle className="text-2xl tabular-nums">{selectedSummary?.provider_attempt_count ?? "—"}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>{t("Errors")}</CardDescription><CardTitle className="text-2xl tabular-nums">{selectedSummary?.error_count ?? "—"}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>{t("Average latency")}</CardDescription><CardTitle className="text-2xl tabular-nums">{selectedSummary?.average_latency_millis === null || selectedSummary?.average_latency_millis === undefined ? "—" : `${selectedSummary.average_latency_millis.toFixed(1)} ms`}</CardTitle></CardHeader></Card>
      </div>
      <Card>
        <CardHeader className="border-b"><CardTitle>{t("Traffic volume")}</CardTitle><CardDescription>{t("Provider-hop body sizes reported by Envoy request and response histograms.")}</CardDescription></CardHeader>
        <CardContent className="grid gap-5 pt-5 sm:grid-cols-3">
          <div><div className="text-xs text-muted-foreground">{t("Request bytes")}</div><div className="mt-1 text-xl font-semibold tabular-nums">{selectedSummary ? formatBytes(selectedSummary.request_bytes) : "—"}</div></div>
          <div><div className="text-xs text-muted-foreground">{t("Response bytes")}</div><div className="mt-1 text-xl font-semibold tabular-nums">{selectedSummary ? formatBytes(selectedSummary.response_bytes) : "—"}</div></div>
          <div><div className="text-xs text-muted-foreground">{t("Sample window")}</div><div className="mt-1 text-xl font-semibold tabular-nums">{selectedSummary ? selectedSummary.window_seconds % 86_400 === 0 ? t("{{days}} days", { days: selectedSummary.window_seconds / 86_400 }) : t("{{minutes}} minutes", { minutes: selectedSummary.window_seconds / 60 }) : "—"}</div></div>
        </CardContent>
      </Card>
    </div>
  )
}

type WidgetId = "traffic" | "latency" | "errors" | "traces" | "tokens"
const widgetIds: WidgetId[] = ["traffic", "latency", "errors", "traces", "tokens"]
const dashboardStorageKey = "genioone.dashboard.v1"

function loadWidgets(): WidgetId[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(dashboardStorageKey) ?? "null") as { version?: number; widgets?: string[] } | null
    if (parsed?.version !== 1 || !Array.isArray(parsed.widgets)) return ["traffic", "latency", "errors", "traces"]
    const valid = parsed.widgets.filter((widget): widget is WidgetId => widgetIds.includes(widget as WidgetId))
    return valid.length ? valid : ["traffic", "latency", "errors", "traces"]
  } catch {
    return ["traffic", "latency", "errors", "traces"]
  }
}

export function DashboardsPage({ tenantId, data }: { tenantId: string; data: OverviewSnapshot }) {
  const { t } = useTranslation()
  const [widgets, setWidgets] = useState<WidgetId[]>(loadWidgets)
  const [draft, setDraft] = useState<WidgetId[]>(widgets)
  const [open, setOpen] = useState(false)
  const [traceCount, setTraceCount] = useState<number | null>(null)
  useEffect(() => {
    let active = true
    setTraceCount(null)
    void listTraces(tenantId).then((result) => { if (active) setTraceCount(result.traces.length) }).catch(() => { if (active) setTraceCount(null) })
    return () => { active = false }
  }, [tenantId, data])
  const metrics = data.gatewayMetrics
  const values: Record<WidgetId, string | number> = {
    traffic: metrics?.request_count ?? "—",
    latency: metrics?.average_latency_millis == null ? "—" : `${metrics.average_latency_millis.toFixed(1)} ms`,
    errors: metrics && metrics.request_count > 0 ? `${(metrics.error_count / metrics.request_count * 100).toFixed(1)}%` : "—",
    traces: traceCount ?? "—",
    tokens: data.aiUsage?.usage.total_tokens ?? "—",
  }
  const labels: Record<WidgetId, string> = { traffic: t("Gateway requests"), latency: t("Average latency"), errors: t("Error rate"), traces: t("Collected traces"), tokens: t("Total tokens") }

  function toggle(widget: WidgetId, checked: boolean) {
    setDraft((current) => checked ? [...new Set([...current, widget])] : current.filter((item) => item !== widget))
  }

  function save() {
    const next: WidgetId[] = draft.length ? draft : ["traffic"]
    setWidgets(next)
    localStorage.setItem(dashboardStorageKey, JSON.stringify({ version: 1, widgets: next }))
    setOpen(false)
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("Dashboards")} description={t("Compose an operational view from logs, traces, metrics, and usage signals.")} actions={
        <Sheet open={open} onOpenChange={(next) => { setOpen(next); if (next) setDraft(widgets) }}>
          <SheetTrigger asChild><Button variant="outline"><Settings2Icon data-icon="inline-start" />{t("Customize")}</Button></SheetTrigger>
          <SheetContent className="w-full sm:max-w-lg">
            <SheetHeader className="border-b px-6 py-5"><SheetTitle>{t("Customize dashboard")}</SheetTitle><SheetDescription>{t("Choose the signals shown in this view.")}</SheetDescription></SheetHeader>
            <FieldGroup className="p-6"><Field><FieldLabel>{t("Widgets")}</FieldLabel><div className="flex flex-col gap-2">{widgetIds.map((widget) => <label key={widget} className="flex cursor-pointer items-center gap-3 rounded-lg border p-3"><Checkbox checked={draft.includes(widget)} onCheckedChange={(checked) => toggle(widget, checked === true)} /><span>{labels[widget]}</span></label>)}</div></Field></FieldGroup>
            <SheetFooter className="mt-auto border-t bg-background px-6 py-4"><Button variant="outline" onClick={() => setOpen(false)}>{t("Cancel")}</Button><Button onClick={save}>{t("Save view")}</Button></SheetFooter>
          </SheetContent>
        </Sheet>
      } />
      <div className="grid gap-4 lg:grid-cols-2">
        {widgets.map((widget) => <Card key={widget}><CardHeader><CardDescription>{labels[widget]}</CardDescription><CardTitle className="text-2xl tabular-nums">{values[widget]}</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">{values[widget] === "—" ? t("No measurements are available for this signal.") : widget === "traces" ? t("Traces returned by the current collection query; not a coverage percentage.") : widget === "tokens" ? `${t("Sample window")}: ${new Date(data.aiUsage!.from * 1000).toLocaleString()} – ${new Date(data.aiUsage!.to * 1000).toLocaleString()}` : `${t(enforcementPointLabel(normalizeEnforcementPoint(metrics!.enforcement_point_id) ?? "AI_GATEWAY"))} · ${t("Sample window")}: ${t("{{minutes}} minutes", { minutes: metrics!.window_seconds / 60 })}`}</CardContent></Card>)}
      </div>
    </div>
  )
}
