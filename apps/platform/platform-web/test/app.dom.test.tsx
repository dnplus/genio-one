import { expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { App } from "@/app"

function overviewResponse(requestUrl: string) {
  if (requestUrl.includes("/ai-activities?")) return { resources: [], recent_activity: [] }
  if (requestUrl.includes("/api-activities?")) return { events: [] }
  if (requestUrl.includes("/ai-usage?")) return null
  if (requestUrl.includes("/metrics?")) return null
  if (requestUrl.endsWith("/siem-destination")) return null
  if (requestUrl.endsWith("/identity")) return null
  if (requestUrl.endsWith("/gateway-sites")) return null
  if (requestUrl.endsWith("/demo-project")) {
    return {
      demo_id: "ce-starter",
      version: "1.0.0",
      installation: "NOT_INSTALLED",
      organization_id: null,
      items: [],
      prompts: [],
      package_resource_id: "ce-starter-package",
      bot_url: null,
    }
  }
  if (requestUrl === "/healthz") return { status: "ok" }
  return []
}

async function renderManagementApp(
  role: "TENANT_ADMINISTRATOR" | "ORGANIZATION_ADMINISTRATOR",
  view: string,
  verifiedTenantId = "tenant-acme",
) {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  const originalFetch = globalThis.fetch
  const requestedPaths: string[] = []
  window.happyDOM.setURL(`http://localhost/management?view=${view}`)
  sessionStorage.setItem("genioone.management_token", "management-token")
  globalThis.fetch = (async (input: string | URL | Request) => {
    const requestUrl = input instanceof Request ? input.url : String(input)
    requestedPaths.push(requestUrl)
    const payload = requestUrl.endsWith("/v1/identity/session")
      ? {
        tenant_id: verifiedTenantId,
        subject_id: role === "TENANT_ADMINISTRATOR" ? "tenant-admin" : "person-uat-kevin",
        acting_client_id: "management-ui",
        role,
        organization_ids: role === "ORGANIZATION_ADMINISTRATOR" ? ["org-uat-access"] : [],
        administrator_organization_ids: role === "ORGANIZATION_ADMINISTRATOR" ? ["org-uat-access"] : [],
        scopes: ["genioone-management"],
        acr: "oidc",
        amr: ["oidc"],
      }
      : overviewResponse(requestUrl)
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  render(<I18nextProvider i18n={i18n}><App /></I18nextProvider>)
  return {
    requestedPaths,
    restore() {
      globalThis.fetch = originalFetch
      sessionStorage.removeItem("genioone.management_token")
      window.happyDOM.setURL("http://localhost/management")
    },
  }
}

test("a USER canonical session on an Access deep link is sent to Self-service without management navigation or Overview requests", async () => {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  const originalFetch = globalThis.fetch
  const requestedPaths: string[] = []
  window.history.replaceState({}, "", "/management?view=access")
  sessionStorage.setItem("genioone.management_token", "user-token")
  globalThis.fetch = (async (input: string | URL | Request) => {
    const requestUrl = input instanceof Request ? input.url : String(input)
    requestedPaths.push(requestUrl)
    if (requestUrl.endsWith("/v1/identity/session")) {
      return new Response(JSON.stringify({
        tenant_id: "tenant-acme",
        subject_id: "subject-user",
        acting_client_id: "management-ui",
        role: "USER",
        scopes: ["genioone-management"],
        acr: "oidc",
        amr: ["oidc"],
      }), { status: 200, headers: { "content-type": "application/json" } })
    }
    throw new Error(`Unexpected request: ${requestUrl}`)
  }) as typeof fetch

  try {
    render(<I18nextProvider i18n={i18n}><App /></I18nextProvider>)

    await waitFor(() => expect(screen.getByText("Management access required")).toBeTruthy())
    expect(screen.getByRole("link", { name: "Open Self-service" }).getAttribute("href")).toBe("/self-service")
    expect(screen.queryByTestId("global-search-trigger")).toBeNull()
    expect(screen.queryByText("Request inventory")).toBeNull()
    expect(requestedPaths).toEqual(["/v1/identity/session"])
  } finally {
    globalThis.fetch = originalFetch
    sessionStorage.removeItem("genioone.management_token")
    window.history.replaceState({}, "", "/management")
  }
})

test("Organization Administrator cannot open tenant-wide Audit and retains Access and Organization navigation", async () => {
  const app = await renderManagementApp("ORGANIZATION_ADMINISTRATOR", "audit")

  try {
    await waitFor(() => expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy())
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("view")).toBeNull())

    expect(app.requestedPaths.some((path) => path.includes("/audit-events"))).toBe(false)
    expect(screen.queryByText("Audit logs")).toBeNull()
    expect(screen.getByText("Access")).toBeTruthy()
    expect(screen.getByText("Organization and roles")).toBeTruthy()
  } finally {
    app.restore()
  }
})

test("Tenant Administrator loads Overview and Audit for the verified OIDC Tenant", async () => {
  const app = await renderManagementApp("TENANT_ADMINISTRATOR", "audit", "tenant-verified")

  try {
    await waitFor(() => expect(screen.getByTestId("audit-export-panel")).toBeTruthy())

    const tenantRequests = app.requestedPaths.filter((path) => path.startsWith("/v1/tenants/"))
    expect(tenantRequests.length).toBeGreaterThan(0)
    expect(tenantRequests.every((path) => path.startsWith("/v1/tenants/tenant-verified/"))).toBe(true)
    expect(app.requestedPaths.some((path) => path.includes("/audit-events"))).toBe(true)
    expect(screen.getAllByText("Audit logs").length).toBeGreaterThan(0)
  } finally {
    app.restore()
  }
})
