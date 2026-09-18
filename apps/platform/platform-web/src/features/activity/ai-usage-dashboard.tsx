import { BarChart3Icon, BotIcon, CircleDollarSignIcon, UsersIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { RouteBadge } from "@/components/route-badge"
import { TitleHelp } from "@/components/title-help"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { AiUsageDashboard as AiUsageDashboardData, RouteDecision } from "@/domain/contracts"
import { calendarDayStartEpochSeconds, currentTimeZone } from "@/lib/personal-preferences"
import { loadAiUsageDashboard } from "@/lib/product-api"

type DateRange = { from: string; to: string }

function dateInput(daysAgo: number) {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-")
}

function epochRange(range: DateRange) {
  const timeZone = currentTimeZone()
  const [fromYear, fromMonth, fromDay] = range.from.split("-").map(Number)
  const [toYear, toMonth, toDay] = range.to.split("-").map(Number)
  const from = calendarDayStartEpochSeconds(fromYear!, fromMonth! - 1, fromDay!, timeZone)
  const to = calendarDayStartEpochSeconds(toYear!, toMonth! - 1, toDay! + 1, timeZone) - 1
  return { from, to }
}

function formatCost(data: AiUsageDashboardData, language: string) {
  if (!data.cost_by_currency.length) return "—"
  return data.cost_by_currency
    .map(({ currency, total_cost_micros }) =>
      new Intl.NumberFormat(language, {
        style: "currency",
        currency,
        maximumFractionDigits: 6,
      }).format(total_cost_micros / 1_000_000),
    )
    .join(" · ")
}

function formatMicros(currency: string, micros: number, language: string) {
  return new Intl.NumberFormat(language, {
    style: "currency",
    currency,
    maximumFractionDigits: 6,
  }).format(micros / 1_000_000)
}

function formatDay(epochSeconds: number, language: string) {
  return new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    timeZone: currentTimeZone(),
  }).format(new Date(epochSeconds * 1_000))
}

function formatBytes(value: number, language: string) {
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit: value >= 1_000_000 ? "megabyte" : "kilobyte",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value / (value >= 1_000_000 ? 1_000_000 : 1_000))
}

