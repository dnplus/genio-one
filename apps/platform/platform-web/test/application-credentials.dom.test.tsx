import { expect, test } from "bun:test"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { SheetWorkspaceRoot } from "@/components/ui/sheet"
import type { ApplicationApiCredential, ApplicationApiCredentialCreation, ApplicationRegistration, OverviewSnapshot, ResourceRegistration } from "@/domain/contracts"
import { ApplicationAccessSheet } from "@/features/applications/application-access-sheet"
import { RegisterApplicationSheet } from "@/features/applications/register-application-sheet"
import { adminEnglish } from "@/i18n/admin-governance"
import { createMockOverview } from "@/mocks/overview"

const application: ApplicationRegistration = {
  tenant_id: "tenant-acme",
  application_id: "application-reporting",
  subject_id: "subject-reporting",
  display_name: "Reporting application",
  owner_organization_id: "organization-acme",
  registered_by: { subject_id: "person-admin", evidence_level: "VERIFIED" },
  created_at: 100,
}

function resource(id: string, kind: ResourceRegistration["kind"], name: string): ResourceRegistration {
  return {
    tenant_id: "tenant-acme",
    resource_id: id,
    display_name: name,
    kind,
    owner_organization_id: "organization-acme",
    authentication_strategy: "OAUTH",
    environment_id: "production",
    version: "1.0",
    lifecycle: "PUBLISHED",
    operational_state: "HEALTHY",
    enforcement_point_id: "gateway-acme",
    capabilities: [{ capability_id: "read", display_name: "Read data" }],
    publication_endpoint: { gateway_id: "gateway-acme", hostname: "api.example.test", base_path: "/", visibility: "REQUEST", dns_management: "EXTERNAL", dns_verification: "VERIFIED" },
    created_at: 100,
  }
}

function snapshot(): OverviewSnapshot {
  const data = createMockOverview()
  const api = resource("resource-support", "API", "Support API")
  api.capabilities.push(
    { capability_id: "revoked", display_name: "Revoked data" },
    { capability_id: "expired", display_name: "Expired data" },
    { capability_id: "other", display_name: "Another Application's data" },
  )
  api.api = {
    api_product_id: "support-api",
    openapi_version: "3.1",
    document_title: "Support API",
    document_version: "1.0",
    public_path: "/support",
    inbound_security: { type: "OAUTH2", issuer: "https://identity.example.test", audience: "support-api", jwks_url: "https://identity.example.test/jwks", scope: "genioone:read" },
    request_schema_validation: false,
    operations: [],
  }
  const agent = resource("resource-agent", "API", "Agent API")
  agent.api = { ...api.api, a2a: { protocol_version: "1.0", operation: "SEND_MESSAGE", target_agent_subject_id: "agent-subject" } }
  data.resources = [api, resource("resource-model", "LLM", "Model resource"), resource("resource-mcp", "MCP", "MCP resource"), agent]
  data.applications = [application]
  data.accessRequests = []
  data.ownedEntitlements = data.resources.map((entry) => ({
    entitlement_id: `entitlement-${entry.resource_id}`,
    subject_id: application.subject_id,
    resource_id: entry.resource_id,
    capability_id: "read",
    state: "ACTIVE",
    valid_from: 0,
    valid_until: null,
    revocation_reason: null,
  }))
  data.ownedEntitlements.push(
    { ...data.ownedEntitlements[0]!, entitlement_id: "revoked", capability_id: "revoked", state: "REVOKED" },
    { ...data.ownedEntitlements[0]!, entitlement_id: "expired", capability_id: "expired", valid_until: 1 },
    { ...data.ownedEntitlements[0]!, entitlement_id: "other", capability_id: "other", subject_id: "another-application" },
  )
  return data
}

