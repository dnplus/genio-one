import { randomUUID } from "node:crypto"
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises"
import { join } from "node:path"

import { operationalError, writeOperationalEvent } from "@genioone/telemetry/operational-log"

export const OBSERVATION_PATHS = ["/activities", "/accounting", "/audit-events"] as const
export type ObservationPath = typeof OBSERVATION_PATHS[number]

export interface ObservationRecord {
  path: ObservationPath
  correlation_id: string | null
  body: unknown
}

export interface ObservationOutboxOptions {
  stateRoot: string
  send(record: ObservationRecord, signal: AbortSignal): Promise<number>
  maxBytes?: number
  maxFiles?: number
  requestTimeoutMs?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  pollIntervalMs?: number
  now?: () => number
}

export interface ObservationOutboxHealthEvent {
  at: number
  file: string | null
  path: ObservationPath | null
  correlation_id: string | null
  status: number | null
  error_name: string | null
  error_message: string | null
  retry_attempt?: number
  retry_delay_ms?: number
}

export interface ObservationOutboxHealth {
  pending_count: number
  pending_bytes: number
  quarantine_count: number
  quarantine_bytes: number
  stale_temp_count: number
  stale_temp_bytes: number
  oldest_pending_age_ms: number | null
  blocked: boolean
  blocked_reason: string | null
  degraded: boolean
  degraded_reason: string | null
  last_delivery_failure: ObservationOutboxHealthEvent | null
  last_retry: ObservationOutboxHealthEvent | null
}

export class ObservationOutboxCapacityError extends Error {
  readonly code = "OBSERVATION_OUTBOX_CAPACITY_EXHAUSTED"
  readonly status = 507

  constructor(message = "Gateway observation outbox capacity exhausted") {
    super(message)
    this.name = "ObservationOutboxCapacityError"
  }
}

export class ObservationOutboxPersistenceError extends Error {
  readonly code = "OBSERVATION_OUTBOX_PERSISTENCE_FAILED"
  readonly status = 503

  constructor(message = "Gateway observation outbox persistence failed", options?: ErrorOptions) {
    super(message, options)
    this.name = "ObservationOutboxPersistenceError"
  }
}

export class ObservationOutboxInputError extends Error {
  readonly code = "OBSERVATION_OUTBOX_INPUT_INVALID"
  readonly status = 400

  constructor(message: string) {
    super(message)
    this.name = "ObservationOutboxInputError"
  }
}

interface StoredEntry {
  fileName: string
  path: string
  size: number
  createdAt: number
}

interface RetryState {
  attempts: number
  nextAttemptAt: number
}

interface DirectoryUsage {
  files: StoredEntry[]
  bytes: number
}

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_FILES = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_BASE_DELAY_MS = 250
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000
const STALE_PENDING_AGE_MS = 15 * 60 * 1_000
const DEFAULT_POLL_INTERVAL_MS = 1_000

function isObservationPath(value: unknown): value is ObservationPath {
  return typeof value === "string" && (OBSERVATION_PATHS as readonly string[]).includes(value)
}

function normaliseCorrelationId(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string" || value.length > 512 || /[\u0000\r\n]/.test(value)) {
    throw new ObservationOutboxInputError("Observation correlation_id is invalid")
  }
  return value
}

