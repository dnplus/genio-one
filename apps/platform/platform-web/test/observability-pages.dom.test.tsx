import { expect, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { TracesPage } from "@/features/activity/observability-pages"

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
    globalThis.fetch = originalFetch
    window.history.replaceState({}, "", originalUrl)
  }
})