function apiKeyCredential(overrides: Partial<ApplicationApiCredential> = {}): ApplicationApiCredential {
  return {
    credential_id: "credential-original",
    application_id: application.application_id,
    application_subject_id: application.subject_id,
    resource_id: "resource-support",
    capability_id: "read",
    generation: 1,
    kind: "API_KEY",
    display_name: "Reporting key",
    scopes: ["genioone:read", "genioone:invoke"],
    key_prefix: "genio_app_example",
    expires_at: Math.floor(Date.now() / 1000) + 86_400,
    oauth_client_id: null,
    oauth_issuer: null,
    oauth_audience: null,
    oauth_scope: null,
    state: "ACTIVE",
    created_at: 100,
    activated_at: 100,
    valid_until: null,
    revoked_at: null,
    ...overrides,
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

function installApi(initial: ApplicationApiCredential[] = [], issueFailure?: string, listFailures = 0) {
  const originalFetch = globalThis.fetch
  const writes: Array<{ path: string; body: Record<string, unknown> }> = []
  let credentials = initial.map((entry) => ({ ...entry, scopes: [...entry.scopes] }))
  let listAttempts = 0

  function creation(credential: ApplicationApiCredential): ApplicationApiCredentialCreation {
    return {
      credential,
      api_key: credential.kind === "API_KEY" ? `complete-secret-${credential.credential_id}` : null,
      oauth_client_secret: credential.kind === "OAUTH2" ? `oauth-secret-${credential.credential_id}` : null,
      oauth_token_endpoint: credential.kind === "OAUTH2" ? "https://identity.example.test/token" : null,
      credential_delivery: "ONE_TIME",
    }
  }

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (path.endsWith("/federation-trust-revisions") || path.endsWith("/federation-exchanges")) return json([])
    if (!path.includes("/api-credentials")) return json({})
    if (!init?.method || init.method === "GET") {
      listAttempts += 1
      return listAttempts <= listFailures ? json({ code: "API credential load failed" }, 503) : json(credentials)
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    writes.push({ path, body })
    if (path.endsWith("/rotate")) {
      const predecessor = credentials.find((entry) => path.includes(`/${entry.credential_id}/`))!
      predecessor.state = "RETIRED"
      predecessor.valid_until = Math.floor(Date.now() / 1000) + Number(body.grace_period_seconds)
      const successor = { ...predecessor, credential_id: `credential-${credentials.length + 1}`, generation: predecessor.generation + 1, state: "ACTIVE" as const, valid_until: null }
      credentials = [...credentials, successor]
      return json(creation(successor))
    }
    if (path.endsWith("/revoke")) {
      const credential = credentials.find((entry) => path.includes(`/${entry.credential_id}/`))!
      credential.state = "REVOKED"
      return json(credential)
    }
    if (issueFailure) return json({ code: issueFailure }, 403)
    const credential = apiKeyCredential({
      credential_id: `credential-${credentials.length + 1}`,
      kind: body.kind as ApplicationApiCredential["kind"],
      resource_id: body.resource_id ? String(body.resource_id) : null,
      capability_id: body.capability_id ? String(body.capability_id) : null,
      display_name: body.kind === "API_KEY" ? String(body.display_name) : null,
      scopes: body.kind === "API_KEY" ? body.scopes as string[] : ["genioone:read"],
      expires_at: body.kind === "API_KEY" ? Number(body.expires_at) : null,
      key_prefix: body.kind === "API_KEY" ? "genio_app_example" : null,
      oauth_client_id: body.kind === "OAUTH2" ? "client-reporting" : null,
      oauth_scope: body.kind === "OAUTH2" ? "genioone:read" : null,
    })
    credentials = [...credentials, credential]
    return json(creation(credential))
  }) as typeof fetch
  return { writes, restore: () => { globalThis.fetch = originalFetch } }
}

async function renderSheet(data = snapshot()) {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: adminEnglish } } })
  render(
    <I18nextProvider i18n={i18n}>
      <SheetWorkspaceRoot>
        <ApplicationAccessSheet tenantId="tenant-acme" application={application} data={data} onChanged={async () => {}} />
      </SheetWorkspaceRoot>
    </I18nextProvider>,
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Manage access" }))
  await screen.findByTestId("application-credential-form")
  await waitFor(() => expect(screen.queryByText("Loading credentials…")).toBeNull())
  return user
}

