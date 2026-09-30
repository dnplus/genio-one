import { afterEach, expect, test } from "bun:test"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { SelfServiceApp } from "@/features/self-service/self-service-app"
import i18n from "@/i18n"

test("Self-service Catalog distinguishes an entitlement from a personal OAuth connection", async () => {
  const originalFetch = globalThis.fetch
  const originalPath = window.location.pathname
  const originalSearch = window.location.search
  const originalLanguage = i18n.language
  let unmount: (() => void) | undefined
  await i18n.changeLanguage("zh-TW")
  window.history.replaceState({}, "", "/self-service")
  sessionStorage.setItem("genioone.self_service_token", "self-service-token")
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname
    if (path === "/v1/identity/session") {
      return json({
        tenant_id: "tenant-175",
        subject_id: "employee-175",
        acting_client_id: "self-service-web",
        role: "USER",
        scopes: ["genioone-self-service"],
        acr: "oidc",
        amr: ["oidc"],
      })
    }
    if (path === "/v1/tenants/tenant-175/catalog") {
      return json({
        tenant_id: "tenant-175",
        catalog_revision: "catalog-1",
        subject_id: "employee-175",
        subject_display_name: "175 員工",
        capabilities: [{
          resource_id: "notion",
          resource_display_name: "Notion",
          capability_id: "notion.search",
          capability_display_name: "搜尋工作區",
          resource_owner_id: "knowledge",
          resource_owner_display_name: "知識管理",
          connection_status: "READY",
          access: "ENTITLED",
          hub_status: "CONNECTED",
        }],
      })
    }
    if (path === "/v1/tenants/tenant-175/me/access-requests") return json([])
    if (path === "/v1/tenants/tenant-175/me/entitlements") return json([])
    if (path === "/v1/tenants/tenant-175/me/access-notifications") return json([])
    if (path === "/v1/tenants/tenant-175/self-service-configuration") return json(null)
    if (path === "/v1/tenants/tenant-175/me/resource-onboarding-requests") return json([])
    throw new Error(`Unexpected request: ${path}`)
  }) as typeof fetch

  try {
    unmount = render(<I18nextProvider i18n={i18n}><SelfServiceApp /></I18nextProvider>).unmount

    await waitFor(() => expect(screen.getByRole("columnheader", { name: "存取狀態" })).toBeTruthy())
    const notionRow = screen.getByRole("row", { name: /Notion/ })
    expect(within(notionRow).getByText("已授權")).toBeTruthy()
    expect(within(notionRow).queryByText("已連線")).toBeNull()
  } finally {
    unmount?.()
    globalThis.fetch = originalFetch
    sessionStorage.removeItem("genioone.self_service_token")
    window.history.replaceState({}, "", `${originalPath}${originalSearch}`)
    await i18n.changeLanguage(originalLanguage)
  }
})

const tenantId = "tenant-acme"
const base = `/v1/tenants/${tenantId}`

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function pathOf(input: string | URL | Request) {
  if (input instanceof Request) return new URL(input.url).pathname
  return new URL(String(input), "http://localhost").pathname
}

function catalog() {
  return {
    tenant_id: tenantId,
    catalog_revision: "catalog-1",
    subject_id: "person-user",
    subject_display_name: "Kevin",
    capabilities: [{
      resource_id: "resource-ai",
      resource_display_name: "Enterprise Chat",
      capability_id: "mcp.invoke",
      capability_display_name: "Invoke",
      resource_owner_id: "org-ai",
      resource_owner_display_name: "AI Platform",
      connection_status: "READY",
      access: "AUTO_GRANT",
      hub_status: "AVAILABLE",
      restriction_reason: null,
    }],
  }
}

function identity() {
  return {
    tenant_id: tenantId,
    subject_id: "person-user",
    acting_client_id: "self-service-ui",
    role: "USER",
    organization_ids: [],
    scopes: ["genioone-invocation"],
    acr: "oidc",
    amr: ["oidc"],
  }
}

