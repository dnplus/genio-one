import { randomUUID } from "node:crypto"
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const lockTimeoutMs = 5_000
const uninitializedLockStaleMs = 30_000

export function distillationTriageHandoffPath(checkoutRoot) {
  return resolve(checkoutRoot, "apps/platform/.local/gateway-runtime/distillation-triage-handoff")
}

export function distillationTriageHandoffLockPath(checkoutRoot) {
  return `${distillationTriageHandoffPath(checkoutRoot)}.lock`
}

export function parseDistillationTriageHandoff(contents) {
  const [phase, generation] = typeof contents === "string" ? contents.split(/\r?\n/, 2) : []
  if ((phase === "taking-over" || phase === "ready") && generation) return { phase, generation }
  return { phase: "ready", generation: undefined }
}

export function readDistillationTriageHandoff(checkoutRoot) {
  return readHandoffAtPath(distillationTriageHandoffPath(checkoutRoot))
}

function readHandoffAtPath(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return undefined
  }
  if (!stat.isSymbolicLink()) {
    try {
      const contents = readFileSync(path, "utf8")
      return { path, targetPath: path, contents, ...parseDistillationTriageHandoff(contents), managed: false }
    } catch {
      return undefined
    }
  }
  let targetPath
  try {
    targetPath = resolve(dirname(path), readlinkSync(path))
  } catch {
    return undefined
  }
  if (dirname(targetPath) !== dirname(path) || !basename(targetPath).startsWith(`${basename(path)}.`)) return undefined
  try {
    const contents = readFileSync(targetPath, "utf8")
    const parsed = parseDistillationTriageHandoff(contents)
    if (!parsed.generation || targetPath !== `${path}.${parsed.generation}`) return undefined
    return { path, targetPath, contents, ...parsed, managed: true }
  } catch {
    return undefined
  }
}

export function createDistillationTriageHandoff(checkoutRoot, phase = "taking-over") {
  return withTriageHandoffLock(checkoutRoot, () => {
    const path = distillationTriageHandoffPath(checkoutRoot)
    mkdirSync(dirname(path), { recursive: true })
    const previous = readHandoffAtPath(path)
    const handoff = writeGeneration(path, phase)
    try {
      pointCurrentHandoff(path, handoff.targetPath)
      if (previous?.managed) {
        try {
          rmSync(previous.targetPath, { force: true })
        } catch {}
      }
      return handoff
    } catch (error) {
      rmSync(handoff.targetPath, { force: true })
      throw error
    }
  })
}

export function promoteDistillationTriageHandoff(handoff, phase) {
  if (!handoff?.managed) return undefined
  return withHandoffLockPath(handoff.path, () => {
    const current = readHandoffAtPath(handoff.path)
    if (!sameHandoff(current, handoff)) return undefined
    const next = writeGeneration(handoff.path, phase)
    try {
      pointCurrentHandoff(handoff.path, next.targetPath)
      try {
        rmSync(handoff.targetPath, { force: true })
      } catch {}
      return next
    } catch (error) {
      rmSync(next.targetPath, { force: true })
      throw error
    }
  })
}

export function removeDistillationTriageHandoff(handoff) {
  if (!handoff?.managed) return false
  return withHandoffLockPath(handoff.path, () => {
    let contents
    try {
      contents = readFileSync(handoff.targetPath, "utf8")
    } catch {
      return false
    }
    if (!sameHandoff({ ...handoff, contents, ...parseDistillationTriageHandoff(contents) }, handoff)) return false
    rmSync(handoff.targetPath, { force: true })
    return true
  })
}

function writeGeneration(path, phase) {
  if (phase !== "taking-over" && phase !== "ready") throw new Error(`Unsupported distillation triage handoff phase: ${phase}`)
  const generation = randomUUID()
  const targetPath = `${path}.${generation}`
  const contents = `${phase}\n${generation}\n`
  writeFileSync(targetPath, contents, { mode: 0o600, flag: "wx" })
  return { path, targetPath, contents, phase, generation, managed: true }
}

function pointCurrentHandoff(path, targetPath) {
  const temporaryPath = `${path}.pointer-${randomUUID()}`
  try {
    symlinkSync(basename(targetPath), temporaryPath)
    renameSync(temporaryPath, path)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

function sameHandoff(left, right) {
  return Boolean(left && right) &&
    left.managed === right.managed &&
    left.path === right.path &&
    left.targetPath === right.targetPath &&
    left.contents === right.contents &&
    left.generation === right.generation
}

function withTriageHandoffLock(checkoutRoot, operation) {
  return withHandoffLockPath(distillationTriageHandoffPath(checkoutRoot), operation)
}

function withHandoffLockPath(path, operation) {
  const lockPath = `${path}.lock`
  mkdirSync(dirname(lockPath), { recursive: true })
  const owner = acquireLock(lockPath)
  try {
    return operation()
  } finally {
    releaseLock(lockPath, owner)
  }
}

function acquireLock(lockPath) {
  const deadline = Date.now() + lockTimeoutMs
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    processStartedAt: processStartedAt(process.pid),
  }
  while (true) {
    try {
      mkdirSync(lockPath)
      try {
        writeFileSync(`${lockPath}/owner.json`, JSON.stringify(owner), { mode: 0o600, flag: "wx" })
        return owner
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true })
        throw error
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
    }
    if (reclaimStaleLock(lockPath)) continue
    if (Date.now() >= deadline) throw new Error(`Timed out acquiring distillation triage handoff lock: ${lockPath}`)
    waitForLock(10)
  }
}

function releaseLock(lockPath, owner) {
  try {
    const current = JSON.parse(readFileSync(`${lockPath}/owner.json`, "utf8"))
    if (current?.token !== owner.token) return
    rmSync(lockPath, { recursive: true, force: true })
  } catch {}
}

function reclaimStaleLock(lockPath) {
  const snapshot = staleLockSnapshot(lockPath)
  if (!snapshot) return false
  if (!sameLockSnapshot(lockPath, snapshot)) return false
  const stalePath = `${lockPath}.stale-${randomUUID()}`
  try {
    renameSync(lockPath, stalePath)
  } catch {
    return false
  }
  rmSync(stalePath, { recursive: true, force: true })
  return true
}

function staleLockSnapshot(lockPath) {
  let contents
  let owner
  try {
    contents = readFileSync(`${lockPath}/owner.json`, "utf8")
    owner = JSON.parse(contents)
  } catch {
    return lockAgeExceeded(lockPath) ? { contents: undefined } : undefined
  }
  if (!Number.isInteger(owner?.pid) || typeof owner?.processStartedAt !== "string") {
    return lockAgeExceeded(lockPath) ? { contents } : undefined
  }
  if (!processIsAlive(owner.pid)) return { contents }
  const currentStartedAt = processStartedAt(owner.pid)
  return currentStartedAt && currentStartedAt !== owner.processStartedAt ? { contents } : undefined
}

function sameLockSnapshot(lockPath, snapshot) {
  try {
    return readFileSync(`${lockPath}/owner.json`, "utf8") === snapshot.contents
  } catch {
    return snapshot.contents === undefined && lockAgeExceeded(lockPath)
  }
}

function lockAgeExceeded(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs >= uninitializedLockStaleMs
  } catch {
    return false
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function processStartedAt(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : ""
}

function waitForLock(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}
