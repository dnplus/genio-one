import { useTranslation } from "react-i18next"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

import {
  enforcementPointIds,
  enforcementPointLabel,
  type EnforcementPointFilterValue,
} from "./enforcement-point-model"

export {
  enforcementPointLabel,
  enforcementPointQueryKey,
  matchesEnforcementPoint,
  normalizeEnforcementPoint,
  readEnforcementPointFilter,
  writeEnforcementPointFilter,
} from "./enforcement-point-model"
export type { EnforcementPointFilterValue, EnforcementPointId } from "./enforcement-point-model"

export function EnforcementPointFilter({
  value,
  onValueChange,
  variant = "select",
  includeAll = true,
  labelOverrides,
  className,
  testId = "enforcement-point-filter",
}: {
  value: EnforcementPointFilterValue
  onValueChange: (value: EnforcementPointFilterValue) => void
  variant?: "select" | "tabs"
  includeAll?: boolean
  labelOverrides?: Partial<Record<EnforcementPointFilterValue, string>>
  className?: string
  testId?: string
}) {
  const { t } = useTranslation()
  const options: EnforcementPointFilterValue[] = includeAll ? ["ALL", ...enforcementPointIds] : [...enforcementPointIds]
  const selectedValue = options.includes(value) ? value : options[0]!

  if (variant === "tabs") {
    return (
      <TabsList className={cn("w-full justify-start overflow-x-auto sm:w-fit", className)} data-testid={testId}>
        {options.map((point) => (
          <TabsTrigger key={point} value={point} data-enforcement-point={point}>
            {t(enforcementPointLabel(point, labelOverrides))}
          </TabsTrigger>
        ))}
      </TabsList>
    )
  }

  return (
    <Select value={selectedValue} onValueChange={(nextValue) => onValueChange(nextValue as EnforcementPointFilterValue)}>
      <SelectTrigger aria-label={t("Filter by enforcement point")} data-testid={testId}>
        <SelectValue placeholder={t("Enforcement point")} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((point) => (
            <SelectItem key={point} value={point}>{t(enforcementPointLabel(point, labelOverrides))}</SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