test("Application Platform API key issues selected scopes and clears its one-time secret when the panel closes", async () => {
  const api = installApi()
  try {
    const user = await renderSheet()
    await user.type(screen.getByRole("textbox", { name: "Key name" }), "CLI reporting")
    expect(screen.queryByRole("checkbox", { name: "Invoke GenioOne resources" })).toBeNull()
    await user.click(screen.getByText("Fine-grained management permissions"))
    await user.click(screen.getByRole("checkbox", { name: "Read policies" }))
    const expiry = (screen.getByLabelText("Expires at") as HTMLInputElement).value
    await user.click(screen.getByRole("button", { name: "Issue API key" }))

    const secret = await screen.findByRole("textbox", { name: "One-time API key" }) as HTMLInputElement
    expect(api.writes[0]!.body).toMatchObject({ kind: "API_KEY", display_name: "CLI reporting", scopes: ["genioone:read", "management:policies:read"], expires_at: Math.floor(new Date(expiry).getTime() / 1000) })
    expect(api.writes[0]!.body.resource_id).toBeUndefined()
    expect(api.writes[0]!.body.capability_id).toBeUndefined()
    expect(secret.value).toBe("complete-secret-credential-1")
    expect(screen.getByText("Send this key as an Authorization: Bearer token to Platform APIs.")).toBeTruthy()
    await user.click(screen.getAllByRole("button", { name: "Close" })[0]!)
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "One-time API key" })).toBeNull())
    await user.click(screen.getByRole("button", { name: "Manage access" }))
    await screen.findByText("CLI reporting")
    expect(screen.queryByRole("textbox", { name: "One-time API key" })).toBeNull()
    expect((screen.getByRole("textbox", { name: "Key name" }) as HTMLInputElement).value).toBe("")
    expect(screen.getByText("Key prefix: genio_app_example")).toBeTruthy()
  } finally { api.restore() }
})

test("Resource API keys select only the Application's active API/model Capability and submit a precise target", async () => {
  const api = installApi()
  try {
    const user = await renderSheet()
    await user.type(screen.getByRole("textbox", { name: "Key name" }), "Resource integration")
    await user.click(screen.getByText("Fine-grained management permissions"))
    await user.click(screen.getByRole("checkbox", { name: "Read policies" }))
    await user.click(screen.getByRole("button", { name: "One Resource Capability" }))
    expect(screen.queryByText("Fine-grained management permissions")).toBeNull()
    await user.click(screen.getByRole("combobox", { name: "Authorized Resource / Capability" }))
    expect(await screen.findByRole("option", { name: "Support API · Read data" })).toBeTruthy()
    expect(screen.getByRole("option", { name: "Model resource · Read data" })).toBeTruthy()
    expect(screen.queryByRole("option", { name: /MCP resource|Agent API|Revoked data|Expired data|Another Application's data/ })).toBeNull()
    await user.click(screen.getByRole("option", { name: "Support API · Read data" }))
    expect(screen.getByRole("combobox", { name: "Authorized Resource / Capability" }).textContent).toContain("Support API · Read data")
    await user.click(screen.getByRole("checkbox", { name: "Invoke GenioOne resources" }))
    await user.click(screen.getByRole("button", { name: "Issue API key" }))
    await screen.findByRole("textbox", { name: "One-time API key" })

    expect(api.writes[0]!.body).toMatchObject({ kind: "API_KEY", resource_id: "resource-support", capability_id: "read", scopes: ["genioone:read", "genioone:invoke"] })
    expect(api.writes[0]!.body.scopes).toEqual(["genioone:read", "genioone:invoke"])
    expect(screen.getByText("Send this key in the x-api-key header for the selected Resource.")).toBeTruthy()
    expect(screen.getByText("Resource API key changes are saved. They take effect when the Gateway finishes applying them.")).toBeTruthy()
  } finally { api.restore() }
})

test("Application registration retains the selected Organization name after its menu closes", async () => {
  const data = snapshot()
  const organization = { ...data.organizations[0]!, display_name: "OAuth Consent UAT dedicated organization" }
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: adminEnglish } } })
  render(
    <I18nextProvider i18n={i18n}>
      <SheetWorkspaceRoot><RegisterApplicationSheet tenantId="tenant-acme" organizations={[organization]} onRegistered={async () => {}} /></SheetWorkspaceRoot>
    </I18nextProvider>,
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Register Application" }))
  const selector = screen.getByRole("combobox", { name: "Owner Organization" })
  await user.click(selector)
  await user.click(await screen.findByRole("option", { name: "OAuth Consent UAT dedicated organization" }))
  await waitFor(() => expect(screen.queryByRole("option", { name: "OAuth Consent UAT dedicated organization" })).toBeNull())
  expect(selector.textContent).toContain("OAuth Consent UAT dedicated organization")
  expect(selector.textContent).not.toContain(organization.organization_id)
})

