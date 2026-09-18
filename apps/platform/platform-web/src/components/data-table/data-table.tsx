import {
  type ColumnDef,
  type ColumnFiltersState,
  type PaginationState,
  type RowData,
  type SortingState,
  useTable,
} from "@tanstack/react-table"
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

import { dataTableFeatures, type DataTableFeatures } from "./data-table-features"
import { RecordFilterBar } from "./record-filter-bar"

export interface DataTableFilter {
  columnId: string
  label: string
  allLabel: string
  options: Array<{ label: string; value: string }>
}

export interface TableViewProps<TData extends RowData> {
  stateKey?: string
  columns: ColumnDef<DataTableFeatures, TData>[]
  data: TData[]
  filters?: DataTableFilter[]
  initialFilterValues?: Record<string, string>
  initialGlobalFilter?: string
  getRowId: (row: TData) => string
  getRowLabel?: (row: TData) => string
  getRowTestId?: (row: TData) => string
  noResults: ReactNode
  onRowClick?: (row: TData) => void
  onFilterStateChange?: (state: { filters: Record<string, string>; query: string }) => void
  pageSize?: number
  searchPlaceholder?: string
}

export function TableView<TData extends RowData>({
  stateKey,
  columns,
  data,
  filters = [],
  initialFilterValues = {},
  initialGlobalFilter = "",
  getRowId,
  getRowLabel,
  getRowTestId,
  noResults,
  onRowClick,
  onFilterStateChange,
  pageSize = 10,
  searchPlaceholder,
}: TableViewProps<TData>) {
  const { t } = useTranslation()
  const [restored] = useState(() => {
    try { return stateKey ? JSON.parse(sessionStorage.getItem(`genio.table.v1:${stateKey}`) ?? "null") : null }
    catch { return null }
  })
  const [sorting, setSorting] = useState<SortingState>(restored?.sorting ?? [])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(() =>
    restored?.columnFilters ?? Object.entries(initialFilterValues)
      .filter(([, value]) => value && value !== "ALL")
      .map(([id, value]) => ({ id, value })),
  )
  const [globalFilter, setGlobalFilter] = useState(restored?.globalFilter ?? initialGlobalFilter)
  const [pagination, setPagination] = useState<PaginationState>(restored?.pagination ?? { pageIndex: 0, pageSize })
  const table = useTable({
    columns,
    data,
    features: dataTableFeatures,
    getRowId,
    globalFilterFn: "includesString",
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    state: { columnFilters, globalFilter, pagination, sorting },
  })
  const filteredRows = table.getFilteredRowModel().rows.length
  const firstRow = filteredRows ? pagination.pageIndex * pagination.pageSize + 1 : 0
  const lastRow = Math.min((pagination.pageIndex + 1) * pagination.pageSize, filteredRows)

  useEffect(() => {
    const lastPage = Math.max(0, Math.ceil(filteredRows / pagination.pageSize) - 1)
    if (pagination.pageIndex > lastPage) setPagination((current) => ({ ...current, pageIndex: lastPage }))
  }, [filteredRows, pagination.pageIndex, pagination.pageSize])

  useEffect(() => {
    if (!stateKey) return
    try { sessionStorage.setItem(`genio.table.v1:${stateKey}`, JSON.stringify({ sorting, columnFilters, globalFilter, pagination })) }
    catch {}
  }, [stateKey, sorting, columnFilters, globalFilter, pagination])

  useEffect(() => {
    onFilterStateChange?.({
      filters: Object.fromEntries(columnFilters.map((filter) => [filter.id, String(filter.value)])),
      query: globalFilter,
    })
  }, [columnFilters, globalFilter, onFilterStateChange])

  return (
    <div className="flex flex-col gap-3">
      {searchPlaceholder || filters.length ?
        <RecordFilterBar
          query={globalFilter}
          onQueryChange={(nextQuery) => {
            setGlobalFilter(nextQuery)
            setPagination((current) => ({ ...current, pageIndex: 0 }))
          }}
          searchPlaceholder={searchPlaceholder}
          filters={filters.map((filter) => {
            const column = table.getColumn(filter.columnId)
            return {
              id: filter.columnId,
              label: filter.label,
              allLabel: filter.allLabel,
              options: filter.options,
              value: String(column?.getFilterValue() ?? "ALL"),
              onValueChange: (nextValue: string) => {
                column?.setFilterValue(nextValue === "ALL" ? undefined : nextValue)
                setPagination((current) => ({ ...current, pageIndex: 0 }))
              },
            }
          })}
          className="px-4"
        />
        : null}

      <Table className="table-auto">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder ? null : header.column.getCanSort() ? (
                    <Button
                      onClick={header.column.getToggleSortingHandler()}
                      size="sm"
                      variant="ghost"
                    >
                      <span className="max-w-80 truncate"><table.FlexRender header={header} /></span>
                      {header.column.getIsSorted() === "asc" ? <ArrowUpIcon data-icon="inline-end" />
                        : header.column.getIsSorted() === "desc" ? <ArrowDownIcon data-icon="inline-end" />
                          : <ArrowUpDownIcon data-icon="inline-end" />}
                    </Button>
                  ) : <div className="max-w-80 truncate"><table.FlexRender header={header} /></div>}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length ? table.getRowModel().rows.map((row) => (
            <TableRow
              aria-label={onRowClick ? getRowLabel?.(row.original) : undefined}
              className={onRowClick ? "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" : undefined}
              data-testid={getRowTestId?.(row.original)}
              key={row.id}
              onClick={() => onRowClick?.(row.original)}
              onKeyDown={onRowClick ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                onRowClick(row.original)
              } : undefined}
              tabIndex={onRowClick ? 0 : undefined}
            >
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id} title={typeof cell.getValue() === "string" ? String(cell.getValue()) : undefined}>
                  <div className="max-w-80 truncate">
                    <table.FlexRender cell={cell} />
                  </div>
                </TableCell>
              ))}
            </TableRow>
          )) : (
            <TableRow>
              <TableCell className="h-24 text-center" colSpan={columns.length}>{noResults}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {filteredRows > pagination.pageSize ? <div className="flex items-center justify-between gap-3 px-4 pb-4">
        <div className="text-ui tabular-nums text-muted-foreground">
          {t("{{from}}-{{to}} of {{count}}", { count: filteredRows, from: firstRow, to: lastRow })}
        </div>
        <div className="flex items-center gap-2">
          <Button disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()} size="sm" variant="outline">
            {t("Previous")}
          </Button>
          <Button disabled={!table.getCanNextPage()} onClick={() => table.nextPage()} size="sm" variant="outline">
            {t("Next")}
          </Button>
        </div>
      </div> : null}
    </div>
  )
}

interface DataTableProps<TData extends RowData> extends TableViewProps<TData> {
  searchPlaceholder: string
}

export function DataTable<TData extends RowData>(props: DataTableProps<TData>) {
  return <TableView {...props} />
}
