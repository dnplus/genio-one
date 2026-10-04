import { expect, test } from "bun:test"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import type { OverviewSnapshot } from "@/domain/contracts"
import { DashboardsPage, MetricsPage, TracesPage } from "@/features/activity/observability-pages"
import { createMockAiUsageDashboard, createMockGatewayMetrics } from "@/mocks/observability"
import { createMockOverview } from "@/mocks/overview"

const correlationId = "canonical-activity-correlation"
const traceId = "a".repeat(32)

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  })
}

test("TracesPage deep-links correlation IDs through the exact trace filter", async () => {
  const originalFetch = globalThis.fetch
  const originalUrl = window.location.href
  const requestedUrls: string[] = []
  window.location.href = `about:blank?view=traces&correlation_id=${encodeURIComponent(correlationId)}`
  expect(new URLSearchParams(window.location.search).get("correlation_id")).toBe(correlationId)
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    requestedUrls.push(url)
    const parsed = new URL(url, "http://platform.test")
    if (parsed.pathname.endsWith("/traces")) {
      return json({ traces: [{
        trace_id: traceId,
        correlation_id: correlationId,
        started_at: 1_000,
        duration_millis: 2,
        status: "OK",
        root_service: "genio-one-platform-api",
        span_count: 1,
        spans: [{
          trace_id: traceId,
          span_id: "b".repeat(16),
          parent_span_id: null,
          name: "request",
          service: "genio-one-platform-api",
          started_at: 1_000,
          duration_millis: 2,
          status: "OK",
          correlation_id: correlationId,
          attributes: {},
          resource_attributes: {},
        }],
      }] })
    }
    return json({ records: [], next_cursor: null })
  }) as typeof fetch

  try {
    const i18n = createInstance()
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
    render(
      <I18nextProvider i18n={i18n}>
        <TracesPage tenantId="tenant-1" />
      </I18nextProvider>,
    )

    const correlationInput = await screen.findByTestId("trace-correlation-filter") as HTMLInputElement
    expect(correlationInput.value).toBe(correlationId)
    expect((await screen.findAllByText(traceId)).length).toBeGreaterThan(0)
    const traceRequest = requestedUrls.map((url) => new URL(url, "http://platform.test")).find((url) => url.pathname.endsWith("/traces"))
    expect(traceRequest?.searchParams.get("correlation_id")).toBe(correlationId)
    expect(traceRequest?.searchParams.has("search")).toBe(false)
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
    window.location.href = originalUrl
  }
})

test("TracesPage expands a trace into its timeline and span metadata", async () => {
  const originalFetch = globalThis.fetch
  const expandedTraceId = "c".repeat(32)
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    const parsed = new URL(url, "http://platform.test")
    if (parsed.pathname.endsWith("/traces")) {
      return json({ traces: [
        {
          trace_id: traceId,
          correlation_id: correlationId,
          started_at: 1_000,
          duration_millis: 20,
          status: "OK",
          root_service: "AI Gateway",
          span_count: 1,
          spans: [{
            trace_id: traceId,
            span_id: "b".repeat(16),
            parent_span_id: null,
            name: "request",
            service: "AI Gateway",
            started_at: 1_000,
            duration_millis: 20,
            status: "OK",
            correlation_id: correlationId,
            attributes: {},
            resource_attributes: {},
          }],
        },
        {
          trace_id: expandedTraceId,
          correlation_id: "span-metadata-correlation",
          started_at: 2_000,
          duration_millis: 40,
          status: "OK",
          root_service: "API Gateway",
          span_count: 1,
          spans: [{
            trace_id: expandedTraceId,
            span_id: "d".repeat(16),
            parent_span_id: null,
            name: "gateway.authorize",
            service: "API Gateway",
            started_at: 2_010,
            duration_millis: 20,
            status: "OK",
            correlation_id: "span-metadata-correlation",
            attributes: { "http.method": "POST" },
            resource_attributes: { "service.namespace": "gateway" },
          }],
        },
      ] })
    }
    return json({ records: [], next_cursor: null })
  }) as typeof fetch

  try {
    const i18n = createInstance()
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
    const user = userEvent.setup()
    render(
      <I18nextProvider i18n={i18n}>
        <TracesPage tenantId="tenant-1" />
      </I18nextProvider>,
    )

    await user.click(await screen.findByText(expandedTraceId))
    expect(await screen.findByTestId(`trace-detail-${expandedTraceId}`)).toBeTruthy()
    expect(screen.getByText("Trace timeline")).toBeTruthy()
    expect(screen.getAllByText("gateway.authorize").length).toBe(2)

    await user.click(screen.getByText("Span metadata"))
    const metadata = await screen.findByText((content, element) =>
      element?.tagName === "PRE" && content.includes('"http.method": "POST"'),
    )
    expect(metadata.textContent).toContain('"service.namespace": "gateway"')
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
  }
})

