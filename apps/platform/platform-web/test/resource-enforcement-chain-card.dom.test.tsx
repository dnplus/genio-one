import { afterEach, expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import type { ResourceRegistration } from "@/domain/contracts"
import { ResourceEnforcementChainCard } from "@/features/resources/resource-enforcement-chain-card"
import { adminEnglish, adminTraditionalChinese } from "@/i18n/admin-governance"
import type { EnforcementChainRevisionView, PolicyDraftView } from "@/lib/product-api"

const tenantId = "tenant-acme"
const resource: ResourceRegistration = {
  tenant_id: tenantId,
  resource_id: "resource-support",
  display_name: "Support Resource",
  kind: "MCP",
  owner_organization_id: "organization-acme",
  authentication_strategy: "NONE",
  environment_id: "environment-prod",
  version: "1.0.0",
  lifecycle: "PUBLISHED",
  operational_state: "HEALTHY",
  capabilities: [{ capability_id: "support.answer", display_name: "Answer support" }],
  enforcement_point_id: "gateway-acme",
  created_at: 1,
}

function revision(adapterId = "jev-primary", safetyCheckCount = 1): EnforcementChainRevisionView {
  return {
    tenant_id: tenantId,
    resource_id: resource.resource_id,
    capability_id: "support.answer",
    one_policy_revision: 4,
    chain: {
      eligible_connection_ids: [],
      steps: [
        { step_id: "authenticate", kind: "AUTHENTICATE" },
        { step_id: "authorize", kind: "AUTHORIZE" },
        {
          step_id: "guardrail",
          kind: "PROCESS",
          hooks: {
            request: {
              action: "SAFETY_CHECK",
              config: {
                schema_version: 1,
                adapter_id: adapterId,
                checks: Array.from({ length: safetyCheckCount }, (_, index) => ({
                  id: index === 0 ? "secrets" : `check-${index}`,
                  instructions: index === 0 ? "Reject secrets" : `Reject check ${index}`,
                  threshold: 0.7,
                })),
                timeout_ms: 5000,
              },
            },
          },
        },
        {
          step_id: "tokenize",
          kind: "PROCESS",
          hooks: {
            request: {
              action: "TOKENIZE",
              config: {
                patterns: [{ name: "EMAIL", expression: "email-regex", flags: "i" }],
                token_ttl_seconds: 600,
                detector: {
                  adapter_id: "presidio-primary",
                  language: "en",
                  entities: ["EMAIL_ADDRESS"],
                  score_threshold: 0.5,
                },
              },
            },
            response: {
              action: "RESTORE",
              config: { patterns: [], token_ttl_seconds: 600 },
            },
          },
        },
        { step_id: "route", kind: "ROUTE" },
      ],
      request_filter_order: [],
      response_filter_order: [],
    },
    chain_digest: "digest",
    created_at: 1,
    updated_at: 1,
  }
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.pathname
  return input.url
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function policyDraft(): PolicyDraftView {
  return {
    policy_key: '["resource-support","support.answer"]',
    version: 1,
    base_revision: 4,
    lifecycle: "DRAFT",
    content_digest: "a".repeat(64),
    created_by_subject_id: "subject-admin",
    created_at: 1,
    updated_by_subject_id: "subject-admin",
    updated_at: 1,
    validation: null,
    review: null,
    content: {
      kind: "RESOURCE_CAPABILITY",
      definition: {
        one_policy_revision: 5,
        eligible_connection_ids: [],
        steps: [
          { step_id: "authenticate", kind: "AUTHENTICATE" },
          { step_id: "authorize", kind: "AUTHORIZE" },
          { step_id: "route", kind: "ROUTE" },
        ],
      },
    },
  }
}

function installFetch({ adapterStatus = 200, adapterId = "jev-primary", safetyCheckCount = 1 }: { adapterStatus?: number; adapterId?: string; safetyCheckCount?: number } = {}) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input)
    const method = input instanceof Request ? input.method : init?.method ?? "GET"
    if (path === "/v1/identity/browser-configuration") {
      return json({
        issuer: "https://identity.example.test/realms/genioone",
        authorization_endpoint: "https://identity.example.test/authorize",
        token_endpoint: "https://identity.example.test/token",
        client_id: "platform-web",
        scopes: ["openid"],
        management_client_id: "platform-management",
        management_scopes: ["openid"],
      })
    }
    if (path.includes("/processor-adapters")) {
      return adapterStatus === 200
        ? json({ adapters: [
          { id: "jev-primary", kind: "JEV", endpoint: "https://jev.example.test/guard", model: "guardrail-v1" },
          { id: "http-primary", kind: "HTTP", endpoint: "https://safety.example.test/check" },
          { id: "presidio-primary", kind: "PRESIDIO", endpoint: "https://presidio.example.test/analyze" },
        ] })
        : json({ code: "PROCESSOR_ADAPTER_CATALOG_UNAVAILABLE" }, adapterStatus)
    }
    if (path.includes("/enforcement-chain")) return json(revision(adapterId, safetyCheckCount))
    if (path.endsWith("/policy-draft")) return method === "PUT" ? json(policyDraft()) : json(null)
    return json({ code: "UNEXPECTED_REQUEST" }, 404)
  }) as typeof fetch
  return () => { globalThis.fetch = originalFetch }
}

