import { expect, test } from "bun:test"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { SheetWorkspaceRoot } from "@/components/ui/sheet"
import { ApiRequestMappingSheet } from "@/features/connections/api-request-mapping-sheet"
import productI18n from "@/i18n"
import { createMockOverview } from "@/mocks/overview"

const locales = [
  { language: "en", firstEmpty: "Remove rule 1: unnamed", secondEmpty: "Remove rule 2: unnamed", firstNamed: "Remove rule 1: x-region", secondNamed: "Remove rule 2: x-region" },
  { language: "zh-TW", firstEmpty: "移除第 1 列規則：未命名", secondEmpty: "移除第 2 列規則：未命名", firstNamed: "移除第 1 列規則：x-region", secondNamed: "移除第 2 列規則：x-region" },
] as const

for (const locale of locales) {
  test("request mapping identifies empty and duplicate rules and saves the selected removal in " + locale.language, async () => {
    const user = userEvent.setup()
    const i18n = createInstance()
    await i18n.init({ lng: locale.language, fallbackLng: "en", keySeparator: false, resources: productI18n.options.resources })
    const data = createMockOverview()
    const resource = data.resources.find((candidate) => candidate.kind === "API")!
    const connection = data.connections.find((candidate) => candidate.resource_id === resource.resource_id)!
    const originalFetch = globalThis.fetch
    const requests: Array<{ method: string; path: string; body: unknown }> = []
    let updated = 0
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      const method = input instanceof Request ? input.method : init?.method ?? "GET"
      const body = input instanceof Request ? await input.clone().text() : String(init?.body ?? "")
      requests.push({ method, path: new URL(url, "http://localhost").pathname, body: JSON.parse(body) })
      return new Response(JSON.stringify(connection), { headers: { "content-type": "application/json" } })
    }) as typeof fetch

    try {
      render(
        <I18nextProvider i18n={i18n}>
          <SheetWorkspaceRoot>
            <ApiRequestMappingSheet tenantId="tenant-design-preview" resource={resource} connection={connection} onUpdated={async () => { updated += 1 }} />
          </SheetWorkspaceRoot>
        </I18nextProvider>,
      )
      await user.click(screen.getByRole("button", { name: i18n.t("Configure request mapping") }))
      await user.click(await screen.findByRole("button", { name: i18n.t("Add rule") }))
      await user.click(screen.getByRole("button", { name: i18n.t("Add rule") }))

      expect(screen.getByRole("button", { name: locale.firstEmpty })).toBeTruthy()
      expect(screen.getByRole("button", { name: locale.secondEmpty })).toBeTruthy()
      const parameters = screen.getAllByRole("textbox", { name: i18n.t("Provider-specific parameter") })
      fireEvent.change(parameters[0]!, { target: { value: "x-region" } })
      fireEvent.change(parameters[1]!, { target: { value: "x-region" } })
      const values = screen.getAllByRole("textbox", { name: i18n.t("Override value") })
      fireEvent.change(values[0]!, { target: { value: "us-east" } })
      fireEvent.change(values[1]!, { target: { value: "us-west" } })

      expect(screen.getByRole("button", { name: locale.firstNamed })).toBeTruthy()
      await user.click(screen.getByRole("button", { name: locale.secondNamed }))
      expect(screen.queryByRole("button", { name: locale.secondNamed })).toBeNull()
      expect((screen.getByRole("textbox", { name: i18n.t("Override value") }) as HTMLInputElement).value).toBe("us-east")
      await user.click(screen.getByRole("button", { name: i18n.t("Save request mapping") }))

      await waitFor(() => expect(updated).toBe(1))
      expect(requests).toEqual([{
        method: "PATCH",
        path: "/v1/tenants/tenant-design-preview/resources/" + resource.resource_id + "/connections/" + connection.connection_id,
        body: {
          expected_revision: connection.configuration_revision,
          request_mapping: {
            default_action: "PASSTHROUGH",
            rules: [{ operation_id: resource.api!.operations[0]!.operation_id, location: "HEADER", name: "x-region", action: "SET", value: "us-east" }],
          },
        },
      }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}
