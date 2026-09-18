import { useMemo, type RefObject } from "react"

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import { cn } from "@/lib/utils"

export interface SearchableSelectOption {
  value: string
  label: string
  description?: string
  searchText?: string
}

interface SearchableSelectProps {
  id?: string
  value: string
  options: SearchableSelectOption[]
  onValueChange: (value: string) => void
  placeholder: string
  searchPlaceholder: string
  emptyLabel: string
  ariaLabel?: string
  className?: string
  portalContainer?: RefObject<HTMLElement | ShadowRoot | null>
}

export function SearchableSelect({
  id,
  value,
  options,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  ariaLabel,
  className,
  portalContainer,
}: SearchableSelectProps) {
  const values = options.map((option) => option.value)
  const optionsByValue = useMemo(() => new Map(options.map((option) => [option.value, option])), [options])
  const selectedValue = values.includes(value) ? value : ""

  return (
    <Combobox
      items={values}
      itemToStringLabel={(optionValue) => optionsByValue.get(optionValue)?.label ?? optionValue}
      itemToStringValue={(optionValue) => {
        const option = optionsByValue.get(optionValue)
        return option ? `${option.label} ${option.description ?? ""} ${option.searchText ?? ""} ${option.value}` : optionValue
      }}
      value={selectedValue}
      onValueChange={(nextValue) => onValueChange(nextValue ?? "")}
    >
      <ComboboxInput
        aria-label={ariaLabel ?? searchPlaceholder}
        className={cn("w-full", className)}
        id={id}
        placeholder={selectedValue ? undefined : placeholder}
        showClear
      />
      <ComboboxContent container={portalContainer}>
        <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
        <ComboboxList>
          {(optionValue) => {
            const option = optionsByValue.get(optionValue)
            if (!option) return null
            return (
              <ComboboxItem key={option.value} value={option.value}>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.description ? <span className="truncate text-xs text-muted-foreground">{option.description}</span> : null}
              </ComboboxItem>
            )
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
