import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

export interface RecordFilterBarOption {
  label: string
  value: string
}

export interface RecordFilterBarFilter {
  id: string
  label: string
  allLabel: string
  value: string
  options: RecordFilterBarOption[]
  onValueChange: (value: string) => void
}

export function RecordFilterBar({
  query,
  onQueryChange,
  searchPlaceholder,
  filters = [],
  children,
  className,
}: {
  query?: string
  onQueryChange?: (value: string) => void
  searchPlaceholder?: string
  filters?: RecordFilterBarFilter[]
  children?: ReactNode
  className?: string
}) {
  const { t } = useTranslation()
  const activeFilters = filters.filter((filter) => filter.value && filter.value !== "ALL")
  if (!searchPlaceholder && !filters.length && !children) return null

  return (
    <div className={cn("flex flex-wrap items-center gap-2 px-6", className)} data-testid="record-filter-bar">
      {searchPlaceholder && onQueryChange ? (
        <Input
          aria-label={searchPlaceholder}
          className="min-w-48 max-w-sm flex-1"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={searchPlaceholder}
          type="search"
          value={query ?? ""}
        />
      ) : null}
      {filters.map((filter) => (
        <Select key={filter.id} items={[{ value: "ALL", label: filter.allLabel }, ...filter.options]} onValueChange={filter.onValueChange} value={filter.value || "ALL"}>
          <SelectTrigger aria-label={filter.label} className="w-full min-w-40 sm:w-auto" data-filter-id={filter.id}>
            <SelectValue placeholder={filter.label} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="ALL">{filter.allLabel}</SelectItem>
              {filter.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ))}
      {children}
      {query || activeFilters.length ? <Button variant="outline" size="sm" onClick={() => {
        onQueryChange?.("")
        filters.forEach((filter) => filter.onValueChange("ALL"))
      }}>{t("Clear filters")}</Button> : null}
      {activeFilters.length ? <div className="flex flex-wrap gap-2" aria-label={t("Active filters")}>
        {activeFilters.map((filter) => <Badge key={filter.id} variant="secondary">
          {filter.label}: {filter.options.find((option) => option.value === filter.value)?.label ?? filter.value}
          <button type="button" aria-label={t("Remove filter {{name}}", { name: filter.label })} onClick={() => filter.onValueChange("ALL")} className="ml-1 cursor-pointer">×</button>
        </Badge>)}
      </div> : null}
    </div>
  )
}
