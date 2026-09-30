import { expect, test } from "bun:test"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import type { PageId } from "@/components/management-navigation"
import { OverviewPage } from "@/features/overview/overview-page"
import { dateKeyInTimeZone, currentTimeZone } from "@/lib/personal-preferences"
import { createMockOverview } from "@/mocks/overview"

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  })
}

test("Overview renders topology and transaction trends, then opens Activity with the selected context", async () => {
  const originalFetch = globalThis.fetch
  const day = dateKeyInTimeZone(Math.floor(Date.now() / 1_000), currentTimeZone())
  const opened: Array<[PageId, string | undefined]> = []
  let mounted: ReturnType<typeof render> | undefined
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://platform.test")
    if (url.pathname.endsWith("/transaction-trends")) {
      return json({
        points: [
          { day, enforcement_point_id: "ai-gateway", outcome: "COMPLETED", count: 2 },
          { day, enforcement_point_id: "api-management", outcome: "BLOCKED", count: 3 },
        ],
      })
    }
    if (url.pathname.endsWith("/demo-project")) {
      return json({
        demo_id: "ce-starter",
        version: "1.0.0",
        installation: "SKIPPED",
        organization_id: null,
        items: [],
        prompts: [],
        package_resource_id: "ce-starter-resource",
        bot_url: null,
      })
    }
    return json({})
  }) as typeof fetch

  try {
    const i18n = createInstance()
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
    const user = userEvent.setup()
    mounted = render(
      <I18nextProvider i18n={i18n}>
        <OverviewPage
          accessTier="T2"
          actorSubjectId="platform-admin"
          data={createMockOverview()}
          loading={false}
          onOpenList={(page, filter) => { opened.push([page, filter]) }}
          onRefresh={async () => {}}
          refreshing={false}
          tenantId="tenant-design-preview"
        />
      </I18nextProvider>,
    )

    const topology = await screen.findByTestId("overview-platform-topology")
    expect(within(topology).getByRole("tab", { name: "AI Gateway" })).toBeTruthy()
    expect(await screen.findByTestId("overview-topology-canvas-ai_mcp_gateway")).toBeTruthy()
    await user.click(within(topology).getByRole("button", { name: "Gateway traffic" }))
    expect(opened).toEqual([["activity", "AI_MCP_GATEWAY"]])

    const trends = screen.getByTestId("overview-transaction-trends")
    await waitFor(() => expect(within(trends).getByText("ALL · All outcomes · 5 transactions")).toBeTruthy())
    await user.click(within(trends).getByTestId("transaction-outcome-blocked"))
    expect(within(trends).getByText("ALL · BLOCK · 3 transactions")).toBeTruthy()
    await user.click(within(trends).getByRole("button", { name: "Open filtered Activity" }))
    expect(opened).toEqual([
      ["activity", "AI_MCP_GATEWAY"],
      ["activity", "BLOCK"],
    ])
  } finally {
    mounted?.unmount()
    globalThis.fetch = originalFetch
  }
})
