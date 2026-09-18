export interface BrowserTelemetryEvent {
  id: string; name: string; traceId: string; spanId: string; startedAt: number; endedAt: number; status: number; attributes: Record<string, string>
}

type QueuedEvent = { id: string; scope: string; createdAt: number; event: BrowserTelemetryEvent }

export function createBrowserObserver(options: { service: string; token: () => string; endpoint: (tenantId: string) => string }) {
  let tenantId = ""
  let delivering = false
  let stopped = false
  let retryAt = 0
  let failures = 0
  const cleanups: Array<() => void> = []
  const originalFetch = globalThis.fetch.bind(globalThis)
  const enabled = typeof window !== "undefined" && typeof indexedDB !== "undefined"
  const pageInstance = enabled ? crypto.randomUUID() : ""
  const scope = () => {
    try { const payload = JSON.parse(atob(options.token().split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))); return payload.sub ? `${payload.iss}:${payload.sub}:${payload.tenant_id ?? payload.tenantId ?? tenantId}:${payload.azp ?? ""}` : "" } catch { return "" }
  }
  let opened: Promise<IDBDatabase> | undefined
  const database = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("genio-browser-telemetry", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("events", { keyPath: "id" })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { opened = undefined; reject(request.error) }
  })
  const update = async (run: (store: IDBObjectStore) => void) => {
    const db = await database()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("events", "readwrite")
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      run(transaction.objectStore("events"))
    })
  }
  const record = (event: BrowserTelemetryEvent, owner = scope()) => {
    if (!enabled || stopped || !owner) return
    void update(store => store.put({ id: event.id, scope: owner, createdAt: Date.now(), event: { ...event, attributes: { ...event.attributes, "browser.page_instance": pageInstance, "browser.user_agent": navigator.userAgent } } } satisfies QueuedEvent)).catch(() => console.warn(JSON.stringify({ event: "telemetry.browser.storage_failed" })))
  }
  const identity = () => ({ traceId: crypto.randomUUID().replaceAll("-", ""), spanId: crypto.randomUUID().replaceAll("-", "").slice(0, 16) })
  const emit = (name: string, attributes: Record<string, string>, status = 200) => {
    const timestamp = Date.now()
    record({ id: `${timestamp}-${crypto.randomUUID()}`, ...identity(), name, startedAt: timestamp, endedAt: timestamp, status, attributes })
  }
  const flush = async () => {
    if (!enabled || stopped || delivering) return
    delivering = true
    try {
      const db = await database()
      const rows = await new Promise<QueuedEvent[]>((resolve, reject) => { const request = db.transaction("events").objectStore("events").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
      rows.sort((left, right) => left.createdAt - right.createdAt)
      let bytes = rows.reduce((total, row) => total + JSON.stringify(row).length * 2, 0)
      const expired: string[] = []
      let ownExpired = 0
      const currentScope = scope()
      while (rows.length && (rows[0]!.createdAt < Date.now() - 7200000 || rows.length > 2000 || bytes > 4 * 1024 * 1024)) {
        const row = rows.shift()!
        bytes -= JSON.stringify(row).length * 2
        expired.push(row.id)
        if (row.scope === currentScope) ownExpired++
      }
      if (expired.length) {
        await update(store => { for (const id of expired) store.delete(id) })
        if (ownExpired) emit("telemetry.browser.dropped", { records: String(ownExpired), reason: "AGE_OR_CAPACITY" })
      }
      if (Date.now() < retryAt || !navigator.onLine) return
      const owner = scope()
      const endpoint = options.endpoint(tenantId)
      if (!owner || !endpoint) return
      const batch = rows.filter(row => row.scope === owner).slice(0, 50)
      if (!batch.length) return
      const response = await originalFetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${options.token()}`, "content-type": "application/json" }, body: JSON.stringify({ events: batch.map(row => row.event) }), signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(`TELEMETRY_HTTP_${response.status}`)
      await update(store => { for (const row of batch) store.delete(row.id) })
      if (failures) emit("telemetry.browser.recovered", { attempts: String(failures) })
      failures = 0
      retryAt = 0
    } catch {
      failures++
      retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5))
      if (failures === 1) emit("telemetry.browser.retry", { reason: "DELIVERY_UNAVAILABLE" }, 503)
    } finally { delivering = false }
  }
  if (enabled) {
    const registry = globalThis as typeof globalThis & { genioBrowserObservers?: Map<string, () => void> }
    registry.genioBrowserObservers ??= new Map()
    registry.genioBrowserObservers.get(options.service)?.()
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("button,a,[role=button]") : null
      if (target) emit("ui.click", { path: location.pathname, control: target.getAttribute("aria-label") ?? target.getAttribute("data-testid") ?? target.tagName })
    }
    const onOnline = () => { retryAt = 0; void flush() }
    const clean = (value: string) => value.replace(/(bearer|basic)\s+\S+|sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gi, "[REDACTED]").replace(/(code|token|password|secret|authorization|api_key)=[^&\s]+/gi, "$1=[REDACTED]")
    const onError = (event: ErrorEvent) => emit("browser.error", { path: location.pathname, error: event.error instanceof Error ? event.error.name : "SCRIPT_ERROR", message: clean(event.message), stack: clean(event.error instanceof Error ? event.error.stack ?? "" : ""), line: String(event.lineno), column: String(event.colno) }, 500)
    const onRejection = (event: PromiseRejectionEvent) => emit("browser.unhandled_rejection", { path: location.pathname, error: event.reason instanceof Error ? event.reason.name : "UNHANDLED_REJECTION", message: clean(String(event.reason)), stack: clean(event.reason instanceof Error ? event.reason.stack ?? "" : "") }, 500)
    const timer = setInterval(() => { void flush() }, 2000)
    window.addEventListener("online", onOnline)
    window.addEventListener("click", onClick, { capture: true })
    window.addEventListener("error", onError)
    window.addEventListener("unhandledrejection", onRejection)
    cleanups.push(() => { clearInterval(timer); window.removeEventListener("online", onOnline); window.removeEventListener("click", onClick, true); window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection) })
    registry.genioBrowserObservers.set(options.service, () => { stopped = true; for (const cleanup of cleanups) cleanup() })
  }
  return {
    begin(name: string, attributes: Record<string, string>) {
      if (!enabled || !scope()) return { traceparent: undefined, finish: (_status: number) => {} }
      const trace = identity()
      const startedAt = Date.now()
      const owner = scope()
      let completed = false
      return { traceparent: `00-${trace.traceId}-${trace.spanId}-01`, finish: (status: number) => {
        if (completed) return
        completed = true
        record({ id: `${startedAt}-${crypto.randomUUID()}`, ...trace, name, startedAt, endedAt: Date.now(), status, attributes }, owner)
      } }
    },
    async fetch(input: string, init?: RequestInit): Promise<Response> {
      if (!enabled || !scope()) return fetch(input, init)
      tenantId = input.match(/\/v1\/tenants\/([^/]+)/)?.[1] ?? tenantId
      const owner = scope()
      const trace = identity()
      const headers = new Headers(init?.headers)
      headers.set("traceparent", `00-${trace.traceId}-${trace.spanId}-01`)
      if (!headers.has("x-genio-correlation-id")) headers.set("x-genio-correlation-id", trace.traceId)
      const startedAt = Date.now()
      let status = 0
      try { const response = await originalFetch(input, { ...init, headers }); status = response.status; return response }
      finally { record({ id: `${startedAt}-${crypto.randomUUID()}`, ...trace, name: "http.client", startedAt, endedAt: Date.now(), status, attributes: { correlationId: headers.get("x-genio-correlation-id")!, phase: "RESPONSE_HEADERS", method: init?.method ?? "GET", path: new URL(input, location.origin).pathname, "genio.payload.availability": "SERVER_BOUNDARY_REFERENCE" } }, owner) }
    },
    flush,
  }
}
