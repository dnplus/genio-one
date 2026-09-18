import { mkdir, readFile, rename, open } from "node:fs/promises"
import { dirname } from "node:path"
import type { ObservationContext } from "../../../packages/telemetry/src/operation-observability"

type Link = { context: ObservationContext; expires: number }

export class ObservationLinks {
  private readonly entries = new Map<string, Link>()
  private writes = Promise.resolve()
  private readonly loaded: Promise<void>
  private dirty = false
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly path: string, private readonly tenantId: string) {
    this.loaded = readFile(path, "utf8").then(text => {
      const values = JSON.parse(text) as Array<[string, Link]>
      if (!Array.isArray(values)) return
      this.dirty = true
      for (const [key, value] of values) {
        if (typeof key === "string" && value?.expires > Date.now() && value.context?.tenantId === tenantId && /^[a-f0-9]{32}$/.test(value.context.traceId) && /^[a-f0-9]{16}$/.test(value.context.spanId) && !this.entries.has(key)) this.entries.set(key, value)
      }
      while (this.entries.size > 4096) this.entries.delete(this.entries.keys().next().value!)
    }).catch(error => { if (error?.code !== "ENOENT") console.warn(JSON.stringify({ event: "observation.links.recovery_failed" })) })
    this.timer = setInterval(() => { void this.flush() }, 5000)
    this.timer.unref()
  }
  async ready() { await this.loaded }
  get(key: string) {
    const value = this.entries.get(key)
    if (!value || value.expires < Date.now()) { if (this.entries.delete(key)) this.dirty = true; return undefined }
    this.dirty = true
    value.expires = Date.now() + 7200000
    return value.context
  }
  put(key: string, context: ObservationContext) {
    if (context.tenantId !== this.tenantId) return
    this.entries.delete(key)
    this.entries.set(key, { context, expires: Date.now() + 7200000 })
    for (const [key, value] of this.entries) if (value.expires < Date.now()) this.entries.delete(key)
    while (this.entries.size > 4096) this.entries.delete(this.entries.keys().next().value!)
    this.dirty = true
  }
  async flush() {
    this.writes = this.writes.then(async () => {
      await this.loaded
      for (const [key, value] of this.entries) if (value.expires < Date.now()) { this.entries.delete(key); this.dirty = true }
      if (!this.dirty) return
      this.dirty = false
      const snapshot = JSON.stringify([...this.entries])
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${process.pid}.tmp`
      const file = await open(temporary, "w", 0o600)
      try { await file.writeFile(snapshot); await file.sync() } finally { await file.close() }
      await rename(temporary, this.path)
    }).catch(() => { this.dirty = true; console.warn(JSON.stringify({ event: "observation.links.persist_failed" })) })
    await this.writes
  }
  async close() { clearInterval(this.timer); await this.flush() }
}
