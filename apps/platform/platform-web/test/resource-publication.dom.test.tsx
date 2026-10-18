import { expect, test } from "bun:test"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { SheetWorkspaceRoot } from "@/components/ui/sheet"
import type { IdentitySession, ResourceRegistration } from "@/domain/contracts"
import { OnePolicyPage } from "@/features/policy/one-policy-page"
import { ResourceCatalogPage } from "@/features/resources/resource-catalog-page"
import { createMockOverview } from "@/mocks/overview"

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

test("missing publication route policy guides an owner to its existing draft editor without a retired write", async () => {
  const originalFetch = globalThis.fetch
  const originalUrl = window.location.href
  const data = createMockOverview()
  const resource: ResourceRegistration = {
    ...data.resources.find((candidate) => candidate.kind === "MCP")!,
    lifecycle: "DRAFT",
    publication_request: null,
    capabilities: [
      { capability_id: "mcp-tool-read_wiki", display_name: "Read wiki" },
      { capability_id: "mcp.invoke", display_name: "Managed MCP invocation" },
    ],
    publication_endpoint: {
      gateway_id: "mcp-gateway",
      hostname: "mcp.example.test",
      base_path: "/mcp",
      visibility: "PRIVATE",
      dns_management: "EXTERNAL",
      dns_verification: "VERIFIED",
      dns_target: "mcp-gateway.example.test",
    },
  }
  data.resources = [resource]
  data.connections = data.connections.filter((connection) => connection.resource_id === resource.resource_id).map((connection) => ({ ...connection, status: "READY", lifecycle: "ENABLED" }))
  const identity = { tenant_id: resource.tenant_id, subject_id: "owner-admin", acting_client_id: "management-ui", role: "TENANT_ADMINISTRATOR", scopes: ["genioone-management"], acr: "test", amr: ["test"] } as IdentitySession
  const writes: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (init?.method && init.method !== "GET") writes.push(`${init.method} ${url}`)
    if (url.endsWith("/enforcement-chain")) return json({ code: "ENFORCEMENT_CHAIN_NOT_FOUND" }, 404)
    if (url.endsWith("/policy-draft") || url.endsWith("/one-policy/first-party-bot")) return json(null)
    if (url.endsWith("/processor-adapters")) return json({ adapters: [] })
    if (url.endsWith("/one-policy/authoring-settings")) return json({ tenant_id: resource.tenant_id, revision: 0, require_distinct_reviewer: false, updated_at: 1 })
    return json([])
  }) as typeof fetch
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  const user = userEvent.setup()
  const wrap = (element: React.ReactNode) => <I18nextProvider i18n={i18n}><SheetWorkspaceRoot>{element}</SheetWorkspaceRoot></I18nextProvider>
  let view: { unmount: () => void } | undefined
  window.happyDOM.setURL(`http://127.0.0.1:5173/management?view=resources&resource=${resource.resource_id}`)
  try {
    view = render(wrap(<ResourceCatalogPage tenantId={resource.tenant_id} identity={identity} data={data} initialResourceId={resource.resource_id} search="" onRefresh={async () => {}} />))
    await user.click(screen.getByRole("button", { name: "Publish", exact: true }))
    const error = await screen.findByText("ENFORCEMENT_CHAIN_REQUIRED")
    const alert = error.closest("[role=alert]") as HTMLElement
    expect(within(alert).getByText("Publish this Resource's One Policy draft before requesting publication.")).toBeTruthy()
    const link = within(alert).getByRole("link", { name: "Open policy" })
    const destination = new URL(link.getAttribute("href")!, "http://127.0.0.1:5173")
    expect(destination.searchParams.get("view")).toBe("policy")
    expect(JSON.parse(destination.searchParams.get("policy")!)).toEqual([resource.resource_id, "mcp.invoke"])
    expect(writes.some((request) => request.includes("/enforcement-chain") || request.includes("/publication-requests"))).toBe(false)
    view.unmount()
    window.history.replaceState({}, "", `${destination.pathname}${destination.search}`)
    view = render(wrap(<OnePolicyPage canManageFirstPartyBotSeed data={data} identity={identity} tenantId={resource.tenant_id} />))
    const editor = await screen.findByTestId("policy-detail-sheet")
    await waitFor(() => expect((within(editor).getByRole("button", { name: "Edit policy" }) as HTMLButtonElement).disabled).toBe(false))
    expect(within(editor).getByText(`${resource.display_name} / Managed MCP invocation`)).toBeTruthy()
  } finally {
    view?.unmount()
    globalThis.fetch = originalFetch
    window.happyDOM.setURL(originalUrl)
  }
})
