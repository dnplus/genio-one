import { expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { SheetWorkspaceRoot } from "@/components/ui/sheet"
import type { ResourceRegistration, TenantIdentityInventory } from "@/domain/contracts"
import { GrantEntitlementSheet } from "@/features/access/grant-entitlement-sheet"

const resource: ResourceRegistration = {
  tenant_id: "tenant-acme",
  resource_id: "resource-support",
  display_name: "Published support resource",
  kind: "MCP",
  owner_organization_id: "organization-acme",
  authentication_strategy: "NONE",
  environment_id: "environment-prod",
  version: "1.0.0",
  lifecycle: "PUBLISHED",
  operational_state: "HEALTHY",
  capabilities: [
    { capability_id: "ticket.already-granted", display_name: "Already granted capability" },
    { capability_id: "ticket.available", display_name: "Available capability" },
    { capability_id: "ticket.revoked", display_name: "Revoked capability" },
    { capability_id: "ticket.granted-to-other", display_name: "Granted to another subject" },
  ],
  enforcement_point_id: "gateway-acme",
  created_at: 100,
}

const otherResource: ResourceRegistration = {
  ...resource,
  resource_id: "resource-operations",
  display_name: "Published operations resource",
  capabilities: [
    { capability_id: "operations.available", display_name: "Operations capability" },
  ],
}

const identity: TenantIdentityInventory = {
  tenant_id: "tenant-acme",
  subjects: [
    {
      subject_id: "subject-ada",
      kind: "PERSON",
      profile: { display_name: "Ada Lovelace", email: "ada@example.test", department: null },
      suspended: false,
      suspended_at: null,
      suspended_by: null,
      suspension_reason: null,
    },
  ],
  external_identity_bindings: [],
  tenant_administrators: ["subject-admin"],
}

const loadResource = async () => [resource]

test("Grant Entitlement lists every published capability for the selected Resource", async () => {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  const user = userEvent.setup()

  render(
    <I18nextProvider i18n={i18n}>
      <SheetWorkspaceRoot>
        <GrantEntitlementSheet
          tenantId="tenant-acme"
          identity={identity}
          loadResources={loadResource}
          onGranted={async () => {}}
        />
      </SheetWorkspaceRoot>
    </I18nextProvider>,
  )

  await user.click(screen.getByRole("button", { name: "Grant Entitlement" }))
  await user.click(screen.getByRole("combobox", { name: "Search Subjects" }))
  await user.click(await screen.findByRole("option", { name: /Ada Lovelace/ }))
  await user.click(screen.getByRole("combobox", { name: "Search Resources" }))
  await user.click(await screen.findByRole("option", { name: /Published support resource/ }))
  await user.click(screen.getByRole("combobox", { name: "Search Capabilities" }))

  await waitFor(() => expect(screen.getByRole("option", { name: /Available capability/ })).toBeTruthy())
  expect(screen.getByRole("option", { name: /Already granted capability/ })).toBeTruthy()
  expect(screen.getByRole("option", { name: /Revoked capability/ })).toBeTruthy()
  expect(screen.getByRole("option", { name: /Granted to another subject/ })).toBeTruthy()
})

test("Grant Entitlement does not retain an empty capability search after reopening", async () => {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  const user = userEvent.setup()

  render(
    <I18nextProvider i18n={i18n}>
      <SheetWorkspaceRoot>
        <GrantEntitlementSheet
          tenantId="tenant-acme"
          identity={identity}
          loadResources={loadResource}
          onGranted={async () => {}}
        />
      </SheetWorkspaceRoot>
    </I18nextProvider>,
  )

  await user.click(screen.getByRole("button", { name: "Grant Entitlement" }))
  await user.click(screen.getByRole("combobox", { name: "Search Subjects" }))
  await user.click(await screen.findByRole("option", { name: /Ada Lovelace/ }))
  await user.click(screen.getByRole("combobox", { name: "Search Resources" }))
  await user.click(await screen.findByRole("option", { name: /Published support resource/ }))
  const capabilities = screen.getByRole("combobox", { name: "Search Capabilities" })
  await user.click(capabilities)
  await user.type(capabilities, "missing capability")
  await waitFor(() => expect(screen.getByText("No Capabilities found.")).toBeTruthy())
  await user.keyboard("{Escape}")
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  await user.click(screen.getByRole("button", { name: "Grant Entitlement" }))
  await user.click(screen.getByRole("combobox", { name: "Search Subjects" }))
  await user.click(await screen.findByRole("option", { name: /Ada Lovelace/ }))
  await user.click(screen.getByRole("combobox", { name: "Search Resources" }))
  await user.click(await screen.findByRole("option", { name: /Published support resource/ }))
  await user.click(screen.getByRole("combobox", { name: "Search Capabilities" }))

  await waitFor(() => expect(screen.getByRole("option", { name: /Available capability/ })).toBeTruthy())
})

test("Grant Entitlement clears a no-result capability query when its Resource changes", async () => {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  const user = userEvent.setup()

  render(
    <I18nextProvider i18n={i18n}>
      <SheetWorkspaceRoot>
        <GrantEntitlementSheet
          tenantId="tenant-acme"
          identity={identity}
          loadResources={async () => [resource, otherResource]}
          onGranted={async () => {}}
        />
      </SheetWorkspaceRoot>
    </I18nextProvider>,
  )

  await user.click(screen.getByRole("button", { name: "Grant Entitlement" }))
  await user.click(screen.getByRole("combobox", { name: "Search Subjects" }))
  await user.click(await screen.findByRole("option", { name: /Ada Lovelace/ }))
  await user.click(screen.getByRole("combobox", { name: "Search Resources" }))
  await user.click(await screen.findByRole("option", { name: /Published support resource/ }))
  const capabilities = screen.getByRole("combobox", { name: "Search Capabilities" })
  await user.click(capabilities)
  await user.type(capabilities, "missing capability")
  await waitFor(() => expect(screen.getByText("No Capabilities found.")).toBeTruthy())
  await user.keyboard("{Escape}")
  await user.click(screen.getByRole("combobox", { name: "Search Resources" }))
  await user.click(await screen.findByRole("option", { name: /Published operations resource/ }))
  await user.click(screen.getByRole("combobox", { name: "Search Capabilities" }))

  await waitFor(() => expect(screen.getByRole("option", { name: /Operations capability/ })).toBeTruthy())
})

test("Grant Entitlement refreshes a stale Resource inventory before choosing a Capability", async () => {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  const user = userEvent.setup()
  let loads = 0

  render(
    <I18nextProvider i18n={i18n}>
      <SheetWorkspaceRoot>
        <GrantEntitlementSheet
          tenantId="tenant-acme"
          identity={identity}
          loadResources={async () => {
            loads += 1
            return [resource]
          }}
          onGranted={async () => {}}
        />
      </SheetWorkspaceRoot>
    </I18nextProvider>,
  )

  await user.click(screen.getByRole("button", { name: "Grant Entitlement" }))
  await waitFor(() => expect(loads).toBe(1))
  await user.click(screen.getByRole("combobox", { name: "Search Subjects" }))
  await user.click(await screen.findByRole("option", { name: /Ada Lovelace/ }))
  await user.click(screen.getByRole("combobox", { name: "Search Resources" }))
  await user.click(await screen.findByRole("option", { name: /Published support resource/ }))
  await user.click(screen.getByRole("combobox", { name: "Search Capabilities" }))

  await waitFor(() => expect(screen.getByRole("option", { name: /Available capability/ })).toBeTruthy())
})

test("Grant Entitlement reports an unavailable Resource inventory instead of an empty Capability list", async () => {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  const user = userEvent.setup()

  render(
    <I18nextProvider i18n={i18n}>
      <SheetWorkspaceRoot>
        <GrantEntitlementSheet
          tenantId="tenant-acme"
          identity={identity}
          loadResources={async () => { throw new Error("RESOURCE_INVENTORY_UNAVAILABLE") }}
          onGranted={async () => {}}
        />
      </SheetWorkspaceRoot>
    </I18nextProvider>,
  )

  await user.click(screen.getByRole("button", { name: "Grant Entitlement" }))

  await waitFor(() => expect(screen.getByText("RESOURCE_INVENTORY_UNAVAILABLE")).toBeTruthy())
  expect(screen.queryByRole("combobox", { name: "Search Resources" })).toBeNull()
  expect(screen.queryByText("No Capabilities found.")).toBeNull()
})

test("Grant Entitlement reuses a retry identity only while its selected payload is unchanged", async () => {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  const user = userEvent.setup()
  const originalFetch = globalThis.fetch
  const requestIds: string[] = []
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestIds.push(new Headers(init?.headers).get("idempotency-key") ?? "")
    return new Response("{}", { headers: { "content-type": "application/json" }, status: 201 })
  }) as typeof fetch

  try {
    render(
      <I18nextProvider i18n={i18n}>
        <SheetWorkspaceRoot>
          <GrantEntitlementSheet
            tenantId="tenant-acme"
            identity={identity}
            loadResources={loadResource}
            onGranted={async () => { throw new Error("REFRESH_FAILED") }}
          />
        </SheetWorkspaceRoot>
      </I18nextProvider>,
    )

    await user.click(screen.getByRole("button", { name: "Grant Entitlement" }))
    await user.click(screen.getByRole("combobox", { name: "Search Subjects" }))
    await user.click(await screen.findByRole("option", { name: /Ada Lovelace/ }))
    await user.click(screen.getByRole("combobox", { name: "Search Resources" }))
    await user.click(await screen.findByRole("option", { name: /Published support resource/ }))
    await user.click(screen.getByRole("combobox", { name: "Search Capabilities" }))
    await user.click(await screen.findByRole("option", { name: /Already granted capability/ }))

    const submit = () => user.click(screen.getAllByRole("button", { name: "Grant Entitlement" }).at(-1)!)
    await submit()
    await waitFor(() => expect(screen.getByText("REFRESH_FAILED")).toBeTruthy())
    await submit()
    await waitFor(() => expect(requestIds).toHaveLength(2))

    await user.click(screen.getByRole("combobox", { name: "Search Capabilities" }))
    await user.click(await screen.findByRole("option", { name: /Available capability/ }))
    await submit()
    await waitFor(() => expect(requestIds).toHaveLength(3))

    expect(requestIds[0]).toBeTruthy()
    expect(requestIds[1]).toBe(requestIds[0])
    expect(requestIds[2]).not.toBe(requestIds[0])
  } finally {
    globalThis.fetch = originalFetch
  }
})
