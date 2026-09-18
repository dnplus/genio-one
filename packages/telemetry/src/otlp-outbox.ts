import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { hostname } from "node:os"
import { randomUUID } from "node:crypto"

type Envelope = { signal: Signal; body: unknown }
type Pending = { payload: string; bytes: number; created: number; resolve: (saved: boolean) => void }
type Signal = "traces" | "logs" | "metrics"
type Options = { directory: string; origin: string; maxAgeMs?: number; maxBytes?: number; maxFiles?: number; maxPendingBytes?: number; intervalMs?: number; send?: (input: string, init: RequestInit) => Promise<Response>; now?: () => number; report?: (event: Record<string, unknown>) => void }

export class OtlpOutbox {
  private writes = Promise.resolve()
  private writing = false
  private buffered: Pending[] = []
  private draining?: Promise<void>
  private pendingBytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private readonly startedAt = Date.now()
  private readonly counts: Record<string, number> = {}
  private queuedFiles = 0
  private queuedBytes = 0
  private lastSuccessAt: number | null = null
  private failures = 0
  private retryAt = 0
  private readonly now: () => number
  private readonly report: (event: Record<string, unknown>) => void

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now
    const report = options.report ?? (event => { process.stderr.write(`${JSON.stringify(event)}\n`) })
    this.report = event => {
      const key = `${event.event}:${event.reason ?? "total"}`
      this.counts[key] = (this.counts[key] ?? 0) + 1
      report(event)
    }
    this.schedule(0)
  }

  enqueue(signal: Signal, body: unknown): Promise<boolean> {
    try {
      const payload = JSON.stringify({ signal, body })
      const bytes = Buffer.byteLength(payload)
      if (this.stopped || bytes > (this.options.maxBytes ?? 256 * 1024 * 1024) || this.pendingBytes + bytes > (this.options.maxPendingBytes ?? 8 * 1024 * 1024)) {
        this.report({ event: "otel.outbox.dropped", reason: this.stopped ? "closed" : "memory_capacity", bytes })
        return Promise.resolve(false)
      }
      this.pendingBytes += bytes
      const accepted = new Promise<boolean>(resolve => this.buffered.push({ payload, bytes, created: this.now(), resolve }))
      this.startWriter()
      return accepted
    } catch {
      this.report({ event: "otel.outbox.dropped", reason: "serialization" })
      return Promise.resolve(false)
    }
  }

  private startWriter() {
    if (this.writing) return
    this.writing = true
    this.writes = new Promise<void>(resolve => setTimeout(resolve, 10)).then(() => this.writeBatches()).finally(() => {
      this.writing = false
      if (this.buffered.length) this.startWriter()
    })
  }

  private batches<T extends { payload: Envelope; bytes: number }>(items: T[]) {
    const groups: { items: T[]; signal: Signal; body: unknown; bytes: number }[] = []
    const keys = { traces: "resourceSpans", logs: "resourceLogs", metrics: "resourceMetrics" }
    for (const item of items) {
      const { signal, body } = item.payload
      const key = keys[signal]
      const values = body && typeof body === "object" && Object.keys(body).length === 1 ? (body as Record<string, unknown>)[key] : undefined
      const existing = Array.isArray(values) ? groups.find(group => group.signal === signal && group.bytes + item.bytes <= 2 * 1024 * 1024 && Array.isArray((group.body as Record<string, unknown>)?.[key])) : undefined
      if (existing) {
        (existing.body as Record<string, unknown[]>)[key]!.push(...values as unknown[])
        existing.items.push(item)
        existing.bytes += item.bytes
      } else groups.push({ items: [item], signal, body: Array.isArray(values) ? { [key]: [...values] } : body, bytes: item.bytes })
    }
    return groups
  }

  private async writeBatches() {
    while (this.buffered.length) {
      const items = this.buffered.splice(0, 256).map(item => ({ ...item, payload: JSON.parse(item.payload) as Envelope }))
      for (const group of this.batches(items)) {
        let saved = false
        try {
          await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
          const name = `${group.items[0]!.created}-${randomUUID()}`
          const temporary = join(this.options.directory, `${name}.tmp`)
          const file = await open(temporary, "wx", 0o600)
          try { await file.writeFile(JSON.stringify({ signal: group.signal, body: group.body })); await file.sync() } finally { await file.close() }
          await rename(temporary, join(this.options.directory, `${name}.json`))
          const directory = await open(this.options.directory, "r")
          try { await directory.sync() } finally { await directory.close() }
          saved = true
        } catch (error) { this.report({ event: "otel.outbox.dropped", reason: "storage_write", bytes: group.bytes, code: (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN" }) }
        for (const item of group.items) { this.pendingBytes -= item.bytes; item.resolve(saved) }
      }
      this.schedule(0)
    }
  }

  private schedule(delay: number) {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain().finally(() => this.schedule(this.options.intervalMs ?? 1000))
    }, delay)
    this.timer.unref()
  }

  async drain(): Promise<void> {
    if (this.draining) return this.draining
    this.draining = this.withLock().catch(error => this.report({ event: "otel.outbox.unavailable", code: error?.code ?? "UNKNOWN" })).finally(() => { this.draining = undefined })
    return this.draining
  }

  private async withLock() {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    const path = join(this.options.directory, ".lock")
    let lock
    try { lock = await open(path, "wx", 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        const metadata = await stat(path)
        if (Date.now() - metadata.mtimeMs < 30000) return
        await this.remove(path)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      return
    }
    const heartbeat = setInterval(() => { const now = new Date(); void lock.utimes(now, now).catch(() => {}) }, 2000)
    heartbeat.unref()
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }))
      await this.run()
    } finally { clearInterval(heartbeat); await lock.close(); await this.remove(path) }
  }

  private async remove(path: string) {
    try { await unlink(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false }
  }

  private async run() {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    const names = (await readdir(this.options.directory)).filter(name => /^\d+-[a-f0-9-]+\.(json|tmp)$/.test(name)).sort()
    const entries: { path: string; size: number; created: number }[] = []
    for (const name of names) {
      const path = join(this.options.directory, name)
      const created = Number(name.split("-")[0])
      try {
        const info = await stat(path)
        if (this.now() - created > (this.options.maxAgeMs ?? 2 * 60 * 60 * 1000)) {
          if (await this.remove(path)) this.report({ event: "otel.outbox.dropped", reason: name.endsWith(".tmp") ? "unfinished_write_expired" : "expired", bytes: info.size })
        } else if (name.endsWith(".json")) entries.push({ path, size: info.size, created })
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    }
    let bytes = entries.reduce((total, entry) => total + entry.size, 0)
    this.queuedFiles = entries.length
    this.queuedBytes = bytes
    const prune = async () => {
      let removed = 0
      while (entries.length - removed > (this.options.maxFiles ?? 10000) || bytes > (this.options.maxBytes ?? 256 * 1024 * 1024)) {
        const entry = entries[removed++]!
        bytes -= entry.size
        if (await this.remove(entry.path)) this.report({ event: "otel.outbox.dropped", reason: "disk_capacity", bytes: entry.size })
      }
    }
    if (this.now() < this.retryAt) { await prune(); return }
    const deadline = Date.now() + 1000
    const ready: { path: string; payload: Envelope; bytes: number }[] = []
    for (const entry of entries.slice(0, 2000)) {
      if (Date.now() > deadline) break
      let payload: { signal: Signal; body: unknown }
      try {
        payload = JSON.parse(await readFile(entry.path, "utf8"))
        if (!["traces", "logs", "metrics"].includes(payload.signal) || !payload.body) throw new Error("INVALID_ENVELOPE")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        if (error instanceof SyntaxError || (error as Error).message === "INVALID_ENVELOPE") {
          if (await this.remove(entry.path)) this.report({ event: "otel.outbox.dropped", reason: "corrupt_record", bytes: entry.size })
          continue
        }
        throw error
      }
      ready.push({ path: entry.path, payload, bytes: entry.size })
    }
    for (const group of this.batches(ready)) {
      const payload = group
      try {
        const response = await (this.options.send ?? fetch)(`${this.options.origin}/v1/${payload.signal}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload.body), signal: AbortSignal.timeout(5000) })
        const responseBody = await response.text()
        if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
          this.report({ event: "otel.outbox.dropped", reason: "collector_rejection", status: response.status, signal: payload.signal, bytes: group.bytes })
          await Promise.all(group.items.map(item => this.remove(item.path)))
          continue
        }
        if (!response.ok) throw new Error(`HTTP_${response.status}`)
        const result = responseBody ? JSON.parse(responseBody) : {}
        const partial = result.partialSuccess ?? result.partial_success
        if (partial && Object.entries(partial).some(([key, value]) => key.startsWith("rejected") && Number(value) > 0)) {
          this.report({ event: "otel.outbox.dropped", reason: "collector_partial_rejection", signal: payload.signal, bytes: group.bytes })
        }
        await Promise.all(group.items.map(item => this.remove(item.path)))
        if (this.failures) this.report({ event: "otel.outbox.recovered", failures: this.failures })
        this.lastSuccessAt = this.now()
        this.failures = 0
        this.retryAt = 0
      } catch {
        this.failures++
        this.retryAt = this.now() + Math.min(30000, 1000 * 2 ** Math.min(this.failures - 1, 5))
        await prune()
        this.report({ event: "otel.outbox.retry", failures: this.failures, queued: entries.length, bytes, retryAt: this.retryAt })
        return
      }
    }
  }

  health() {
    return { scope: "PROCESS", counter_unit: "REPORT_EVENTS_NOT_RECORDS", started_at: this.startedAt, observed_at: this.now(), last_success_at: this.lastSuccessAt, queued_files_at_last_scan: this.queuedFiles, queued_bytes_at_last_scan: this.queuedBytes, pending_bytes: this.pendingBytes, consecutive_failures: this.failures, retry_at: this.retryAt, counters: { ...this.counts } }
  }

  async flush() { await this.writes; await this.drain() }
  async close() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await this.writes
    await this.draining
  }
}