async function renderCard(language: "en" | "zh-TW") {
  const i18n = createInstance()
  await i18n.init({
    lng: language,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: { translation: adminEnglish },
      "zh-TW": { translation: adminTraditionalChinese },
    },
  })
  render(
    <I18nextProvider i18n={i18n}>
      <ResourceEnforcementChainCard canEdit resource={resource} tenantId={tenantId} />
    </I18nextProvider>,
  )
}

let restoreFetch: (() => void) | undefined

afterEach(() => {
  restoreFetch?.()
  restoreFetch = undefined
})

test("renders tenant-scoped JEV safety and Presidio tokenization controls", async () => {
  restoreFetch = installFetch()
  const user = userEvent.setup()

  await renderCard("en")
  await user.click(await screen.findByRole("button", { name: "Edit policy" }))

  await waitFor(() => expect(screen.getByText("Guardrail provider")).toBeTruthy())
  expect(screen.getByText("JEV · https://jev.example.test/guard · guardrail-v1")).toBeTruthy()
  expect(screen.getByText("Presidio provider")).toBeTruthy()
  expect(screen.getByText("PRESIDIO · https://presidio.example.test/analyze")).toBeTruthy()
  expect(screen.getByText("Additional regular expression")).toBeTruthy()
  expect(screen.getByDisplayValue("email-regex")).toBeTruthy()
  expect(screen.getByDisplayValue("EMAIL_ADDRESS")).toBeTruthy()
})

test("shows client-side safety validation before any draft save", async () => {
  restoreFetch = installFetch({ adapterId: "" })
  const user = userEvent.setup()

  await renderCard("en")
  await user.click(await screen.findByRole("button", { name: "Edit policy" }))
  await user.click(screen.getByRole("button", { name: "Save draft" }))

  await waitFor(() => expect(screen.getByText("Choose an available guardrail provider and complete each safety check before saving.")).toBeTruthy())
})

test("keeps a safety check ID focused while it is edited", async () => {
  restoreFetch = installFetch()
  const user = userEvent.setup()

  await renderCard("en")
  await user.click(await screen.findByRole("button", { name: "Edit policy" }))

  const checkId = await screen.findByDisplayValue("secrets")
  await user.click(checkId)
  await user.type(checkId, "-review")

  expect(screen.getByDisplayValue("secrets-review")).toBe(checkId)
  expect(document.activeElement).toBe(checkId)
})

test("reuses the first available safety check ID after removal and saves a valid draft", async () => {
  restoreFetch = installFetch()
  const user = userEvent.setup()

  await renderCard("en")
  await user.click(await screen.findByRole("button", { name: "Edit policy" }))

  const addCheck = screen.getByRole("button", { name: "Add safety check" })
  await user.click(addCheck)
  await user.click(addCheck)
  await user.click(screen.getAllByRole("button", { name: "Remove" })[1]!)
  await user.click(addCheck)

  const checkIds = screen.getAllByRole("textbox")
    .map((input) => (input as HTMLInputElement).value)
    .filter((value) => value === "secrets" || /^check-\d+$/.test(value))
  expect(checkIds.sort()).toEqual(["check-1", "check-2", "secrets"])
  expect(new Set(checkIds).size).toBe(checkIds.length)

  const prompts = screen.getAllByRole("textbox").filter((input) => input.tagName === "TEXTAREA")
  await user.type(prompts[1]!, "Block the second check")
  await user.type(prompts[2]!, "Block the third check")
  await user.click(screen.getByRole("button", { name: "Save draft" }))

  await waitFor(() => expect(screen.getByText("Draft saved. Validate the saved draft before review.")).toBeTruthy())
})

test("disables adding a sixty-fifth safety check", async () => {
  restoreFetch = installFetch({ safetyCheckCount: 64 })
  const user = userEvent.setup()

  await renderCard("en")
  await user.click(await screen.findByRole("button", { name: "Edit policy" }))

  expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(64)
  expect(screen.getByRole("button", { name: "Add safety check" }).hasAttribute("disabled")).toBeTrue()
})

test("renders the safety editor in Traditional Chinese", async () => {
  restoreFetch = installFetch()
  const user = userEvent.setup()

  await renderCard("zh-TW")
  await user.click(await screen.findByRole("button", { name: "編輯政策" }))

  await waitFor(() => expect(screen.getByText("護欄供應商")).toBeTruthy())
  expect(screen.getByText("請求安全檢查")).toBeTruthy()
  expect(screen.getByText("請求 Presidio 偵測器")).toBeTruthy()
  expect(screen.getByText("Presidio 供應商")).toBeTruthy()
})

test("distinguishes a catalog load failure from an empty operator catalog", async () => {
  restoreFetch = installFetch({ adapterStatus: 404 })
  const user = userEvent.setup()

  await renderCard("en")
  await user.click(await screen.findByRole("button", { name: "Edit policy" }))

  await waitFor(() => expect(screen.getByText("Unable to load safety adapters")).toBeTruthy())
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
  expect(screen.queryByText("Safety adapters are not configured")).toBeNull()
  expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy()
})
