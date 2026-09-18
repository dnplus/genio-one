import { format, differenceInCalendarDays, isSameDay, subDays } from "date-fns"
import { enUS, zhTW } from "date-fns/locale"
import { ArrowRightIcon, CalendarDaysIcon, ChevronDownIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import type { DateRange } from "react-day-picker"
import { Area, Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { TitleHelp } from "@/components/title-help"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { OverviewSnapshot } from "@/domain/contracts"
import { buildAggregatedTrendRecords, buildTrendBuckets, buildTrendRecords, type NormalizedOutcome, type ProductLane, type TrendRecord } from "@/features/overview/overview-model"
import { getGatewayTransactionTrends } from "@/lib/product-api"
import { calendarDayStartEpochSeconds, currentTimeZone } from "@/lib/personal-preferences"

const productLanes: ProductLane[] = ["ALL", "AI_MCP_GATEWAY", "API_MANAGEMENT", "SECURE_ACCESS", "ENDPOINT"]
const problemOutcomes = ["denied", "blocked", "rateLimited", "failed"] as const satisfies readonly NormalizedOutcome[]
const rangePresets = [
  { days: 7, label: "Last 7 days", shortLabel: "7D" },
  { days: 30, label: "Last 30 days", shortLabel: "30D" },
  { days: 90, label: "Last 90 days", shortLabel: "90D" },
] as const
const outcomeFilter: Record<NormalizedOutcome, string> = {
  success: "SUCCESS",
  denied: "DENIED",
  blocked: "BLOCK",
  rateLimited: "RATE_LIMITED",
  failed: "FAILED",
}

interface CompleteDateRange {
  from: Date
  to: Date
}

function presetRange(days: number): CompleteDateRange {
  const to = new Date()
  return { from: subDays(to, days - 1), to }
}

export function TransactionTrends({
  tenantId,
  data,
  onOpenActivity,
}: {
  tenantId: string
  data: OverviewSnapshot
  onOpenActivity: (filter?: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [lane, setLane] = useState<ProductLane>("ALL")
  const [range, setRange] = useState<CompleteDateRange>(() => presetRange(7))
  const [draftRange, setDraftRange] = useState<DateRange>(range)
  const [rangeOpen, setRangeOpen] = useState(false)
  const [selectedOutcome, setSelectedOutcome] = useState<NormalizedOutcome | null>(null)
  const timeZone = currentTimeZone()
  const fallbackRecords = useMemo(() => buildTrendRecords(data), [data])
  const [aggregatedRecords, setAggregatedRecords] = useState<TrendRecord[] | null>(null)
  const activePreset = range.from && range.to && isSameDay(range.to, new Date())
    ? rangePresets.find((preset) => differenceInCalendarDays(range.to, range.from) + 1 === preset.days)
    : undefined
  const buckets = useMemo(
    () => buildTrendBuckets(aggregatedRecords ?? fallbackRecords, lane, range, i18n.language, timeZone),
    [aggregatedRecords, fallbackRecords, i18n.language, lane, range.from, range.to, timeZone],
  )

  useEffect(() => {
    let active = true
    const from = calendarDayStartEpochSeconds(range.from.getFullYear(), range.from.getMonth(), range.from.getDate(), timeZone)
    const to = calendarDayStartEpochSeconds(range.to.getFullYear(), range.to.getMonth(), range.to.getDate() + 1, timeZone) - 1
    setAggregatedRecords(null)
    void getGatewayTransactionTrends(tenantId, from, to, timeZone)
      .then((points) => {
        if (active) setAggregatedRecords(buildAggregatedTrendRecords(points))
      })
      .catch(() => {
        if (active) setAggregatedRecords(fallbackRecords)
      })
    return () => {
      active = false
    }
  }, [fallbackRecords, range.from, range.to, tenantId, timeZone])
  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0)
  const problems = buckets.reduce(
    (sum, bucket) => sum + bucket.denied + bucket.blocked + bucket.rateLimited + bucket.failed,
    0,
  )
  const selectedCount = selectedOutcome
    ? buckets.reduce((sum, bucket) => sum + bucket[selectedOutcome], 0)
    : total
  const chartConfig = {
    total: { label: t("Transactions"), color: "var(--chart-2)" },
    denied: { label: t("Denied"), color: "oklch(0.62 0.18 25)" },
    blocked: { label: t("Blocked"), color: "oklch(0.72 0.16 75)" },
    rateLimited: { label: t("Rate limited"), color: "oklch(0.62 0.14 250)" },
    failed: { label: t("Failed"), color: "var(--destructive)" },
  } satisfies ChartConfig

  function selectOutcome(outcome: NormalizedOutcome) {
    setSelectedOutcome((current) => current === outcome ? null : outcome)
  }

  function selectPreset(days: number) {
    const nextRange = presetRange(days)
    setDraftRange(nextRange)
    setRange(nextRange)
    setSelectedOutcome(null)
    setRangeOpen(false)
  }

  function applyCustomRange() {
    if (!draftRange.from || !draftRange.to) return
    setRange({ from: draftRange.from, to: draftRange.to })
    setSelectedOutcome(null)
    setRangeOpen(false)
  }

  const rangeLabel = activePreset
    ? t(activePreset.label)
    : `${format(range.from, "yyyy/MM/dd")} – ${format(range.to, "yyyy/MM/dd")}`

  return (
    <Card className="min-w-0" data-testid="overview-transaction-trends">
      <CardHeader>
        <div>
          <CardTitle><TitleHelp help={t("Traffic is grouped by product boundary and normalized outcome.")}>{t("Transaction history")}</TitleHelp></CardTitle>
        </div>
        <CardAction>
          <Popover open={rangeOpen} onOpenChange={(open) => {
            if (open) {
              setDraftRange(range)
            }
            setRangeOpen(open)
          }}>
            <PopoverTrigger asChild>
              <Button data-testid="transaction-range-trigger" size="sm" variant="outline">
                <CalendarDaysIcon data-icon="inline-start" />
                {rangeLabel}
                <ChevronDownIcon data-icon="inline-end" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" collisionPadding={16} className="w-auto max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0">
              <div className="flex items-center justify-between gap-3 p-3">
                <span className="font-medium">{t("Quick ranges")}</span>
                <ToggleGroup
                  aria-label={t("Select time period")}
                  onValueChange={(value) => {
                    if (value) selectPreset(Number(value))
                  }}
                  size="sm"
                  type="single"
                  value={activePreset?.days.toString() ?? ""}
                  variant="outline"
                >
                  {rangePresets.map((preset) => (
                    <ToggleGroupItem data-testid={`transaction-range-preset-${preset.days}`} key={preset.days} value={preset.days.toString()}>
                      {t(preset.shortLabel)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <Separator />
              <Calendar
                defaultMonth={draftRange.from ?? range.from}
                disabled={{ after: new Date() }}
                locale={i18n.resolvedLanguage === "zh-TW" ? zhTW : enUS}
                mode="range"
                numberOfMonths={1}
                onSelect={(nextRange) => setDraftRange(nextRange ?? { from: undefined, to: undefined })}
                selected={draftRange}
              />
              <Separator />
              <div className="flex items-center justify-between gap-3 p-3">
                <span className="text-sm text-muted-foreground">{t("Custom range")}</span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setRangeOpen(false)}>{t("Cancel")}</Button>
                  <Button size="sm" disabled={!draftRange.from || !draftRange.to} onClick={applyCustomRange}>{t("Apply range")}</Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <Tabs className="min-w-0" value={lane} onValueChange={(value) => { setLane(value as ProductLane); setSelectedOutcome(null) }}>
          <TabsList className="w-full max-w-full justify-start overflow-x-auto overflow-y-hidden" variant="line">
            {productLanes.map((productLane) => (
              <TabsTrigger key={productLane} value={productLane}>{t(productLane)}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div><div className="text-xs text-muted-foreground">{t("Transactions")}</div><div className="text-2xl font-semibold tabular-nums">{total.toLocaleString(i18n.language)}</div></div>
          <div><div className="text-xs text-muted-foreground">{t("Problem outcomes")}</div><div className="text-xl font-semibold tabular-nums">{problems.toLocaleString(i18n.language)}</div></div>
          <ToggleGroup
            aria-label={t("Filter transaction outcomes")}
            className="ml-auto flex-wrap justify-end"
            onValueChange={(value) => setSelectedOutcome(value ? value as NormalizedOutcome : null)}
            size="sm"
            type="single"
            value={selectedOutcome ?? ""}
            variant="outline"
          >
            {problemOutcomes.map((outcome) => (
              <ToggleGroupItem data-testid={`transaction-outcome-${outcome}`} key={outcome} value={outcome}>
                {t(outcomeFilter[outcome])}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <ChartContainer config={chartConfig} className="h-64 w-full" initialDimension={{ width: 720, height: 256 }}>
          <ComposedChart accessibilityLayer barCategoryGap="32%" data={buckets} margin={{ left: 4, right: 4, top: 12 }}>
            <CartesianGrid strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="label" axisLine={false} tickLine={false} tickMargin={10} minTickGap={24} />
            <YAxis axisLine={false} tickLine={false} width={36} allowDecimals={false} />
            <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
            <Area dataKey="total" hide={selectedOutcome !== null} type="monotone" fill="var(--color-total)" fillOpacity={0.04} stroke="none" />
            <Bar barSize={22} dataKey="denied" hide={selectedOutcome !== null && selectedOutcome !== "denied"} stackId="problems" fill="var(--color-denied)" radius={[3, 3, 0, 0]} onClick={() => selectOutcome("denied")} />
            <Bar barSize={22} dataKey="blocked" hide={selectedOutcome !== null && selectedOutcome !== "blocked"} stackId="problems" fill="var(--color-blocked)" radius={[3, 3, 0, 0]} onClick={() => selectOutcome("blocked")} />
            <Bar barSize={22} dataKey="rateLimited" hide={selectedOutcome !== null && selectedOutcome !== "rateLimited"} stackId="problems" fill="var(--color-rateLimited)" radius={[3, 3, 0, 0]} onClick={() => selectOutcome("rateLimited")} />
            <Bar barSize={22} dataKey="failed" hide={selectedOutcome !== null && selectedOutcome !== "failed"} stackId="problems" fill="var(--color-failed)" radius={[3, 3, 0, 0]} onClick={() => selectOutcome("failed")} />
            <Line activeDot={{ r: 4 }} dataKey="total" dot={{ r: 3, strokeWidth: 2 }} hide={selectedOutcome !== null} stroke="var(--color-total)" strokeWidth={2.5} type="monotone" />
          </ComposedChart>
        </ChartContainer>

        <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between" aria-live="polite">
          <span className="text-sm text-muted-foreground">
            {t(lane)} · {selectedOutcome ? t(outcomeFilter[selectedOutcome]) : t("All outcomes")} · {t("{{count}} transactions", { count: selectedCount })}
          </span>
          <Button variant="ghost" size="sm" onClick={() => onOpenActivity(selectedOutcome ? outcomeFilter[selectedOutcome] : undefined)}>
            {t("Open filtered Activity")}
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