test("API key rotation keeps scope and expiry, then revocation clears the delivered successor secret", async () => {
  const original = apiKeyCredential()
  const api = installApi([original])
  try {
    const user = await renderSheet()
    await user.clear(screen.getByRole("spinbutton", { name: "Old key grace period (seconds)" }))
    await user.type(screen.getByRole("spinbutton", { name: "Old key grace period (seconds)" }), "0")
    await user.click(screen.getByRole("button", { name: "Rotate API key" }))
    await screen.findByRole("textbox", { name: "One-time API key" })
    const successor = await screen.findByTestId("application-credential-credential-2")

    expect(api.writes[0]!.path).toEndWith("/credential-original/rotate")
    expect(api.writes[0]!.body.grace_period_seconds).toBe(0)
    expect(within(successor).getByText("genioone:read genioone:invoke")).toBeTruthy()
    expect(within(successor).getByText(/Expires at:/)).toBeTruthy()
    await user.click(within(successor).getByRole("button", { name: "Revoke" }))
    await waitFor(() => expect(within(successor).getByText("REVOKED")).toBeTruthy())
    expect(api.writes[1]!.path).toEndWith("/credential-2/revoke")
    expect(screen.queryByRole("textbox", { name: "One-time API key" })).toBeNull()
    expect(screen.getByText("Resource API key changes are saved. They take effect when the Gateway finishes applying them.")).toBeTruthy()
  } finally { api.restore() }
})

