import { randomUUID, createHash } from "node:crypto"
import type { Dir } from "node:fs"
import { chmod, mkdir, open, opendir, readFile, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"

import { verifyGatewayRuntimeCommand } from "@genioone/protocol/runtime-command"
import type { VerificationKeyRing } from "@genioone/protocol/compact-jws"
import { requireRelease, type GatewayRuntimeState } from "./runtime"

export const NATIVE_ACTIVITY_SOURCE_LIMITS = {
  readBytes: 64 * 1024,
  lines: 64,
  lineBytes: 16 * 1024 * 1024,
  contextBytes: 128 * 1024 * 1024,
  directories: 32,
} as const

interface SourceContext extends GatewayRuntimeState {
  schema_version: 1
  state: "OPEN" | "SEALED"
}

interface SourceState {
  root: string
  context: SourceContext
  cursor: number
  scannedLines: number
  position: number
  buffer: Buffer
  pending: string[]
  eof: boolean
}

export interface NativeActivityBatch {
  root: string
  context: GatewayRuntimeState
  lines: readonly string[]
  lineOffset: number
  persistCursor(consumed: number): Promise<void>
}

interface NativeActivitySourceOptions {
  stateRoot: string
  runtimeCommandKeyRingPath: string
  consume(batch: NativeActivityBatch): Promise<number>
  onError(input: { releaseId?: string; error: unknown }): void
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const candidate = `${path}.${randomUUID()}.candidate`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(candidate, "wx", 0o600)
    await handle.writeFile(content, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(candidate, path)
    const directory = await open(join(path, ".."), "r")
    try { await directory.sync() } finally { await directory.close() }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(candidate, { force: true }).catch(() => undefined)
    throw error
  }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function boundedText(path: string, maximum: number): Promise<string> {
  const handle = await open(path, "r")
  try {
    const details = await handle.stat()
    if (!details.isFile() || details.size > maximum) throw new Error("Native activity metadata exceeds its read limit")
    const bytes = Buffer.alloc(details.size)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (result.bytesRead === 0) throw new Error("Native activity metadata changed while reading")
      offset += result.bytesRead
    }
    return bytes.toString("utf8")
  } finally {
    await handle.close()
  }
}

async function boundedJson(path: string, maximum: number): Promise<unknown> {
  return JSON.parse(await boundedText(path, maximum))
}

function receiptPath(root: string, correlationId: string): string {
  return join(root, "activity-receipts", `${createHash("sha256").update(correlationId).digest("hex")}.json`)
}

export async function writeNativeActivityReceipt(
  root: string,
  correlationId: string,
  value: unknown,
): Promise<void> {
  await privateDirectory(root)
  await privateDirectory(join(root, "activity-receipts"))
  const content = JSON.stringify(value)
  if (Buffer.byteLength(content) > NATIVE_ACTIVITY_SOURCE_LIMITS.lineBytes) {
    throw new Error("Native activity receipt exceeds its read limit")
  }
  await atomicWrite(receiptPath(root, correlationId), content)
}

export async function readNativeActivityReceipt(root: string, correlationId: string): Promise<unknown | null> {
  try {
    return await boundedJson(receiptPath(root, correlationId), NATIVE_ACTIVITY_SOURCE_LIMITS.lineBytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export function createNativeActivitySourceManager(options: NativeActivitySourceOptions) {
  let target: { tenantId: string; runtimeId: string; gatewayId: string } | undefined
  let currentReleaseId: string | undefined
  let current: SourceState | undefined
  let historical: SourceState | undefined
  let directory: Dir | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let draining: Promise<void> | undefined
  let mutations = Promise.resolve()
  let closed = false
  let bootstrapped = false
  const reportedLegacy = new Set<string>()

  function mutate<T>(action: () => Promise<T>): Promise<T> {
    const operation = mutations.then(action)
    mutations = operation.then(() => undefined, () => undefined)
    return operation
  }

  async function verified(value: unknown): Promise<GatewayRuntimeState> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Native activity source context is invalid")
    const record = value as Record<string, unknown>
    const keyRing = JSON.parse(await readFile(options.runtimeCommandKeyRingPath, "utf8")) as VerificationKeyRing
    const command = verifyGatewayRuntimeCommand(record.command, keyRing)
    if (!target || command.tenant_id !== target.tenantId || command.runtime_id !== target.runtimeId ||
      command.desired_release.gateway_id !== target.gatewayId) {
      throw new Error("Native activity source does not match the Gateway deployment")
    }
    return { command, release: requireRelease(record.release, command) }
  }

  async function readContext(root: string, completed = false): Promise<SourceContext> {
    const value = await boundedJson(join(root, completed ? "activity-source.complete.json" : "activity-source.json"),
      NATIVE_ACTIVITY_SOURCE_LIMITS.contextBytes)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Native activity source context is invalid")
    const record = value as Record<string, unknown>
    if (Object.keys(record).length !== 4 || record.schema_version !== 1 ||
      (record.state !== "OPEN" && record.state !== "SEALED")) throw new Error("Native activity source context is invalid")
    const context = await verified(record)
    if (join(options.stateRoot, context.release.release_id) !== root) throw new Error("Native activity source path does not match its release")
    return { schema_version: 1, state: record.state, ...context }
  }

  async function load(root: string): Promise<SourceState> {
    const context = await readContext(root)
    let cursor = 0
    try {
      const text = (await boundedText(join(root, "activity.cursor"), 32)).trim()
      if (!/^(0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error("Activity cursor is invalid")
      cursor = Number(text)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return { root, context, cursor, scannedLines: 0, position: 0, buffer: Buffer.alloc(0), pending: [], eof: false }
  }

  async function bootstrapPreviousSource(): Promise<void> {
    try {
      const saved = await boundedJson(join(options.stateRoot, "current.json"), NATIVE_ACTIVITY_SOURCE_LIMITS.contextBytes)
      if (!saved || typeof saved !== "object" || Array.isArray(saved) || Object.keys(saved).length !== 2) {
        throw new Error("Persisted Gateway state is invalid for native activity recovery")
      }
      const context = await verified(saved)
      const root = join(options.stateRoot, context.release.release_id)
      const log = await stat(join(root, "activity.jsonl"))
      if (!log.isFile()) throw new Error("Persisted native activity source is not a file")
      await mutate(async () => {
        const hasContext = await stat(join(root, "activity-source.json")).then(() => true, () => false)
        const completeContext = await stat(join(root, "activity-source.complete.json")).then(() => true, () => false)
        if (hasContext || completeContext) return
        await privateDirectory(root)
        const record: SourceContext = { schema_version: 1, state: "OPEN", ...context }
        await atomicWrite(join(root, "activity-source.json"), JSON.stringify(record))
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") options.onError({ error })
    }
  }

  async function reportLegacy(root: string, releaseId: string): Promise<void> {
    if (reportedLegacy.has(releaseId)) return
    const completed = await stat(join(root, "activity-source.complete.json")).then(() => true, () => false)
    if (completed) return
    const log = await stat(join(root, "activity.jsonl")).catch(() => undefined)
    if (!log?.isFile() || log.size === 0) return
    if (reportedLegacy.size >= NATIVE_ACTIVITY_SOURCE_LIMITS.directories) reportedLegacy.delete(reportedLegacy.values().next().value!)
    reportedLegacy.add(releaseId)
    options.onError({ releaseId, error: new Error("Native activity log has no verified release context; retained without acknowledgement") })
  }

  async function nextHistorical(): Promise<SourceState | undefined> {
    directory ??= await opendir(options.stateRoot, { bufferSize: 8 })
    for (let count = 0; count < NATIVE_ACTIVITY_SOURCE_LIMITS.directories; count += 1) {
      const entry = await directory.read()
      if (!entry) {
        await directory.close()
        directory = undefined
        return undefined
      }
      if (!entry.isDirectory() || entry.name === currentReleaseId) continue
      try {
        return await load(join(options.stateRoot, entry.name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") options.onError({ releaseId: entry.name, error })
        else await reportLegacy(join(options.stateRoot, entry.name), entry.name)
      }
    }
    return undefined
  }

  async function readBatch(source: SourceState): Promise<void> {
    if (source.pending.length > 0) return
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let readBytes = 0
    let examinedLines = 0
    try {
      while (source.pending.length < NATIVE_ACTIVITY_SOURCE_LIMITS.lines && examinedLines < NATIVE_ACTIVITY_SOURCE_LIMITS.lines) {
        const newline = source.buffer.indexOf(10)
        if (newline >= 0) {
          if (newline > NATIVE_ACTIVITY_SOURCE_LIMITS.lineBytes) throw new Error("Native activity line exceeds its read limit")
          const line = source.buffer.subarray(0, newline).toString("utf8")
          source.buffer = Buffer.from(source.buffer.subarray(newline + 1))
          source.scannedLines += 1
          examinedLines += 1
          if (source.scannedLines > source.cursor) source.pending.push(line)
          continue
        }
        if (source.buffer.length > NATIVE_ACTIVITY_SOURCE_LIMITS.lineBytes) throw new Error("Native activity line exceeds its read limit")
        if (readBytes >= NATIVE_ACTIVITY_SOURCE_LIMITS.readBytes) break
        handle ??= await open(join(source.root, "activity.jsonl"), "r")
        const bytes = Buffer.alloc(NATIVE_ACTIVITY_SOURCE_LIMITS.readBytes - readBytes)
        const result = await handle.read(bytes, 0, bytes.length, source.position)
        source.eof = result.bytesRead === 0
        if (source.eof) break
        source.position += result.bytesRead
        readBytes += result.bytesRead
        source.buffer = Buffer.concat([source.buffer, bytes.subarray(0, result.bytesRead)])
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") source.eof = true
      else throw error
    } finally {
      await handle?.close()
    }
  }

  async function complete(source: SourceState): Promise<boolean> {
    if (source.context.state !== "SEALED" || !source.eof || source.buffer.length > 0 || source.pending.length > 0 || source.scannedLines !== source.cursor) return false
    return mutate(async () => {
      const context = await readContext(source.root)
      if (context.state !== "SEALED") return false
      const size = await stat(join(source.root, "activity.jsonl")).then((details) => details.size, (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
        throw error
      })
      if (size !== source.position) return false
      await rename(join(source.root, "activity-source.json"), join(source.root, "activity-source.complete.json"))
      return true
    })
  }

  async function consume(source: SourceState): Promise<boolean> {
    await readBatch(source)
    if (source.pending.length > 0) {
      const initial = source.cursor
      const pendingCount = source.pending.length
      try {
        const consumed = await options.consume({
          root: source.root,
          context: source.context,
          lines: source.pending,
          lineOffset: initial,
          async persistCursor(count) {
            if (!Number.isSafeInteger(count) || count < 1 || count > pendingCount) throw new Error("Activity cursor is invalid")
            const cursor = initial + count
            if (cursor !== source.cursor + 1) throw new Error("Native activity cursor skipped an unacknowledged line")
            await atomicWrite(join(source.root, "activity.cursor"), `${cursor}\n`)
            source.cursor = cursor
          },
        })
        if (!Number.isSafeInteger(consumed) || consumed < 0 || consumed > pendingCount || source.cursor !== initial + consumed) {
          throw new Error("Native activity batch did not acknowledge its persisted cursor")
        }
      } finally {
        source.pending.splice(0, source.cursor - initial)
      }
      if (source.pending.length > 0) return false
    }
    if (source.eof && source.scannedLines < source.cursor) throw new Error("Native activity log is shorter than its acknowledged cursor")
    if (await complete(source)) {
      if (current === source) current = undefined
      return false
    }
    return !source.eof
  }

  function drain(): Promise<void> {
    if (draining) return draining
    const operation = (async () => {
      const releaseId = currentReleaseId
      if (releaseId) {
        try {
          const source = current?.context.release.release_id === releaseId ? current : await load(join(options.stateRoot, releaseId))
          if (currentReleaseId === releaseId) current = source
          await consume(source)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") options.onError({ releaseId, error })
        }
      }
      try {
        historical ??= await nextHistorical()
        if (historical && !(await consume(historical))) historical = undefined
      } catch (error) {
        options.onError({ releaseId: historical?.context.release.release_id, error })
        historical = undefined
      }
    })().finally(() => { if (draining === operation) draining = undefined })
    draining = operation
    return operation
  }

  function schedule(): void {
    if (closed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void drain().finally(schedule)
    }, 100)
    timer.unref?.()
  }

  return {
    async start(input: GatewayRuntimeState): Promise<void> {
      const deployment = { tenantId: input.command.tenant_id, runtimeId: input.command.runtime_id,
        gatewayId: input.command.desired_release.gateway_id }
      if (target && JSON.stringify(target) !== JSON.stringify(deployment)) throw new Error("Native activity Gateway deployment changed")
      target = deployment
      await verified(input)
      await privateDirectory(options.stateRoot)
      if (!bootstrapped) {
        await bootstrapPreviousSource()
        bootstrapped = true
      }
      schedule()
    },
    async register(input: GatewayRuntimeState): Promise<void> {
      const context = await verified(input)
      await mutate(async () => {
        const root = join(options.stateRoot, context.release.release_id)
        await privateDirectory(root)
        let previous: SourceContext | undefined
        try {
          previous = await readContext(root)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          try {
            previous = await readContext(root, true)
          } catch (completedError) {
            if ((completedError as NodeJS.ErrnoException).code !== "ENOENT") throw completedError
          }
        }
        if (previous && previous.release.package_digest !== context.release.package_digest) throw new Error("Native activity release context changed")
        const record: SourceContext = { schema_version: 1, state: "OPEN",
          command: previous?.command ?? context.command, release: previous?.release ?? context.release }
        await atomicWrite(join(root, "activity-source.json"), JSON.stringify(record))
        currentReleaseId = context.release.release_id
        current = undefined
        if (historical?.context.release.release_id === currentReleaseId) historical = undefined
      })
    },
    async seal(releaseId: string): Promise<void> {
      await mutate(async () => {
        const root = join(options.stateRoot, releaseId)
        const context = await readContext(root)
        context.state = "SEALED"
        await atomicWrite(join(root, "activity-source.json"), JSON.stringify(context))
        if (current?.context.release.release_id === releaseId) current.context.state = "SEALED"
        if (historical?.context.release.release_id === releaseId) historical.context.state = "SEALED"
      })
    },
    clearCurrent(): void {
      currentReleaseId = undefined
      current = undefined
    },
    drain,
    async close(): Promise<void> {
      closed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      await draining
      await drain()
      await mutations
      await directory?.close()
      directory = undefined
      current = undefined
      historical = undefined
    },
  }
}
