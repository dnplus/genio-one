import { expect, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createColumnHelper } from "@tanstack/react-table"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { TableView } from "@/components/data-table/data-table"
import type { DataTableFeatures } from "@/components/data-table/data-table-features"

type Row = { id: string; name: string; kind: string }
const columnHelper = createColumnHelper<DataTableFeatures, Row>()
const columns = columnHelper.columns([
  columnHelper.accessor("name", { header: "Name" }),
  columnHelper.accessor("kind", { header: "Kind" }),
  columnHelper.display({ id: "source", header: "Source", cell: () => "static", enableSorting: false }),
])

// Screen readers learn a column's sort state only from aria-sort on its <th>;
// per the WAI-ARIA sortable-table pattern only the actively sorted header
// carries it. The toggle button keeps the visible column title as its name.
test("sortable headers expose aria-sort that follows the sort toggle", async () => {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  render(
    <I18nextProvider i18n={i18n}>
      <TableView
        columns={columns}
        data={[{ id: "1", name: "beta", kind: "api" }, { id: "2", name: "alpha", kind: "mcp" }]}
        getRowId={(row) => row.id}
        noResults="No results."
      />
    </I18nextProvider>,
  )

  const nameHeader = screen.getByRole("columnheader", { name: "Name" })
  const kindHeader = screen.getByRole("columnheader", { name: "Kind" })
  const sourceHeader = screen.getByRole("columnheader", { name: "Source" })
  expect(nameHeader.hasAttribute("aria-sort")).toBe(false)
  expect(sourceHeader.hasAttribute("aria-sort")).toBe(false)

  const user = userEvent.setup()
  const toggle = screen.getByRole("button", { name: "Name" })
  await user.click(toggle)
  expect(nameHeader.getAttribute("aria-sort")).toBe("ascending")
  expect(kindHeader.hasAttribute("aria-sort")).toBe(false)
  await user.click(toggle)
  expect(nameHeader.getAttribute("aria-sort")).toBe("descending")
  expect(sourceHeader.hasAttribute("aria-sort")).toBe(false)

  // Sorting another column moves aria-sort there; the previous header drops it.
  await user.click(screen.getByRole("button", { name: "Kind" }))
  expect(kindHeader.getAttribute("aria-sort")).toBe("ascending")
  expect(nameHeader.hasAttribute("aria-sort")).toBe(false)
})
