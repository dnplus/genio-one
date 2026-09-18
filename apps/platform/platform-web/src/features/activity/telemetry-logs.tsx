import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { listTelemetryLogs, type TelemetryLogRecord } from "@/lib/product-api"

export function localDateTime(timestamp: number) {
  const date = new Date(timestamp)
  return new Date(timestamp - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

export function TelemetryLogs({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation()
  const [search, setSearch] = useState("")
  const [from, setFrom] = useState(() => localDateTime(Date.now() - 86400000))
  const [until, setUntil] = useState("")
  const [filters, setFilters] = useState<{ event?: string; search?: string; from?: number; until?: number; cursor?: string }>({ from: Date.now() - 86400000, until: Date.now() })
  const [records, setRecords] = useState<TelemetryLogRecord[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void listTelemetryLogs(tenantId, filters).then(result => {
      if (active) { setRecords(result.records); setNext(result.next_cursor) }
    }).catch(reason => { if (active) setError(String(reason)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [tenantId, filters])
  return <Card>
    <CardHeader><CardTitle>{t("Raw telemetry logs")}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); setFilters({ search, from: from ? new Date(from).getTime() : undefined, until: until ? new Date(until).getTime() : Date.now() }) }}>
        <label className="min-w-48 flex-1 text-sm">{t("Search logs")}<Input value={search} onChange={event => setSearch(event.target.value)} /></label>
        <label className="text-sm">{t("From")}<Input type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} /></label>
        <label className="text-sm">{t("Until")}<Input type="datetime-local" value={until} onChange={event => setUntil(event.target.value)} /></label>
        <Button type="submit" disabled={loading}>{t("Search")}</Button>
        <Button type="button" variant="outline" disabled={loading} onClick={() => { setSearch("telemetry.delivery.health"); setFilters({ event: "telemetry.delivery.health", from: from ? new Date(from).getTime() : undefined, until: Date.now() }) }}>{t("Delivery health")}</Button>
      </form>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <div aria-busy={loading} className="divide-y">
        {records.map(record => <details key={record.record_id} className="py-3" onToggle={event => {
          if (!event.currentTarget.open || record.details_loaded) return
          void listTelemetryLogs(tenantId, { record_id: record.record_id, timestamp_nanos: record.timestamp_nanos }).then(result => {
            const detail = result.records[0]
            if (detail) setRecords(current => current.map(item => item.record_id === detail.record_id ? detail : item))
          }).catch(reason => setError(String(reason)))
        }}>
          <summary className="cursor-pointer text-sm"><span className="mr-3 font-mono">{new Date(record.timestamp_millis).toLocaleString()}</span><strong>{record.service || t("Unknown service")}</strong><span className="mx-3">{record.severity}</span><span>{record.body.slice(0, 160)}</span></summary>
          <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{record.details_loaded ? JSON.stringify(record, null, 2) : t("Loading…")}</pre>
        </details>)}
        {!loading && !error && records.length === 0 && <p>{t("No telemetry logs in this range")}</p>}
      </div>
      <div className="flex gap-2"><Button variant="outline" disabled={loading || !filters.cursor} onClick={() => setFilters(({ cursor: _cursor, ...rest }) => rest)}>{t("First page")}</Button><Button variant="outline" disabled={loading || !next} onClick={() => setFilters(current => ({ ...current, cursor: next! }))}>{t("Older records")}</Button></div>
    </CardContent>
  </Card>
}