test("OAuth client issuance and successor rotation remain available for existing OAuth API access", async () => {
  const api = installApi()
  try {
    const user = await renderSheet()
    await user.click(screen.getByRole("button", { name: "OAuth client" }))
    await user.click(screen.getByRole("combobox", { name: "Authorized Resource / Capability" }))
    await user.click(await screen.findByRole("option", { name: "Support API · Read data" }))
    await user.click(screen.getByRole("button", { name: "Issue OAuth client" }))
    await screen.findByRole("textbox", { name: "One-time OAuth client secret" })
    expect(api.writes[0]!.body).toMatchObject({ kind: "OAUTH2", resource_id: "resource-support", capability_id: "read" })
    expect(api.writes[0]!.body.scopes).toBeUndefined()
    expect(screen.getByText("https://identity.example.test/token")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Rotate OAuth client" }))
    await waitFor(() => expect((screen.getByRole("textbox", { name: "One-time OAuth client secret" }) as HTMLInputElement).value).toBe("oauth-secret-credential-2"))
    expect(api.writes[1]!.path).toEndWith("/credential-1/rotate")
  } finally { api.restore() }
})

test("invalid expiry and empty permissions block issuance; a rejected request preserves the API key form", async () => {
  const api = installApi([], "APPLICATION_CREDENTIAL_NOT_ENTITLED")
  try {
    const user = await renderSheet()
    await user.type(screen.getByRole("textbox", { name: "Key name" }), "Keep this name")
    const expiry = screen.getByLabelText("Expires at") as HTMLInputElement
    const originalExpiry = expiry.value
    fireEvent.change(expiry, { target: { value: "2000-01-01T00:00" } })
    expect((screen.getByRole("button", { name: "Issue API key" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("Choose a future expiry no more than one year from now.")).toBeTruthy()
    fireEvent.change(expiry, { target: { value: originalExpiry } })
    await user.click(screen.getByRole("checkbox", { name: "Read your GenioOne data" }))
    expect(screen.getByText("Select at least one permission.")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Issue API key" }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole("checkbox", { name: "Read your GenioOne data" }))
    await user.click(screen.getByRole("button", { name: "Issue API key" }))
    await screen.findByText("Grant this Application an active Entitlement to the selected Capability before issuing a credential.")

    expect((screen.getByRole("textbox", { name: "Key name" }) as HTMLInputElement).value).toBe("Keep this name")
    expect(expiry.value).toBe(originalExpiry)
    expect(screen.queryByRole("textbox", { name: "One-time API key" })).toBeNull()
  } finally { api.restore() }
})

test("credential load failures expose a retry and recover the form", async () => {
  const api = installApi([], undefined, 1)
  try {
    const user = await renderSheet()
    await screen.findByText("API credential load failed")
    await user.click(screen.getByRole("button", { name: "Reload credentials" }))
    await waitFor(() => expect(screen.queryByText("API credential load failed")).toBeNull())
    expect((screen.getByRole("textbox", { name: "Key name" }) as HTMLInputElement).disabled).toBe(false)
  } finally { api.restore() }
})

test("an active Platform API key blocks duplicate issuance while another Resource target remains available", async () => {
  const api = installApi([apiKeyCredential({ resource_id: null, capability_id: null })])
  try {
    const user = await renderSheet()
    await user.type(screen.getByRole("textbox", { name: "Key name" }), "Duplicate platform key")
    expect(screen.getByText("This target already has an active credential of this type. Rotate or revoke it before issuing another.")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Issue API key" }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole("button", { name: "Issue API key" }))
    expect(api.writes).toHaveLength(0)
    expect(screen.getByText("Resource credentials require an active Application Entitlement. Platform API keys use the Application's current role and permissions.")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "One Resource Capability" }))
    await user.click(screen.getByRole("combobox", { name: "Authorized Resource / Capability" }))
    await user.click(await screen.findByRole("option", { name: "Support API · Read data" }))
    expect((screen.getByRole("button", { name: "Issue API key" }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText("This target already has an active credential of this type. Rotate or revoke it before issuing another.")).toBeNull()
  } finally { api.restore() }
})

test("active credential conflicts match the selected kind and Capability and clear after revocation", async () => {
  const api = installApi([apiKeyCredential()])
  try {
    const user = await renderSheet()
    await user.type(screen.getByRole("textbox", { name: "Key name" }), "Replacement resource key")
    await user.click(screen.getByRole("button", { name: "One Resource Capability" }))
    const target = screen.getByRole("combobox", { name: "Authorized Resource / Capability" })
    await user.click(target)
    await user.click(await screen.findByRole("option", { name: "Support API · Read data" }))
    expect((screen.getByRole("button", { name: "Issue API key" }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(target)
    await user.click(await screen.findByRole("option", { name: "Model resource · Read data" }))
    expect((screen.getByRole("button", { name: "Issue API key" }) as HTMLButtonElement).disabled).toBe(false)
    await user.click(screen.getByRole("button", { name: "OAuth client" }))
    await user.click(screen.getByRole("combobox", { name: "Authorized Resource / Capability" }))
    await user.click(await screen.findByRole("option", { name: "Support API · Read data" }))
    expect((screen.getByRole("button", { name: "Issue OAuth client" }) as HTMLButtonElement).disabled).toBe(false)
    const credential = screen.getByTestId("application-credential-credential-original")
    await user.click(within(credential).getByRole("button", { name: "Revoke" }))
    await waitFor(() => expect(within(credential).getByText("REVOKED")).toBeTruthy())
    await user.click(screen.getByRole("button", { name: "API key", exact: true }))
    await user.click(screen.getByRole("combobox", { name: "Authorized Resource / Capability" }))
    await user.click(await screen.findByRole("option", { name: "Support API · Read data" }))
    expect((screen.getByRole("button", { name: "Issue API key" }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText("This target already has an active credential of this type. Rotate or revoke it before issuing another.")).toBeNull()
  } finally { api.restore() }
})
