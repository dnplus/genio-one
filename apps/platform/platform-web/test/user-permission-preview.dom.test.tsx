import { expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import type { OverviewSnapshot } from "@/domain/contracts"
import { UserPermissionPreviewDialog } from "@/features/policy/user-permission-preview"

const data = {
  identity: {
    tenant_id: "tenant-acme",
    subjects: [{
      subject_id: "subject-ada",
      kind: "PERSON",
      profile: { display_name: "Ada Lovelace", email: "ada@example.test", department: null },
      suspended: false,
      suspended_at: null,
      suspended_by: null,
      suspension_reason: null,
    }],
    external_identity_bindings: [],
    tenant_administrators: ["subject-admin"],
  },
  runtimes: [],
  applications: [],
  resources: [],
  accessGroups: {
    tenant_id: "tenant-acme",
    groups: [{
      tenant_id: "tenant-acme",
      organization_id: null,
      access_group_id: "engineering",
      display_name: "Engineering",
      description: "Engineering team",
      enabled: true,
      revision: 1,
      membership_sources: [],
      created_at: 1,
      created_by: "subject-admin",
      updated_at: 1,
      updated_by: "subject-admin",
    }],
    memberships: [],
  },
} as OverviewSnapshot

function response(accessGroupIds: string[]) {
  return {
    subject_id: "subject-ada",
    subject_display_name: "Ada Lovelace",
    actor_subject_id: "subject-admin",
    role: "USER",
    organization_ids: ["organization-acme"],
    access_group_ids: accessGroupIds,
    runtime_id: "codex",
    client_id: "genio-one-bot",
    bot_id: "genio.personal-bot",
    evaluated_at: 100,
    capabilities: [],
    bot_access: { decision: "ALLOW", reason_code: "BOT_ACCESS_ALLOWED", policy_id: "one-policy.first-party.bot-default", policy_revision: 1 },
    runtime_decisions: [],
  }
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
}

async function renderPreview() {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  render(
    <I18nextProvider i18n={i18n}>
      <UserPermissionPreviewDialog data={data} onClose={() => {}} tenantId="tenant-acme" />
    </I18nextProvider>,
  )
}

async function chooseAdaAndPreview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("combobox", { name: "Search people and subjects" }))
  await user.click(await screen.findByRole("option", { name: /Ada Lovelace/ }))
  await user.click(screen.getByRole("button", { name: "Preview permissions" }))
}

test("Permission Preview shows server-resolved Access Group display names without sending group IDs in the request", async () => {
  const originalFetch = globalThis.fetch
  const user = userEvent.setup()
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return json(response(["engineering"]))
  }) as typeof fetch

  try {
    await renderPreview()
    await chooseAdaAndPreview(user)

    await waitFor(() => expect(screen.getByText("Resolved access groups")).toBeTruthy())
    expect(screen.getByText("Engineering")).toBeTruthy()
    expect(screen.getByText("These groups are resolved by the server for this preview and are not supplied by the request.")).toBeTruthy()
    expect(requests).toEqual([{
      subject_id: "subject-ada",
      runtime_id: "codex",
      client_id: "genio-one-bot",
      bot_id: "genio.personal-bot",
    }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Permission Preview states when the server resolved no Access Groups", async () => {
  const originalFetch = globalThis.fetch
  const user = userEvent.setup()
  globalThis.fetch = (async () => json(response([]))) as typeof fetch

  try {
    await renderPreview()
    await chooseAdaAndPreview(user)

    await waitFor(() => expect(screen.getByText("Resolved access groups")).toBeTruthy())
    expect(screen.getByText("None")).toBeTruthy()
  } finally {
    globalThis.fetch = originalFetch
  }
})