function createFetch(input: {
  activation: "refresh-fails" | "domain-error" | "unused"
  entitlements?: unknown[]
}) {
  let activationCalls = 0
  let activationSucceeded = false
  const fetch = async (request: string | URL | Request) => {
    const path = pathOf(request)
    if (path === "/v1/identity/session") return json(identity())
    if (path === `${base}/me/entitlements/activate`) {
      activationCalls++
      if (input.activation === "domain-error") return json({ code: "AUTO_GRANT_NOT_AVAILABLE" }, 422)
      activationSucceeded = true
      return json({
        entitlement_id: "entitlement-1",
        subject_id: "person-user",
        resource_id: "resource-ai",
        capability_id: "mcp.invoke",
        state: "ACTIVE",
        valid_from: 100,
        valid_until: null,
        revocation_reason: null,
      })
    }
    if (path === `${base}/catalog`) {
      if (activationSucceeded && input.activation === "refresh-fails") {
        return json({ code: "PRODUCT_API_REQUEST_FAILED_503" }, 503)
      }
      return json(catalog())
    }
    if (path === `${base}/me/access-requests`) return json([])
    if (path === `${base}/me/entitlements`) return json(input.entitlements ?? [])
    if (path === `${base}/me/access-notifications`) return json([])
    if (path === `${base}/self-service-configuration`) return json(null)
    if (path === `${base}/me/resource-onboarding-requests`) return json([])
    throw new Error(`Unexpected request: ${path}`)
  }
  return { fetch, activationCalls: () => activationCalls }
}

async function renderSelfService(language: "en" | "zh-TW" = "en") {
  sessionStorage.setItem("genioone.self_service_token", "self-service-token")
  sessionStorage.removeItem("genioone.signed_out:/self-service")
  const i18n = createInstance()
  await i18n.init({
    lng: language,
    fallbackLng: "en",
    resources: {
      en: {
        translation: {
          AUTO_GRANT_NOT_AVAILABLE: "This capability is no longer available for automatic activation. Refresh and select another available capability.",
        },
      },
      "zh-TW": {
        translation: {
          AUTO_GRANT_NOT_AVAILABLE: "此能力目前無法自動啟用。請重新整理後選擇其他可用能力。",
        },
      },
    },
  })
  render(
    <I18nextProvider i18n={i18n}>
      <SelfServiceApp />
    </I18nextProvider>,
  )
}

afterEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  window.history.replaceState({}, "", "/self-service")
})

test("AUTO_GRANT success remains a success when the following refresh fails", async () => {
  const originalFetch = globalThis.fetch
  const api = createFetch({ activation: "refresh-fails" })
  globalThis.fetch = api.fetch as typeof fetch

  try {
    await renderSelfService()
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Activate" }))

    const notice = await screen.findByRole("status")
    expect(notice.textContent).toBe("Resource activated. Refresh to see your updated access.")
    expect(screen.queryByRole("alert")).toBeNull()
    expect(api.activationCalls()).toBe(1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("AUTO_GRANT domain errors render actionable Traditional Chinese text", async () => {
  const originalFetch = globalThis.fetch
  const api = createFetch({ activation: "domain-error" })
  globalThis.fetch = api.fetch as typeof fetch

  try {
    await renderSelfService("zh-TW")
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Activate" }))

    const notice = await screen.findByRole("alert")
    expect(notice.textContent).toBe("此能力目前無法自動啟用。請重新整理後選擇其他可用能力。")
    expect(notice.textContent).not.toContain("AUTO_GRANT_NOT_AVAILABLE")
    expect(api.activationCalls()).toBe(1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("a finite entitlement after 2100 does not render as no expiration", async () => {
  const originalFetch = globalThis.fetch
  const api = createFetch({
    activation: "unused",
    entitlements: [{
      entitlement_id: "entitlement-2100",
      subject_id: "person-user",
      resource_id: "resource-ai",
      capability_id: "mcp.invoke",
      state: "ACTIVE",
      valid_from: 100,
      valid_until: 4_102_444_801,
      revocation_reason: null,
    }],
  })
  globalThis.fetch = api.fetch as typeof fetch

  try {
    await renderSelfService()
    await screen.findAllByText("Enterprise Chat")

    const row = document.querySelector<HTMLTableRowElement>("#entitlement-entitlement-2100")
    expect(row).not.toBeNull()
    expect(row?.textContent).not.toContain("No expiration")
    expect(row?.textContent).not.toContain("無到期日")
    expect(row?.cells[2]?.textContent).not.toBe("")
  } finally {
    globalThis.fetch = originalFetch
  }
})