function jsonBody(value: unknown): string {
  let serialised: string | undefined
  try {
    serialised = JSON.stringify(value)
  } catch (error) {
    throw new ObservationOutboxInputError(
      `Observation body is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (serialised === undefined) throw new ObservationOutboxInputError("Observation body is not JSON serializable")
  return serialised
}

function entryCreatedAt(fileName: string, modifiedAt: number): number {
  const timestamp = /^(\d{13})-/.exec(fileName)?.[1]
  if (timestamp) return Number(timestamp)
  return modifiedAt
}

function storedRecord(value: unknown): ObservationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Observation outbox entry is not an object")
  }
  const entry = value as Record<string, unknown>
  if (!isObservationPath(entry.path)) throw new Error("Observation outbox entry path is invalid")
  if (entry.correlation_id !== undefined && entry.correlation_id !== null && typeof entry.correlation_id !== "string") {
    throw new Error("Observation outbox entry correlation_id is invalid")
  }
  const correlationId = normaliseCorrelationId(entry.correlation_id as string | null | undefined)
  if (!("body" in entry)) throw new Error("Observation outbox entry body is missing")
  jsonBody(entry.body)
  return {
    path: entry.path,
    correlation_id: correlationId,
    body: entry.body,
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const directory = join(path, "..")
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporaryPath, "wx", 0o600)
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, path)
    await syncDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

function retryableStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500
}

export class ObservationOutbox {
  readonly pendingDirectory: string
  readonly quarantineDirectory: string
  private readonly send: ObservationOutboxOptions["send"]
  private readonly maxBytes: number
  private readonly maxFiles: number
  private readonly requestTimeoutMs: number
  private readonly retryBaseDelayMs: number
  private readonly retryMaxDelayMs: number
  private readonly pollIntervalMs: number
  private readonly now: () => number
  private readonly stopController = new AbortController()
  private readonly retries = new Map<string, RetryState>()
  private readonly inFlight = new Set<string>()
  private mutation: Promise<void> = Promise.resolve()
  private drainPromise: Promise<void> | undefined
  private interval: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private blocked = false
  private blockedReason: string | null = null
  private lastDeliveryFailure: ObservationOutboxHealthEvent | null = null
  private lastRetry: ObservationOutboxHealthEvent | null = null

  constructor(options: ObservationOutboxOptions) {
    this.pendingDirectory = join(options.stateRoot, "observation-outbox", "pending")
    this.quarantineDirectory = join(options.stateRoot, "observation-outbox", "quarantine")
    this.send = options.send
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.now = options.now ?? (() => Date.now())
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error("Observation outbox maxBytes must be positive")
    if (!Number.isSafeInteger(this.maxFiles) || this.maxFiles < 1) throw new Error("Observation outbox maxFiles must be positive")
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) throw new Error("Observation outbox requestTimeoutMs must be positive")
    if (!Number.isSafeInteger(this.retryBaseDelayMs) || this.retryBaseDelayMs < 0) throw new Error("Observation outbox retryBaseDelayMs must not be negative")
    if (!Number.isSafeInteger(this.retryMaxDelayMs) || this.retryMaxDelayMs < 1) throw new Error("Observation outbox retryMaxDelayMs must be positive")
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) throw new Error("Observation outbox pollIntervalMs must be positive")
  }

  async initialise(): Promise<void> {
    await mkdir(this.pendingDirectory, { recursive: true, mode: 0o700 })
    await mkdir(this.quarantineDirectory, { recursive: true, mode: 0o700 })
    await this.recoverTemporaryFiles()
  }

  async health(): Promise<ObservationOutboxHealth> {
    try {
      await this.mutation
      const [pending, quarantine, staleTemps] = await Promise.all([
        this.directoryUsage(this.pendingDirectory),
        this.directoryUsage(this.quarantineDirectory),
        this.temporaryEntries(this.pendingDirectory),
      ])
      if (staleTemps.length > 0) {
        this.blocked = true
        this.blockedReason = "stale temporary outbox files remain"
      } else if (this.blockedReason === "stale temporary outbox files remain") {
        this.blocked = false
        this.blockedReason = null
      }
      const pendingCount = pending.files.length
      const pendingBytes = pending.bytes
      const quarantineCount = quarantine.files.length
      const quarantineBytes = quarantine.bytes
      const staleTempCount = staleTemps.length
      const staleTempBytes = staleTemps.reduce((sum, entry) => sum + entry.size, 0)
      const oldestPendingAt = pending.files.length === 0
        ? null
        : Math.min(...pending.files.map((entry) => entry.createdAt))
      const oldestPendingAgeMs = oldestPendingAt === null
        ? null
        : Math.max(0, this.now() - oldestPendingAt)
      const capacityExhausted = pendingCount + quarantineCount + staleTempCount >= this.maxFiles ||
        pendingBytes + quarantineBytes + staleTempBytes >= this.maxBytes
      const quarantinePresent = quarantineCount > 0
      const stalePending = oldestPendingAgeMs !== null && oldestPendingAgeMs >= STALE_PENDING_AGE_MS
      const dynamicBlockedReason = staleTempCount > 0
        ? "stale temporary outbox files remain"
        : quarantinePresent
          ? "outbox quarantine contains undeliverable observations"
          : capacityExhausted
            ? "outbox capacity exhausted"
            : stalePending
              ? "oldest pending observation is stale"
              : null
      const blocked = this.blocked || dynamicBlockedReason !== null
      const blockedReason = this.blockedReason ?? dynamicBlockedReason
      const degraded = blocked || pendingCount > 0
      const degradedReason = blockedReason ?? (pendingCount > 0 ? "observations pending delivery" : null)
      return {
        pending_count: pendingCount,
        pending_bytes: pendingBytes,
        quarantine_count: quarantineCount,
        quarantine_bytes: quarantineBytes,
        stale_temp_count: staleTempCount,
        stale_temp_bytes: staleTempBytes,
        oldest_pending_age_ms: oldestPendingAgeMs,
        blocked,
        blocked_reason: blockedReason,
        degraded,
        degraded_reason: degradedReason,
        last_delivery_failure: this.lastDeliveryFailure,
        last_retry: this.lastRetry,
      }
    } catch (error) {
      this.blocked = true
      this.blockedReason = "outbox health snapshot unavailable"
      this.event("ERROR", "genio.one.gateway-observation.outbox.health-failed", operationalError(error))
      return {
        pending_count: 0,
        pending_bytes: 0,
        quarantine_count: 0,
        quarantine_bytes: 0,
        stale_temp_count: 0,
        stale_temp_bytes: 0,
        oldest_pending_age_ms: null,
        blocked: true,
        blocked_reason: this.blockedReason,
        degraded: true,
        degraded_reason: this.blockedReason,
        last_delivery_failure: this.lastDeliveryFailure,
        last_retry: this.lastRetry,
      }
    }
  }

  start(): void {
    if (this.stopped || this.interval) return
    this.interval = setInterval(() => { void this.drainNow() }, this.pollIntervalMs)
    void this.drainNow()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.stopController.abort()
    if (this.interval) clearInterval(this.interval)
    await this.drainPromise
  }

  async enqueue(input: {
    path: ObservationPath
    correlationId?: string | null
    body: unknown
  }): Promise<ObservationRecord> {
    if (!isObservationPath(input.path)) throw new ObservationOutboxInputError("Observation path is invalid")
    const correlationId = normaliseCorrelationId(input.correlationId)
    const record: ObservationRecord = {
      path: input.path,
      correlation_id: correlationId,
      body: input.body,
    }
    const content = jsonBody(record)
    const bytes = Buffer.byteLength(content)
    const fileName = `${String(this.now()).padStart(13, "0")}-${randomUUID()}.json`
    const path = join(this.pendingDirectory, fileName)
    await this.withMutation(async () => {
      const usage = await this.usage()
      if (usage.files + 1 > this.maxFiles || usage.bytes + bytes > this.maxBytes) {
        this.event("WARN", "genio.one.gateway-observation.outbox.capacity-exhausted", {
          path: record.path,
          correlation_id: record.correlation_id,
          current_files: usage.files,
          current_bytes: usage.bytes,
          max_files: this.maxFiles,
          max_bytes: this.maxBytes,
        })
        throw new ObservationOutboxCapacityError()
      }
      try {
        await atomicWrite(path, content)
      } catch (error) {
        this.event("ERROR", "genio.one.gateway-observation.outbox.persistence-failed", {
          path: record.path,
          correlation_id: record.correlation_id,
          ...operationalError(error),
        })
        throw new ObservationOutboxPersistenceError(undefined, { cause: error })
      }
    })
    void this.drainNow()
    return record
  }

  async drainNow(): Promise<void> {
    if (this.stopped) return
    if (this.drainPromise) return this.drainPromise
    this.drainPromise = this.runDrain().finally(() => { this.drainPromise = undefined })
    return this.drainPromise
  }

  private async runDrain(): Promise<void> {
    let files: StoredEntry[]
    try {
      files = await this.entries(this.pendingDirectory)
    } catch (error) {
      this.event("ERROR", "genio.one.gateway-observation.outbox.scan-failed", operationalError(error))
      return
    }
    for (const entry of files) {
      if (this.stopped) return
      if (this.inFlight.has(entry.path)) continue
      const retry = this.retries.get(entry.path)
      if (retry && retry.nextAttemptAt > this.now()) continue
      await this.drainEntry(entry.path, entry.fileName)
    }
  }

  private async drainEntry(path: string, fileName: string): Promise<void> {
    this.inFlight.add(path)
    try {
      let record: ObservationRecord
      try {
        record = storedRecord(JSON.parse(await readFile(path, "utf8")))
      } catch (error) {
        this.event("ERROR", "genio.one.gateway-observation.outbox.invalid-entry", {
          file: fileName,
          ...operationalError(error),
        })
        await this.quarantine(path, fileName, undefined, "invalid-entry")
        return
      }
      const timeout = AbortSignal.timeout(this.requestTimeoutMs)
      const signal = AbortSignal.any([timeout, this.stopController.signal])
      let status: number
      try {
        status = await this.send(record, signal)
      } catch (error) {
        this.retry(path, fileName, record, undefined, error)
        return
      }
      if (status >= 200 && status < 300) {
        await this.remove(path, fileName, record)
        return
      }
      if (retryableStatus(status)) {
        this.retry(path, fileName, record, status)
        return
      }
      if (status >= 400 && status < 500) {
        await this.quarantine(path, fileName, record, `status-${status}`, status)
        return
      }
      this.retry(path, fileName, record, status)
    } finally {
      this.inFlight.delete(path)
    }
  }

  private retry(
    path: string,
    fileName: string,
    record: ObservationRecord,
    status?: number,
    error?: unknown,
  ): void {
    const attempts = (this.retries.get(path)?.attempts ?? 0) + 1
    const exponent = Math.min(attempts - 1, 30)
    const delay = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * (2 ** exponent))
    const attemptedAt = this.now()
    this.retries.set(path, { attempts, nextAttemptAt: attemptedAt + delay })
    const failure = this.healthEvent(fileName, record, status, error)
    this.lastDeliveryFailure = failure
    this.lastRetry = { ...failure, retry_attempt: attempts, retry_delay_ms: delay }
    this.event("WARN", "genio.one.gateway-observation.outbox.delivery-retry", {
      file: fileName,
      path: record.path,
      correlation_id: record.correlation_id,
      status: status ?? null,
      retry_attempt: attempts,
      retry_delay_ms: delay,
      ...(error ? operationalError(error) : {}),
    })
  }

  private async remove(path: string, fileName: string, record: ObservationRecord): Promise<void> {
    try {
      await unlink(path)
      await syncDirectory(this.pendingDirectory)
      this.retries.delete(path)
      this.event("INFO", "genio.one.gateway-observation.outbox.delivered", {
        file: fileName,
        path: record.path,
        correlation_id: record.correlation_id,
      })
    } catch (error) {
      this.event("ERROR", "genio.one.gateway-observation.outbox.delete-failed", {
        file: fileName,
        path: record.path,
        correlation_id: record.correlation_id,
        ...operationalError(error),
      })
      this.lastDeliveryFailure = this.healthEvent(fileName, record, undefined, error)
    }
  }

  private async quarantine(
    path: string,
    fileName: string,
    record: ObservationRecord | undefined,
    reason: string,
    status?: number,
    error?: unknown,
  ): Promise<void> {
    try {
      await rename(path, join(this.quarantineDirectory, fileName))
      await syncDirectory(this.pendingDirectory)
      await syncDirectory(this.quarantineDirectory)
      this.retries.delete(path)
      this.event("ERROR", "genio.one.gateway-observation.outbox.quarantined", {
        file: fileName,
        path: record?.path ?? null,
        correlation_id: record?.correlation_id ?? null,
        reason,
      })
      this.lastDeliveryFailure = this.healthEvent(fileName, record, status, error)
    } catch (error) {
      this.event("ERROR", "genio.one.gateway-observation.outbox.quarantine-failed", {
        file: fileName,
        path: record?.path ?? null,
        correlation_id: record?.correlation_id ?? null,
        reason,
        ...operationalError(error),
      })
      this.blocked = true
      this.blockedReason = "outbox quarantine failed"
      this.lastDeliveryFailure = this.healthEvent(fileName, record, undefined, error)
    }
  }

  private async entries(directory: string): Promise<StoredEntry[]> {
    const entries = await readdir(directory, { withFileTypes: true })
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
    const result: StoredEntry[] = []
    for (const fileName of files) {
      const path = join(directory, fileName)
      try {
        const metadata = await stat(path)
        result.push({
          fileName,
          path,
          size: metadata.size,
          createdAt: entryCreatedAt(fileName, metadata.mtimeMs),
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    return result
  }

  private async usage(): Promise<{ files: number; bytes: number }> {
    const [pending, quarantine, staleTemps] = await Promise.all([
      this.directoryUsage(this.pendingDirectory),
      this.directoryUsage(this.quarantineDirectory),
      this.temporaryEntries(this.pendingDirectory),
    ])
    return {
      files: pending.files.length + quarantine.files.length + staleTemps.length,
      bytes: pending.bytes + quarantine.bytes + staleTemps.reduce((sum, entry) => sum + entry.size, 0),
    }
  }

  private async directoryUsage(directory: string): Promise<DirectoryUsage> {
    const files = await this.entries(directory)
    return {
      files,
      bytes: files.reduce((sum, entry) => sum + entry.size, 0),
    }
  }

  private async temporaryEntries(directory: string): Promise<StoredEntry[]> {
    const entries = await readdir(directory, { withFileTypes: true })
    const result: StoredEntry[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue
      const path = join(directory, entry.name)
      try {
        const metadata = await stat(path)
        result.push({ fileName: entry.name, path, size: metadata.size, createdAt: metadata.mtimeMs })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    return result
  }

  private async recoverTemporaryFiles(): Promise<void> {
    let staleTemps: StoredEntry[]
    try {
      staleTemps = await this.temporaryEntries(this.pendingDirectory)
    } catch (error) {
      this.blocked = true
      this.blockedReason = "stale temporary outbox files could not be inspected"
      this.event("ERROR", "genio.one.gateway-observation.outbox.temp-scan-failed", operationalError(error))
      return
    }
    for (const entry of staleTemps) {
      try {
        await unlink(entry.path)
        await syncDirectory(this.pendingDirectory)
        this.event("WARN", "genio.one.gateway-observation.outbox.temp-cleaned", {
          file: entry.fileName,
          bytes: entry.size,
        })
      } catch (error) {
        this.blocked = true
        this.blockedReason = "stale temporary outbox files could not be cleaned"
        this.event("ERROR", "genio.one.gateway-observation.outbox.temp-cleanup-failed", {
          file: entry.fileName,
          bytes: entry.size,
          ...operationalError(error),
        })
      }
    }
  }

  private healthEvent(
    fileName: string,
    record: ObservationRecord | undefined,
    status?: number,
    error?: unknown,
  ): ObservationOutboxHealthEvent {
    const details = error ? operationalError(error) : { error_name: null, error_message: null }
    return {
      at: this.now(),
      file: fileName,
      path: record?.path ?? null,
      correlation_id: record?.correlation_id ?? null,
      status: status ?? null,
      error_name: details.error_name,
      error_message: details.error_message,
    }
  }

  private async withMutation(operation: () => Promise<void>): Promise<void> {
    const previous = this.mutation
    let release!: () => void
    this.mutation = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      await operation()
    } finally {
      release()
    }
  }

  private event(
    level: "INFO" | "WARN" | "ERROR",
    event: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void {
    try {
      writeOperationalEvent("gateway-runtime", level, event, fields)
    } catch {}
  }
}

export async function createObservationOutbox(options: ObservationOutboxOptions): Promise<ObservationOutbox> {
  const outbox = new ObservationOutbox(options)
  await outbox.initialise()
  return outbox
}