export function AiUsageDashboard({ tenantId }: { tenantId: string }) {
  const { t, i18n } = useTranslation()
  const [draftRange, setDraftRange] = useState<DateRange>({ from: dateInput(6), to: dateInput(0) })
  const [range, setRange] = useState<DateRange>(draftRange)
  const [data, setData] = useState<AiUsageDashboardData | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const selected = epochRange(range)
    setLoading(true)
    setFailure(null)
    void loadAiUsageDashboard(tenantId, selected.from, selected.to)
      .then((usage) => {
        if (active) setData(usage)
      })
      .catch((error) => {
        if (active) {
          setData(null)
          setFailure(error instanceof Error ? error.message : "UNKNOWN_ERROR")
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [range, tenantId])

  const rangeValid = Boolean(
    draftRange.from && draftRange.to && epochRange(draftRange).from <= epochRange(draftRange).to,
  )
  const routeTotal = data
    ? data.route_distribution.direct + data.route_distribution.managed + data.route_distribution.block
    : 0
  const routeRows: Array<[RouteDecision, number, string]> = data
    ? [
        ["DIRECT", data.route_distribution.direct, "bg-sky-500"],
        ["MANAGED", data.route_distribution.managed, "bg-primary"],
        ["BLOCK", data.route_distribution.block, "bg-destructive"],
      ]
    : []
  const trendMaximum = Math.max(0, ...(data?.cost_trend.map((point) => point.total_cost_micros) ?? []))
  const spendDimensions = data
    ? [
        [t("By Resource"), data.cost_by_resource.map((item) => ({
          key: `${item.resource_id}-${item.currency}`,
          label: item.display_name,
          currency: item.currency,
          total: item.total_cost_micros,
        }))],
        [t("By Subject"), data.cost_by_subject.map((item) => ({
          key: `${item.subject_id}-${item.currency}`,
          label: item.display_name ?? item.subject_id,
          currency: item.currency,
          total: item.total_cost_micros,
        }))],
        [t("By Department"), data.cost_by_department.map((item) => ({
          key: `${item.department ?? "unassigned"}-${item.currency}`,
          label: item.department ?? t("Unassigned"),
          currency: item.currency,
          total: item.total_cost_micros,
        }))],
      ] as const
    : []

  return (
    <Card>
      <CardHeader className="gap-4 border-b lg:flex-row lg:items-end lg:justify-between">
        <div>
          <CardTitle><TitleHelp help={t("Time-bounded usage, explicit cost distribution and Resource budget status across Endpoint and Gateway activity.")}>{t("AI Usage & Spend")}</TitleHelp></CardTitle>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="ai-usage-from">{t("From")}</FieldLabel>
            <Input
              id="ai-usage-from"
              type="date"
              value={draftRange.from}
              onChange={(event) => setDraftRange((current) => ({ ...current, from: event.target.value }))}
            />
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="ai-usage-to">{t("To")}</FieldLabel>
            <Input
              id="ai-usage-to"
              type="date"
              value={draftRange.to}
              onChange={(event) => setDraftRange((current) => ({ ...current, to: event.target.value }))}
            />
          </Field>
          <Button disabled={!rangeValid || loading} onClick={() => setRange(draftRange)}>
            {loading ? t("Loading…") : t("Apply range")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 p-5">
        {!rangeValid ? (
          <p role="alert" className="text-sm text-destructive">{t("Choose a valid time range.")}</p>
        ) : null}
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {t("Unable to load AI Usage Dashboard")}: {t(failure)}
          </p>
        ) : null}
        {data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                [UsersIcon, t("Active Users"), data.active_user_count.toLocaleString(i18n.language)],
                [BotIcon, t("AI Resources"), data.ai_resource_count.toLocaleString(i18n.language)],
                [BarChart3Icon, t("Requests"), data.usage.request_count.toLocaleString(i18n.language)],
                [CircleDollarSignIcon, t("Explicit cost metadata"), formatCost(data, i18n.language)],
              ].map(([Icon, label, value]) => {
                const MetricIcon = Icon as typeof UsersIcon
                return (
                  <div key={String(label)} className="rounded-lg border bg-muted/20 p-4">
                    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                      <MetricIcon className="size-4" aria-hidden="true" />
                      {String(label)}
                    </div>
                    <div className="mt-2 text-2xl font-semibold tabular-nums">{String(value)}</div>
                  </div>
                )
              })}
            </div>

            <div className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
              <section aria-labelledby="route-distribution-title" className="rounded-lg border p-4">
                <div className="flex items-baseline justify-between gap-4">
                  <h3 id="route-distribution-title" className="font-medium">{t("Route distribution")}</h3>
                  <span className="text-xs text-muted-foreground">
                    {t("{{count}} routed requests", { count: routeTotal.toLocaleString(i18n.language) })}
                  </span>
                </div>
                <div className="mt-4 space-y-4">
                  {routeRows.map(([route, count, color]) => {
                    const percentage = routeTotal ? Math.round((count / routeTotal) * 100) : 0
                    return (
                      <div key={route}>
                        <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
                          <RouteBadge route={route} />
                          <span className="tabular-nums text-muted-foreground">
                            {count.toLocaleString(i18n.language)} · {percentage}%
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full ${color}`}
                            style={{ width: `${percentage}%` }}
                            aria-label={t("{{route}} is {{percentage}} percent", { route, percentage })}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>

              <section aria-labelledby="usage-metadata-title" className="rounded-lg border p-4">
                <h3 id="usage-metadata-title" className="font-medium">{t("Usage metadata")}</h3>
                <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 text-sm">
                  <div><dt className="text-muted-foreground">{t("Tool calls")}</dt><dd className="mt-1 font-medium tabular-nums">{data.usage.tool_call_count.toLocaleString(i18n.language)}</dd></div>
                  <div><dt className="text-muted-foreground">{t("Provider-reported tokens")}</dt><dd className="mt-1 font-medium tabular-nums">{data.usage.total_tokens.toLocaleString(i18n.language)}</dd></div>
                  <div><dt className="text-muted-foreground">{t("Request bytes")}</dt><dd className="mt-1 font-medium tabular-nums">{formatBytes(data.usage.request_bytes, i18n.language)}</dd></div>
                  <div><dt className="text-muted-foreground">{t("Response bytes")}</dt><dd className="mt-1 font-medium tabular-nums">{formatBytes(data.usage.response_bytes, i18n.language)}</dd></div>
                </dl>
                <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
                  {t("{{priced}} priced · {{unpriced}} missing pricing", {
                    priced: data.priced_record_count,
                    unpriced: data.unpriced_record_count,
                  })}
                </p>
              </section>
            </div>

            <section aria-labelledby="spend-trend-title" className="rounded-lg border p-4">
              <div>
                <h3 id="spend-trend-title" className="font-medium">{t("Daily spend trend")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("Only explicitly priced provider-reported token usage is included.")}
                </p>
              </div>
              {data.cost_trend.length ? (
                <div className="mt-5 grid min-h-40 grid-flow-col auto-cols-fr items-end gap-2">
                  {data.cost_trend.map((point) => {
                    const height = trendMaximum ? Math.max(4, Math.round(point.total_cost_micros / trendMaximum * 100)) : 0
                    return (
                      <div key={`${point.day_start}-${point.currency}`} className="flex h-full flex-col justify-end gap-2 text-center">
                        <span className="text-[11px] tabular-nums text-muted-foreground">
                          {formatMicros(point.currency, point.total_cost_micros, i18n.language)}
                        </span>
                        <div className="flex h-24 items-end rounded-md bg-muted/40 px-1">
                          <div className="w-full rounded-t bg-primary" style={{ height: `${height}%` }} />
                        </div>
                        <span className="text-[11px] text-muted-foreground">{formatDay(point.day_start, i18n.language)}</span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">{t("No explicitly priced usage in this range.")}</p>
              )}
            </section>

            <div className="grid gap-4 xl:grid-cols-3">
              {spendDimensions.map(([title, rows]) => (
                <section key={title} className="rounded-lg border p-4">
                  <h3 className="font-medium">{title}</h3>
                  <div className="mt-4 space-y-3">
                    {[...rows]
                      .sort((left, right) => right.total - left.total)
                      .slice(0, 5)
                      .map((row) => (
                        <div key={row.key} className="flex items-center justify-between gap-3 text-sm">
                          <span className="min-w-0 truncate text-muted-foreground">{row.label}</span>
                          <span className="shrink-0 font-medium tabular-nums">
                            {formatMicros(row.currency, row.total, i18n.language)}
                          </span>
                        </div>
                      ))}
                    {!rows.length ? <p className="text-sm text-muted-foreground">{t("No spend data")}</p> : null}
                  </div>
                </section>
              ))}
            </div>

            <section aria-labelledby="resource-budgets-title" className="overflow-hidden rounded-lg border">
              <div className="border-b p-4">
                <h3 id="resource-budgets-title" className="font-medium">{t("Resource budgets")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("Consumption covers each complete budget allocation period, even when the selected view is narrower.")}
                </p>
              </div>
              {data.resource_budgets.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Resource")}</TableHead>
                      <TableHead>{t("Allocation")}</TableHead>
                      <TableHead>{t("Consumption")}</TableHead>
                      <TableHead>{t("Pricing coverage")}</TableHead>
                      <TableHead>{t("Status")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.resource_budgets.map((budget) => (
                      <TableRow key={`${budget.resource_id}-${budget.allocation_id}`}>
                        <TableCell className="font-medium">{budget.display_name}</TableCell>
                        <TableCell className="font-mono text-xs">{budget.allocation_id}</TableCell>
                        <TableCell>
                          <div className="font-medium tabular-nums">
                            {formatMicros(budget.currency, budget.consumed_cost_micros, i18n.language)} / {formatMicros(budget.currency, budget.limit_cost_micros, i18n.language)}
                          </div>
                          <div className="mt-1 h-1.5 w-32 overflow-hidden rounded-full bg-muted">
                            <div
                              className={budget.status === "OVER_BUDGET" ? "h-full bg-destructive" : "h-full bg-primary"}
                              style={{ width: `${Math.min(100, budget.consumption_basis_points / 100)}%` }}
                            />
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {t("{{priced}} priced · {{unpriced}} missing pricing", {
                            priced: budget.priced_record_count,
                            unpriced: budget.unpriced_record_count,
                          })}
                        </TableCell>
                        <TableCell>
                          <Badge variant={budget.status === "OVER_BUDGET" ? "destructive" : budget.status === "INCOMPLETE_PRICING" ? "outline" : "secondary"}>
                            {t(budget.status)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="p-4 text-sm text-muted-foreground">{t("No Resource budgets overlap this range.")}</p>
              )}
            </section>
          </>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">{t("Loading AI Usage Dashboard…")}</p>
        ) : null}
      </CardContent>
    </Card>
  )
}
