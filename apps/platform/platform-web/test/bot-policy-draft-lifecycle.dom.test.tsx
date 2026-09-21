import { expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import type { BotPolicyRules, OnePolicyBotSeed, OverviewSnapshot } from "@/domain/contracts"
import { BotPolicyEditor } from "@/features/policy/bot-policy-editor"
import type { PolicyDraftView } from "@/lib/product-api"

const policy: OnePolicyBotSeed = {
  tenant_id: "tenant-acme",
  policy_id: "one-policy.first-party.bot-default",
  policy_revision: 7,
  rules: { allowed_roles: [], allowed_subject_ids: [] },
  seed: true,
  enabled: true,
  created_at: 1,
  updated_at: 1,
}

const data = {
  identity: {
    tenant_id: "tenant-acme",
    subjects: [{
      subject_id: "subject-admin",
      kind: "PERSON",
      profile: { display_name: "Admin", email: "admin@example.test", department: null },
      suspended: false,
      suspended_at: null,
      suspended_by: null,
      suspension_reason: null,
    }],
    external_identity_bindings: [],
    tenant_administrators: ["subject-admin"],
  },
} as OverviewSnapshot

function draft(lifecycle: PolicyDraftView["lifecycle"] = "DRAFT"): PolicyDraftView {
  return {
    policy_key: "first-party-bot",
    version: 3,
    base_revision: 7,
    lifecycle,
    content_digest: "a".repeat(64),
    created_by_subject_id: "subject-admin",
    created_at: 100,
    updated_by_subject_id: "subject-admin",
    updated_at: 100,
    validation: lifecycle === "DRAFT" ? null : {
      actor_subject_id: "subject-admin",
      at: 110,
      content_digest: "a".repeat(64),
      correlation_id: "validation-1",
    },
    review: lifecycle === "REVIEWED" ? {
      actor_subject_id: "subject-admin",
      at: 120,
      content_digest: "a".repeat(64),
      correlation_id: "review-1",
    } : null,
    content: { kind: "BOT_ACCESS", definition: { allowed_roles: [], allowed_subject_ids: [] } },
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

async function renderEditor(onPublished = async () => {}) {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  render(
    <I18nextProvider i18n={i18n}>
      <BotPolicyEditor canEdit data={data} onPublished={onPublished} policy={policy} tenantId="tenant-acme" />
    </I18nextProvider>,
  )
}

test("Bot policy draft follows the server-persisted validate, review, and publish lifecycle", async () => {
  const originalFetch = globalThis.fetch
  const user = userEvent.setup()
  let current = draft()
  let published = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith("/validate")) {
      current = draft("VALIDATED")
      return json(current)
    }
    if (url.endsWith("/review")) {
      current = draft("REVIEWED")
      return json(current)
    }
    if (url.endsWith("/publish")) return json({ policy_revision: 8 })
    if (url.endsWith("/revisions")) return json([])
    if (url.endsWith("/draft")) return json(current)
    return json({})
  }) as typeof fetch

  try {
    await renderEditor(async () => { published += 1 })

    await screen.findByTestId("bot-policy-draft-lifecycle")
    const validate = screen.getByRole("button", { name: "Validate saved draft" })
    const review = screen.getByRole("button", { name: "Review saved draft" })
    const publish = screen.getByRole("button", { name: "Publish saved draft" })
    expect(validate.hasAttribute("disabled")).toBeFalse()
    expect(review.hasAttribute("disabled")).toBeTrue()
    expect(publish.hasAttribute("disabled")).toBeTrue()

    await user.click(validate)
    await waitFor(() => expect(screen.getByText(/Validated by Admin/)).toBeTruthy())
    expect(review.hasAttribute("disabled")).toBeFalse()

    await user.click(review)
    await waitFor(() => expect(screen.getByText("Self-reviewed")).toBeTruthy())
    expect(publish.hasAttribute("disabled")).toBeFalse()

    await user.click(publish)
    await waitFor(() => expect(published).toBe(1))
    expect(screen.queryByTestId("bot-policy-draft-lifecycle")).toBeNull()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Bot policy saves computer environment approval through validation, review, and publishing", async () => {
  const originalFetch = globalThis.fetch
  const user = userEvent.setup()
  let current = draft()
  let savedDefinition: Record<string, unknown> | null = null
  const transitions: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/revisions")) return json([{ policy_revision: 6, rules: { allowed_roles: [], allowed_subject_ids: [], computer_use_enabled: true }, published_by: null, published_at: 100 }])
    if (url.endsWith("/draft") && init?.method === "PUT") {
      const payload = JSON.parse(String(init.body)) as { content: { definition: Record<string, unknown> } }
      savedDefinition = payload.content.definition
      current = { ...current, content: { kind: "BOT_ACCESS", definition: payload.content.definition as BotPolicyRules } }
      return json(current)
    }
    if (url.endsWith("/validate")) {
      transitions.push("validate")
      current = { ...current, lifecycle: "VALIDATED", validation: { actor_subject_id: "subject-admin", at: 110, content_digest: current.content_digest, correlation_id: "validation-1" } }
      return json(current)
    }
    if (url.endsWith("/review")) {
      transitions.push("review")
      current = { ...current, lifecycle: "REVIEWED", review: { actor_subject_id: "subject-admin", at: 120, content_digest: current.content_digest, correlation_id: "review-1" } }
      return json(current)
    }
    if (url.endsWith("/publish")) {
      transitions.push("publish")
      return json({ policy_revision: 8 })
    }
    if (url.endsWith("/draft")) return json(current)
    return json({})
  }) as typeof fetch

  try {
    await renderEditor()
    await screen.findByTestId("bot-policy-draft-lifecycle")
    const computerUse = screen.getByRole("checkbox", { name: "Allow use of a computer environment" })
    expect(computerUse.getAttribute("aria-disabled")).toBe("true")
    expect(computerUse.getAttribute("aria-checked")).toBe("false")
    await user.click(screen.getByText("Revision history"))
    expect(document.body.textContent).toContain("Computer environment enabled")

    await user.click(screen.getByRole("button", { name: "Edit policy" }))
    await user.click(computerUse)
    await user.click(screen.getByRole("button", { name: "Save draft" }))
    await waitFor(() => expect(savedDefinition).toMatchObject({ computer_use_enabled: true }))

    await user.click(screen.getByRole("button", { name: "Validate saved draft" }))
    await user.click(screen.getByRole("button", { name: "Review saved draft" }))
    await user.click(screen.getByRole("button", { name: "Publish saved draft" }))
    await waitFor(() => expect(transitions).toEqual(["validate", "review", "publish"]))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Bot policy draft conflict preserves form edits until an explicit reload", async () => {
  const originalFetch = globalThis.fetch
  const user = userEvent.setup()
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/revisions")) return json([])
    if (url.endsWith("/draft") && init?.method === "PUT") return json({ code: "POLICY_DRAFT_CONFLICT" }, 409)
    if (url.endsWith("/draft")) return json(draft())
    return json({})
  }) as typeof fetch

  try {
    await renderEditor()

    await screen.findByTestId("bot-policy-draft-lifecycle")
    await user.click(screen.getByRole("button", { name: "Edit policy" }))
    const administrator = screen.getByRole("checkbox", { name: "TENANT_ADMINISTRATOR" })
    await user.click(administrator)
    await user.click(screen.getByRole("button", { name: "Save draft" }))

    await waitFor(() => expect(screen.getByText("This draft changed on the server. Reload it before continuing.")).toBeTruthy())
    expect(administrator.getAttribute("aria-checked")).toBe("true")
    expect(screen.getByRole("button", { name: "Reload saved draft" })).toBeTruthy()
  } finally {
    globalThis.fetch = originalFetch
  }
})
