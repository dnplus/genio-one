import { expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"
import { useState } from "react"

import { RuntimeCapabilityGroups } from "@/features/policy/runtime-capability-groups"
import { RuntimePolicyEditor } from "@/features/policy/RuntimePolicyEditor"
import type { OverviewSnapshot } from "@/domain/contracts"
import type { PolicyDraftView, RuntimePolicyDefinition, RuntimePolicyRule } from "@/lib/product-api"

const useRule: RuntimePolicyRule = {
  rule_id: "hands-use",
  group_id: "hands-use",
  target: { runtime_id: "codex", capability_id: "remote_hands.use" },
  actions: ["use"],
  effect: "ALLOW",
  constraints: [],
  obligations: [],
}

async function mount(initial: RuntimePolicyRule, onRulesChange: (rules: RuntimePolicyRule[]) => void) {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  function Harness() {
    const [rules, setRules] = useState([initial])
    return <RuntimeCapabilityGroups
      rules={rules}
      scopeRuntimeIds={["codex"]}
      runtimeOptions={[{ value: "codex", label: "Codex" }]}
      capabilityOptions={[{ value: "remote_hands.use", label: "Remote hands" }]}
      disabled={false}
      onChange={(next) => { setRules(next); onRulesChange(next) }}
    />
  }
  return render(<I18nextProvider i18n={i18n}><Harness /></I18nextProvider>)
}

test("a combined expose/use rule cannot set execution location through the control", async () => {
  const user = userEvent.setup()
  let changed: RuntimePolicyRule[] | null = null
  await mount({ ...useRule, actions: ["expose", "use"] }, (rules) => { changed = rules })
  const location = screen.getByRole("combobox", { name: "Execution location" })
  expect(location.hasAttribute("disabled")).toBe(true)
  expect(screen.getByText("Execution location needs its own ALLOW use rule. Put discovery permission in a separate rule.")).toBeTruthy()
  await user.click(location)
  expect(changed).toBeNull()
})

test("a standalone ALLOW use rule selects a domain and reloads that value", async () => {
  const user = userEvent.setup()
  let changed: RuntimePolicyRule[] | null = null
  const mounted = await mount(useRule, (rules) => { changed = rules })
  const location = screen.getByRole("combobox", { name: "Execution location" })
  expect(location.hasAttribute("disabled")).toBe(false)
  await user.click(location)
  await user.click(await screen.findByRole("option", { name: "Managed cloud" }))
  await waitFor(() => expect(changed?.[0]?.constraints).toEqual([{ kind: "execution_placement", parameters: { execution_domain: "MANAGED_CLOUD" } }]))
  expect(changed?.[0]?.actions).toEqual(["use"])
  mounted.unmount()
  await mount(changed![0]!, () => {})
  expect(screen.getByRole("combobox", { name: "Execution location" }).textContent).toContain("Managed cloud")
})

test("the policy editor saves and reopens a standalone use placement rule", async () => {
  const originalFetch = globalThis.fetch
  const user = userEvent.setup()
  const definition: RuntimePolicyDefinition = {
    display_name: "Hands placement",
    scope: { subject_ids: ["subject-admin"], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] },
    rules: [useRule],
  }
  let current: PolicyDraftView = {
    policy_key: "hands-placement",
    version: 1,
    base_revision: 0,
    lifecycle: "DRAFT",
    content_digest: "a".repeat(64),
    created_by_subject_id: "subject-admin",
    created_at: 100,
    updated_by_subject_id: "subject-admin",
    updated_at: 100,
    validation: null,
    review: null,
    content: { kind: "RUNTIME_CAPABILITY", definition },
  }
  const data = {
    applications: [],
    organizations: [],
    resources: [],
    accessGroups: { groups: [] },
    identity: { subjects: [{ subject_id: "subject-admin", kind: "PERSON", profile: { display_name: "Admin", email: "admin@example.test" } }] },
  } as unknown as OverviewSnapshot
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/revisions")) return new Response(JSON.stringify([]), { status: 200 })
    if (url.endsWith("/draft") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { content: PolicyDraftView["content"] }
      current = { ...current, version: current.version + 1, content: body.content }
      return new Response(JSON.stringify(current), { status: 200 })
    }
    if (url.endsWith("/draft")) return new Response(JSON.stringify(current), { status: 200 })
    return new Response(JSON.stringify({}), { status: 200 })
  }) as typeof fetch
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  const editor = () => <I18nextProvider i18n={i18n}><RuntimePolicyEditor tenantId="tenant-acme" policy={null} policyId="hands-placement" canEdit data={data} onPublished={async () => {}} /></I18nextProvider>

  try {
    const mounted = render(editor())
    const location = await screen.findByRole("combobox", { name: "Execution location" })
    await user.click(location)
    await user.click(await screen.findByRole("option", { name: "Managed cloud" }))
    await user.click(screen.getByRole("button", { name: "Save draft" }))
    await waitFor(() => expect(current.content.kind === "RUNTIME_CAPABILITY" && current.content.definition.rules[0]?.constraints).toEqual([{ kind: "execution_placement", parameters: { execution_domain: "MANAGED_CLOUD" } }]))
    mounted.unmount()
    render(editor())
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Execution location" }).textContent).toContain("Managed cloud"))
  } finally {
    globalThis.fetch = originalFetch
  }
})