test("MetricsPage filters a loaded summary and shows its empty result", async () => {
  const originalFetch = globalThis.fetch
  const originalUrl = window.location.href
  window.history.replaceState({}, "", "/management?view=metrics&enforcement=AI_GATEWAY")
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    const parsed = new URL(url, "http://platform.test")
    if (parsed.pathname.endsWith("/metrics")) {
      return json({
        tenant_id: "tenant-1",
        enforcement_point_id: "AI_GATEWAY",
        window_seconds: 604_800,
        sampled_at: 1_000,
        request_count: 41,
        success_count: 40,
        error_count: 1,
        provider_attempt_count: 43,
        average_latency_millis: 18.5,
        request_bytes: 1_024,
        response_bytes: 2_048,
      })
    }
    return json({ records: [], next_cursor: null })
  }) as typeof fetch

  try {
    const i18n = createInstance()
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
    const user = userEvent.setup()
    render(
      <I18nextProvider i18n={i18n}>
        <MetricsPage tenantId="tenant-1" />
      </I18nextProvider>,
    )

    expect((await screen.findByText("41")).textContent).toBe("41")
    expect(screen.getByTestId("metrics-enforcement-point").textContent).toContain("AI Gateway")

    await user.click(screen.getByTestId("metrics-enforcement-point-filter"))
    await user.click(await screen.findByRole("option", { name: "API Gateway" }))

    expect(await screen.findByText("No metrics are currently collected for this enforcement point.")).toBeTruthy()
    expect(screen.getByTestId("metrics-enforcement-point").textContent).toContain("API Gateway")
    expect(new URL(window.location.href).searchParams.get("enforcement")).toBe("API_GATEWAY")
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
    window.location.href = originalUrl
  }
})

test("MetricsPage makes a metrics retrieval failure visible", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error("Gateway metrics unavailable")
  }) as typeof fetch

  try {
    const i18n = createInstance()
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
    render(
      <I18nextProvider i18n={i18n}>
        <MetricsPage tenantId="tenant-1" />
      </I18nextProvider>,
    )

    expect((await screen.findByRole("alert")).textContent).toContain("Gateway metrics unavailable")
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
  }
})

test("DashboardsPage loads metrics and usage independently from the overview snapshot", async () => {
  const originalFetch = globalThis.fetch
  const originalWidgets = localStorage.getItem("genioone.dashboard.v1")
  const metrics = createMockGatewayMetrics("tenant-1")
  metrics.request_count = 123
  const usage = createMockAiUsageDashboard("tenant-1", 1_000, 2_000)
  usage.usage.total_tokens = 456
  localStorage.setItem("genioone.dashboard.v1", JSON.stringify({ version: 1, widgets: ["traffic", "tokens"] }))
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    const parsed = new URL(url, "http://platform.test")
    if (parsed.pathname.endsWith("/metrics")) return json(metrics)
    if (parsed.pathname.endsWith("/ai-usage")) return json(usage)
    if (parsed.pathname.endsWith("/traces")) return json({ traces: [] })
    return json([])
  }) as typeof fetch
  try {
    const i18n = createInstance()
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
    const data: OverviewSnapshot = { ...createMockOverview(), aiUsage: null, gatewayMetrics: null }
    render(
      <I18nextProvider i18n={i18n}>
        <DashboardsPage tenantId="tenant-1" data={data} />
      </I18nextProvider>,
    )

    await waitFor(() => expect(screen.getByText("123")).toBeTruthy())
    expect(screen.getByText("456")).toBeTruthy()
    expect(screen.queryByText("No measurements are available for this signal.")).toBeNull()
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
    if (originalWidgets === null) localStorage.removeItem("genioone.dashboard.v1")
    else localStorage.setItem("genioone.dashboard.v1", originalWidgets)
  }
})
