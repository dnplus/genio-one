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
    if (path === "/v1/tenants/tenant-175/me/memories") return json({ memories: [], next_cursor: null })
    if (path === "/v1/tenants/tenant-175/me/memory-agents") return json({ agents: [] })
    if (path === "/v1/tenants/tenant-175/me/memory-scopes") return json({ scopes: [] })
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
    if (path === `${base}/me/memories`) return json({ memories: [], next_cursor: null })
    if (path === `${base}/me/memory-agents`) return json({ agents: [] })
    if (path === `${base}/me/memory-scopes`) return json({ scopes: [] })
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

test("Self-service lets a person manage personal memories and per-client Agent grants", async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null; cursor: string | null }> = []
  let memories = [
    {
      memory_id: "memory-timezone",
      tenant_id: tenantId,
      scope: "PERSONAL",
      owner_subject_id: "person-user",
      team_id: null,
      organization_id: null,
      key: "timezone",
      kind: "preference",
      context: { kind: "GLOBAL", context_id: null },
      content: "Use Asia/Taipei.",
      assertion_origin: "USER_EXPLICIT",
      source: { actor_subject_id: "person-user", client_id: "genio-one-self-service", agent_id: null, agent_grant_id: null, reference_id: null },
      revision: 1,
      created_at: 1_700_000_000,
      updated_at: 1_700_000_000,
    },
    {
      memory_id: "memory-timezone-inferred",
      tenant_id: tenantId,
      scope: "PERSONAL",
      owner_subject_id: "person-user",
      team_id: null,
      organization_id: null,
      key: "timezone",
      kind: "fact",
      context: { kind: "GLOBAL", context_id: null },
      content: "Use UTC.",
      assertion_origin: "AGENT_INFERRED",
      source: { actor_subject_id: "person-user", client_id: "planning-agent", agent_id: "planning-agent", agent_grant_id: "grant-planning", reference_id: "conversation-1" },
      revision: 1,
      created_at: 1_700_000_001,
      updated_at: 1_700_000_001,
    },
  ]
  let grants = [
    ...Array.from({ length: 100 }, (_, index) => ({
      tenant_id: tenantId,
      owner_subject_id: "person-user",
      agent_id: `retired-agent-${index}`,
      grant_id: `grant-retired-${index}`,
      enabled_at: 1_700_000_100 + index,
      revoked_at: 1_700_000_200 + index as number | null,
    })),
    {
      tenant_id: tenantId,
      owner_subject_id: "person-user",
      agent_id: "planning-agent",
      grant_id: "grant-planning",
      enabled_at: 1_700_000_000,
      revoked_at: null as number | null,
    },
  ]

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost")
    const path = url.pathname
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    requests.push({ path, method, body, cursor: url.searchParams.get("cursor") })

    if (path === "/v1/identity/session") return json(identity())
    if (path === `${base}/catalog`) return json(catalog())
    if (path === `${base}/me/access-requests`) return json([])
    if (path === `${base}/me/entitlements`) return json([])
    if (path === `${base}/me/access-notifications`) return json([])
    if (path === `${base}/self-service-configuration`) return json(null)
    if (path === `${base}/me/resource-onboarding-requests`) return json([])
    if (path === `${base}/me/memories` && method === "GET") return json({ memories, next_cursor: null })
    if (path === `${base}/me/memories` && method === "POST") {
      if (body?.memory_id) {
        const current = memories.find((memory) => memory.memory_id === body.memory_id)
        if (!current) return json({ code: "MEMORY_NOT_FOUND" }, 404)
        const updated = {
          ...current,
          content: String(body.content),
          revision: current.revision + 1,
          updated_at: current.updated_at + 1,
        }
        memories = memories.map((memory) => memory.memory_id === current.memory_id ? updated : memory)
        return json(updated)
      }
      const created = {
        memory_id: "memory-meeting-style",
        tenant_id: tenantId,
        scope: "PERSONAL" as const,
        owner_subject_id: "person-user",
        team_id: null,
        organization_id: null,
        key: String(body?.key),
        kind: String(body?.kind),
        context: body?.context,
        content: String(body?.content),
        assertion_origin: "USER_EXPLICIT" as const,
        source: { actor_subject_id: "person-user", client_id: "genio-one-self-service", agent_id: null, agent_grant_id: null, reference_id: null },
        revision: 1,
        created_at: 1_700_000_002,
        updated_at: 1_700_000_002,
      }
      memories = [created, ...memories]
      return json(created, 201)
    }
    if (path.startsWith(`${base}/me/memories/`) && method === "DELETE") {
      const memoryId = path.slice(`${base}/me/memories/`.length)
      memories = memories.filter((memory) => memory.memory_id !== memoryId)
      return json({ memory_id: memoryId, scope: "PERSONAL", owner_subject_id: "person-user", deleted_revision: body?.expected_revision, deleted_at: 1_700_000_010 })
    }
    if (path === `${base}/me/memory-agents` && method === "GET") {
      const offset = Number(url.searchParams.get("cursor") ?? "0")
      const limit = Number(url.searchParams.get("limit") ?? "100")
      return json({
        agents: grants.slice(offset, offset + limit),
        next_cursor: grants.length > offset + limit ? String(offset + limit) : null,
      })
    }
    if (path === `${base}/me/memory-agents` && method === "POST") {
      const grant = {
        tenant_id: tenantId,
        owner_subject_id: "person-user",
        agent_id: String(body?.agent_id),
        grant_id: `grant-${body?.agent_id}`,
        enabled_at: 1_700_000_003,
        revoked_at: null as number | null,
      }
      grants = [...grants, grant]
      return json(grant, 201)
    }
    if (path.startsWith(`${base}/me/memory-agents/`) && method === "DELETE") {
      const agentId = path.slice(`${base}/me/memory-agents/`.length)
      const grant = grants.find((entry) => entry.agent_id === agentId)
      if (!grant) return json({ code: "MEMORY_AGENT_GRANT_NOT_FOUND" }, 404)
      const revoked = { ...grant, revoked_at: 1_700_000_004 }
      grants = grants.map((entry) => entry.agent_id === agentId ? revoked : entry)
      return json(revoked)
    }
    if (path === `${base}/me/memory-scopes`) return json({ scopes: [] })
    throw new Error(`Unexpected request: ${method} ${path}`)
  }) as typeof fetch

  try {
    await renderSelfService()
    const user = userEvent.setup()

    await screen.findByTestId("personal-memory-panel")
    await screen.findByTestId("personal-memory-agent-planning-agent")
    expect(requests.some((request) => request.path === `${base}/me/memory-agents` && request.method === "GET" && request.cursor === "100")).toBe(true)
    expect(screen.getAllByText("retired-agent-99")).toHaveLength(1)
    expect(screen.getAllByText("Observed difference")).toHaveLength(2)
    expect(screen.getByText(/Agent planning-agent through planning-agent/)).toBeTruthy()
    expect(screen.getByText("An enabled OAuth client lets its Agent read your personal memory and read or write Team and Organization shared memory according to your current permissions; if you can manage shared memory, it may also correct or permanently delete it. Revoking removes all memory access.")).toBeTruthy()
    expect(screen.getByText("Each enabled OAuth client has its own memory grant for your personal memory and the Team and Organization shared memory allowed by your current permissions.")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Add memory" }))
    await user.type(screen.getByLabelText("Memory key"), "meeting-style")
    await user.selectOptions(screen.getByLabelText("Memory context"), "PROJECT")
    await user.type(screen.getByLabelText("Project ID"), "project-alpha")
    await user.type(screen.getByLabelText("Memory"), "Keep weekly updates concise.")
    await user.click(screen.getByRole("button", { name: "Save memory" }))

    await waitFor(() => expect(screen.getByTestId("personal-memory-memory-meeting-style")).toBeTruthy())
    const createRequest = requests.find((request) => request.path === `${base}/me/memories` && request.method === "POST" && request.body?.memory_id === undefined)
    expect(createRequest?.body).toMatchObject({
      expected_revision: 0,
      key: "meeting-style",
      kind: "preference",
      context: { kind: "PROJECT", context_id: "project-alpha" },
      content: "Keep weekly updates concise.",
    })

    const createdRow = screen.getByTestId("personal-memory-memory-meeting-style")
    await user.click(within(createdRow).getByRole("button", { name: "Correct memory meeting-style" }))
    expect(screen.getByLabelText("Memory key").getAttribute("readonly")).not.toBeNull()
    expect((screen.getByLabelText("Memory type") as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText("Memory context") as HTMLSelectElement).disabled).toBe(true)
    const content = screen.getByLabelText("Memory")
    await user.clear(content)
    await user.type(content, "Keep weekly updates to three bullets.")
    await user.click(screen.getByRole("button", { name: "Save correction" }))

    await waitFor(() => expect(screen.getByText("Keep weekly updates to three bullets.")).toBeTruthy())
    const correctionRequest = requests.find((request) => request.path === `${base}/me/memories` && request.method === "POST" && request.body?.memory_id === "memory-meeting-style")
    expect(correctionRequest?.body).toMatchObject({ memory_id: "memory-meeting-style", expected_revision: 1, content: "Keep weekly updates to three bullets." })

    await user.click(within(screen.getByTestId("personal-memory-memory-meeting-style")).getByRole("button", { name: "Permanently delete memory meeting-style" }))
    await user.click(screen.getByRole("button", { name: "Delete permanently" }))
    await waitFor(() => expect(screen.queryByTestId("personal-memory-memory-meeting-style")).toBeNull())
    expect(requests.some((request) => request.path === `${base}/me/memories/memory-meeting-style` && request.method === "DELETE" && request.body?.expected_revision === 2)).toBe(true)

    await user.type(screen.getByLabelText("Agent OAuth client ID"), "research-agent")
    await user.click(screen.getByRole("button", { name: "Enable Agent memory" }))
    await waitFor(() => expect(screen.getByTestId("personal-memory-agent-research-agent")).toBeTruthy())
    expect(requests.some((request) => request.path === `${base}/me/memory-agents` && request.method === "POST" && request.body?.agent_id === "research-agent")).toBe(true)

    const activeGrant = screen.getByTestId("personal-memory-agent-planning-agent")
    await user.click(within(activeGrant).getByRole("button", { name: "Revoke" }))
    expect(screen.getByText("planning-agent will lose all access to your personal memory and the Team and Organization shared memory allowed by your current permissions. You can enable it again later.")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Revoke Agent access" }))
    await waitFor(() => expect(screen.queryByTestId("personal-memory-agent-planning-agent")).toBeNull())
    expect(screen.getByText("Revoked Agents")).toBeTruthy()
    expect(screen.getAllByText("planning-agent", { exact: true })).toHaveLength(1)
    expect(requests.some((request) => request.path === `${base}/me/memory-agents/planning-agent` && request.method === "DELETE")).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Self-service scopes shared memories and applies contributor and manager actions through their REST contracts", async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = []
  const teamPath = `${base}/team-workspaces/team-product/memories`
  const readOnlyTeamPath = `${base}/team-workspaces/team-security/memories`
  const organizationPath = `${base}/organizations/org-reliability/memories`
  const source = {
    actor_subject_id: "person-user",
    client_id: "genio-one-self-service",
    agent_id: null,
    agent_grant_id: null,
    reference_id: null,
  }
  let teamMemories = [
    {
      memory_id: "memory-team-release",
      tenant_id: tenantId,
      scope: "TEAM" as const,
      owner_subject_id: null,
      team_id: "team-product",
      organization_id: "org-product",
      key: "release-window",
      kind: "decision" as const,
      context: { kind: "GLOBAL" as const, context_id: null },
      content: "Deploy on Tuesday.",
      assertion_origin: "USER_EXPLICIT" as const,
      source,
      revision: 1,
      created_at: 1_700_000_100,
      updated_at: 1_700_000_100,
    },
    {
      memory_id: "memory-team-release-inferred",
      tenant_id: tenantId,
      scope: "TEAM" as const,
      owner_subject_id: null,
      team_id: "team-product",
      organization_id: "org-product",
      key: "release-window",
      kind: "fact" as const,
      context: { kind: "GLOBAL" as const, context_id: null },
      content: "Deploy on Friday.",
      assertion_origin: "AGENT_INFERRED" as const,
      source: {
        actor_subject_id: "person-agent-owner",
        client_id: "release-agent-client",
        agent_id: "release-agent",
        agent_grant_id: "grant-release",
        reference_id: "change-42",
      },
      revision: 1,
      created_at: 1_700_000_101,
      updated_at: 1_700_000_101,
    },
  ]
  let organizationMemories = [
    {
      memory_id: "memory-org-policy",
      tenant_id: tenantId,
      scope: "ORGANIZATION" as const,
      owner_subject_id: null,
      team_id: null,
      organization_id: "org-reliability",
      key: "incident-policy",
      kind: "decision" as const,
      context: { kind: "PROJECT" as const, context_id: "platform" },
      content: "Escalate production incidents within 15 minutes.",
      assertion_origin: "USER_EXPLICIT" as const,
      source,
      revision: 1,
      created_at: 1_700_000_110,
      updated_at: 1_700_000_110,
    },
  ]
  const readOnlyTeamMemories = [
    {
      memory_id: "memory-team-security",
      tenant_id: tenantId,
      scope: "TEAM" as const,
      owner_subject_id: null,
      team_id: "team-security",
      organization_id: "org-product",
      key: "review-window",
      kind: "fact" as const,
      context: { kind: "GLOBAL" as const, context_id: null },
      content: "Security review occurs before release.",
      assertion_origin: "USER_EXPLICIT" as const,
      source,
      revision: 1,
      created_at: 1_700_000_105,
      updated_at: 1_700_000_105,
    },
  ]
  let teamProposals = [{
    proposal_id: "proposal-team-release",
    tenant_id: tenantId,
    memory_id: "memory-team-release",
    scope: "TEAM" as const,
    owner_subject_id: null,
    team_id: "team-product",
    organization_id: "org-product",
    base_revision: 1,
    proposed_kind: "decision" as const,
    proposed_content: "Deploy on Wednesday.",
    source: {
      actor_subject_id: "person-agent-owner",
      client_id: "release-agent-client",
      agent_id: "release-agent",
      agent_grant_id: "grant-release",
      reference_id: "change-43",
    },
    status: "PENDING" as const,
    reviewer_subject_id: null,
    created_at: 1_700_000_102,
    resolved_at: null as number | null,
  }]
  let organizationProposals = [{
    proposal_id: "proposal-org-policy-stale",
    tenant_id: tenantId,
    memory_id: "memory-org-policy",
    scope: "ORGANIZATION" as const,
    owner_subject_id: null,
    team_id: null,
    organization_id: "org-reliability",
    base_revision: 1,
    proposed_kind: "decision" as const,
    proposed_content: "Escalate production incidents within 15 minutes.",
    source: {
      actor_subject_id: "person-contributor",
      client_id: "incident-assistant",
      agent_id: "incident-assistant",
      agent_grant_id: "grant-incident",
      reference_id: "incident-17",
    },
    status: "PENDING" as const,
    reviewer_subject_id: null,
    created_at: 1_700_000_110,
    resolved_at: null as number | null,
  }, {
    proposal_id: "proposal-org-policy",
    tenant_id: tenantId,
    memory_id: "memory-org-policy",
    scope: "ORGANIZATION" as const,
    owner_subject_id: null,
    team_id: null,
    organization_id: "org-reliability",
    base_revision: 1,
    proposed_kind: "decision" as const,
    proposed_content: "Escalate production incidents within 10 minutes.",
    source: {
      actor_subject_id: "person-contributor",
      client_id: "incident-assistant",
      agent_id: "incident-assistant",
      agent_grant_id: "grant-incident",
      reference_id: "incident-18",
    },
    status: "PENDING" as const,
    reviewer_subject_id: null,
    created_at: 1_700_000_111,
    resolved_at: null as number | null,
  }]

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = pathOf(input)
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    requests.push({ path, method, body })

    if (path === "/v1/identity/session") return json(identity())
    if (path === `${base}/catalog`) return json(catalog())
    if (path === `${base}/me/access-requests`) return json([])
    if (path === `${base}/me/entitlements`) return json([])
    if (path === `${base}/me/access-notifications`) return json([])
    if (path === `${base}/self-service-configuration`) return json(null)
    if (path === `${base}/me/resource-onboarding-requests`) return json([])
    if (path === `${base}/me/memories`) return json({ memories: [], next_cursor: null })
    if (path === `${base}/me/memory-agents`) return json({ agents: [] })
    if (path === `${base}/me/memory-scopes`) {
      return json({
        scopes: [
          {
            target: { scope: "PERSONAL" },
            display_name: "Personal",
            can_read: true,
            can_contribute: true,
            can_manage: true,
          },
          {
            target: { scope: "TEAM", workspace_id: "team-product" },
            display_name: "Product Delivery",
            can_read: true,
            can_contribute: true,
            can_manage: false,
          },
          {
            target: { scope: "ORGANIZATION", organization_id: "org-reliability" },
            display_name: "Reliability",
            can_read: true,
            can_contribute: true,
            can_manage: true,
          },
          {
            target: { scope: "TEAM", workspace_id: "team-security" },
            display_name: "Security Review",
            can_read: true,
            can_contribute: false,
            can_manage: false,
          },
        ],
      })
    }
    if (path === teamPath && method === "GET") return json({ memories: teamMemories, next_cursor: null })
    if (path === readOnlyTeamPath && method === "GET") return json({ memories: readOnlyTeamMemories, next_cursor: null })
    if (path === organizationPath && method === "GET") return json({ memories: organizationMemories, next_cursor: null })
    if (path === teamPath && method === "POST") {
      const created = {
        memory_id: "memory-team-retrospective",
        tenant_id: tenantId,
        scope: "TEAM" as const,
        owner_subject_id: null,
        team_id: "team-product",
        organization_id: "org-product",
        key: String(body?.key),
        kind: String(body?.kind) as "preference" | "fact" | "decision",
        context: body?.context,
        content: String(body?.content),
        assertion_origin: "USER_EXPLICIT" as const,
        source,
        revision: 1,
        created_at: 1_700_000_103,
        updated_at: 1_700_000_103,
      }
      teamMemories = [created, ...teamMemories]
      return json(created, 201)
    }
    if (path === organizationPath && method === "POST") {
      const current = organizationMemories.find((memory) => memory.memory_id === body?.memory_id)
      if (!current) return json({ code: "MEMORY_NOT_FOUND" }, 404)
      const updated = {
        ...current,
        content: String(body?.content),
        revision: current.revision + 1,
        updated_at: current.updated_at + 1,
      }
      organizationMemories = organizationMemories.map((memory) => memory.memory_id === current.memory_id ? updated : memory)
      return json(updated)
    }
    if (path === `${organizationPath}/memory-org-policy` && method === "DELETE") {
      organizationMemories = organizationMemories.filter((memory) => memory.memory_id !== "memory-org-policy")
      return json({ memory_id: "memory-org-policy", scope: "ORGANIZATION", owner_subject_id: null, deleted_revision: body?.expected_revision, deleted_at: 1_700_000_115 })
    }
    if ((path.startsWith(`${teamPath}/`) || path.startsWith(`${readOnlyTeamPath}/`)) && path.endsWith("/corrections") && method === "GET") return json({ code: "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED" }, 403)
    if (path === `${organizationPath}/memory-org-policy/corrections` && method === "GET") return json({ proposals: organizationProposals, next_cursor: null })
    if (path === `${teamPath}/memory-team-release/corrections` && method === "POST") {
      const proposal = {
        proposal_id: "proposal-team-user",
        tenant_id: tenantId,
        memory_id: "memory-team-release",
        scope: "TEAM" as const,
        owner_subject_id: null,
        team_id: "team-product",
        organization_id: "org-product",
        base_revision: 1,
        proposed_kind: "decision" as const,
        proposed_content: String(body?.content),
        source,
        status: "PENDING" as const,
        reviewer_subject_id: null,
        created_at: 1_700_000_104,
        resolved_at: null as number | null,
      }
      teamProposals = [proposal, ...teamProposals]
      return json(proposal, 201)
    }
    if (path === `${organizationPath}/memory-org-policy/corrections/proposal-org-policy-stale/review` && method === "POST") {
      const current = organizationProposals.find((proposal) => proposal.proposal_id === "proposal-org-policy-stale")!
      const stale = {
        ...current,
        status: "STALE" as const,
        proposed_content: null,
        reviewer_subject_id: null,
        resolved_at: 1_700_000_112,
      }
      organizationProposals = organizationProposals.map((proposal) => proposal.proposal_id === stale.proposal_id ? stale : proposal)
      return json({ proposal: stale, memory: organizationMemories[0] })
    }
    if (path === `${organizationPath}/memory-org-policy/corrections/proposal-org-policy/review` && method === "POST") {
      const proposal = organizationProposals.find((entry) => entry.proposal_id === "proposal-org-policy")!
      const accepted = {
        ...proposal,
        status: "ACCEPTED" as const,
        proposed_content: null,
        reviewer_subject_id: "person-user",
        resolved_at: 1_700_000_112,
      }
      organizationProposals = organizationProposals.map((entry) => entry.proposal_id === accepted.proposal_id ? accepted : entry)
      const current = organizationMemories[0]
      const updated = {
        ...current,
        content: "Escalate production incidents within 10 minutes.",
        revision: current.revision + 1,
        updated_at: current.updated_at + 1,
      }
      organizationMemories = [updated]
      return json({ proposal: accepted, memory: updated })
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  }) as typeof fetch

  try {
    await renderSelfService()
    const user = userEvent.setup()

    await screen.findByTestId("shared-memory-memory-team-release")
    const scopeSelect = screen.getByLabelText("Shared memory scope") as HTMLSelectElement
    expect(Array.from(scopeSelect.options).map((option) => option.text)).toEqual([
      "Team · Product Delivery",
      "Organization · Reliability",
      "Team · Security Review",
    ])
    expect(screen.getAllByText("Observed difference")).toHaveLength(2)
    expect(screen.queryByTestId("shared-memory-proposals-memory-team-release")).toBeNull()
    expect(requests.some((request) => request.path.startsWith(`${teamPath}/`) && request.path.endsWith("/corrections") && request.method === "GET")).toBe(false)
    expect(screen.queryByRole("alert")).toBeNull()

    await user.click(screen.getByRole("button", { name: "Add shared memory" }))
    await user.type(screen.getByLabelText("Memory key"), "retrospective-style")
    await user.selectOptions(screen.getByLabelText("Memory context"), "PROJECT")
    await user.type(screen.getByLabelText("Project ID"), "project-delivery")
    await user.type(screen.getByLabelText("Memory"), "Keep retrospective actions measurable.")
    await user.click(screen.getByRole("button", { name: "Save memory" }))
    await waitFor(() => expect(screen.getByTestId("shared-memory-memory-team-retrospective")).toBeTruthy())
    expect(requests.find((request) => request.path === teamPath && request.method === "POST")?.body).toMatchObject({
      expected_revision: 0,
      key: "retrospective-style",
      kind: "preference",
      context: { kind: "PROJECT", context_id: "project-delivery" },
      content: "Keep retrospective actions measurable.",
    })

    await user.click(within(screen.getByTestId("shared-memory-memory-team-release")).getByRole("button", { name: "Propose correction" }))
    const proposedContent = screen.getByLabelText("Proposed memory")
    await user.clear(proposedContent)
    await user.type(proposedContent, "Deploy on Thursday.")
    await user.click(screen.getByRole("button", { name: "Submit correction proposal" }))
    await waitFor(() => expect(screen.getByText("Shared memory correction proposed.")).toBeTruthy())
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByTestId("shared-memory-proposals-memory-team-release")).toBeNull()
    expect(screen.getByText("Deploy on Tuesday.")).toBeTruthy()
    expect(teamProposals.find((proposal) => proposal.proposal_id === "proposal-team-user")).toMatchObject({ status: "PENDING", proposed_content: "Deploy on Thursday." })
    expect(requests.some((request) => request.path.startsWith(`${teamPath}/`) && request.path.endsWith("/corrections") && request.method === "GET")).toBe(false)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(requests.find((request) => request.path === `${teamPath}/memory-team-release/corrections` && request.method === "POST")?.body).toMatchObject({
      expected_revision: 1,
      content: "Deploy on Thursday.",
    })

    await user.selectOptions(scopeSelect, "TEAM:team-security")
    await screen.findByTestId("shared-memory-memory-team-security")
    expect(screen.queryByRole("button", { name: "Add shared memory" })).toBeNull()
    expect(within(screen.getByTestId("shared-memory-memory-team-security")).queryByRole("button")).toBeNull()
    expect(screen.queryByTestId("shared-memory-proposals-memory-team-security")).toBeNull()
    expect(requests.some((request) => request.path.startsWith(`${readOnlyTeamPath}/`) && request.path.endsWith("/corrections") && request.method === "GET")).toBe(false)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByText("You can view this scope. Only contributors can add records, and only managers can directly correct, delete, or review proposals.")).toBeTruthy()

    await user.selectOptions(scopeSelect, "ORGANIZATION:org-reliability")
    await screen.findByTestId("shared-memory-memory-org-policy")
    const staleProposal = await screen.findByTestId("shared-memory-proposal-proposal-org-policy-stale")
    const organizationMemoryRequestsBeforeStaleReview = requests.filter((request) => request.path === organizationPath && request.method === "GET").length
    const organizationProposalRequestsBeforeStaleReview = requests.filter((request) => request.path === `${organizationPath}/memory-org-policy/corrections` && request.method === "GET").length
    await user.click(within(staleProposal).getByRole("button", { name: "Reject correction" }))
    await waitFor(() => expect(screen.getByText("This correction proposal is stale and was not applied. Check the current memory and try again.")).toBeTruthy())
    await waitFor(() => expect(within(screen.getByTestId("shared-memory-proposal-proposal-org-policy-stale")).getByText("Stale")).toBeTruthy())
    await waitFor(() => expect(requests.filter((request) => request.path === organizationPath && request.method === "GET").length).toBeGreaterThan(organizationMemoryRequestsBeforeStaleReview))
    await waitFor(() => expect(requests.filter((request) => request.path === `${organizationPath}/memory-org-policy/corrections` && request.method === "GET").length).toBeGreaterThan(organizationProposalRequestsBeforeStaleReview))
    const organizationProposal = await screen.findByTestId("shared-memory-proposal-proposal-org-policy")
    await user.click(within(organizationProposal).getByRole("button", { name: "Accept correction" }))
    await waitFor(() => expect(within(screen.getByTestId("shared-memory-proposal-proposal-org-policy")).getByText("Accepted")).toBeTruthy())
    await waitFor(() => expect(screen.getByText("Escalate production incidents within 10 minutes.")).toBeTruthy())

    const organizationMemory = screen.getByTestId("shared-memory-memory-org-policy")
    await user.click(within(organizationMemory).getByRole("button", { name: "Correct shared memory incident-policy" }))
    expect(screen.getByLabelText("Memory key").getAttribute("readonly")).not.toBeNull()
    expect((screen.getByLabelText("Memory type") as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText("Memory context") as HTMLSelectElement).disabled).toBe(true)
    const correctedContent = screen.getByLabelText("Memory")
    await user.clear(correctedContent)
    await user.type(correctedContent, "Escalate production incidents within 5 minutes.")
    await user.click(screen.getByRole("button", { name: "Save correction" }))
    await waitFor(() => expect(screen.getByText("Escalate production incidents within 5 minutes.")).toBeTruthy())
    expect(requests.find((request) => request.path === organizationPath && request.method === "POST")?.body).toMatchObject({
      memory_id: "memory-org-policy",
      expected_revision: 2,
      content: "Escalate production incidents within 5 minutes.",
    })

    await user.click(within(screen.getByTestId("shared-memory-memory-org-policy")).getByRole("button", { name: "Permanently delete shared memory incident-policy" }))
    await user.click(screen.getByRole("button", { name: "Delete permanently" }))
    await waitFor(() => expect(screen.queryByTestId("shared-memory-memory-org-policy")).toBeNull())
    expect(requests.some((request) => request.path === `${organizationPath}/memory-org-policy` && request.method === "DELETE" && request.body?.expected_revision === 3)).toBe(true)
    await user.selectOptions(scopeSelect, "TEAM:team-product")
    await screen.findByTestId("shared-memory-memory-team-release")
    expect(screen.queryByText("Correction proposals")).toBeNull()
    expect(requests.some((request) => request.path.startsWith(`${teamPath}/`) && request.path.endsWith("/corrections") && request.method === "GET")).toBe(false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
