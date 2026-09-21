import type { ChildProcess } from "node:child_process"
import { readFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { join } from "node:path"

const STOP_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 250

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function processHasExited(child: Pick<ChildProcess, "exitCode" | "signalCode">): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32" || child.pid === undefined) {
    if (!processHasExited(child)) child.kill(signal)
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    if (!processHasExited(child)) child.kill(signal)
  }
}

function processTreeHasExited(child: ChildProcess): boolean {
  if (process.platform === "win32" || child.pid === undefined) return processHasExited(child)
  try {
    process.kill(-child.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
  }
}

async function waitForExit(
  child: ChildProcess,
  hasExited: (child: ChildProcess) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasExited(child)) return true
    await sleep(Math.min(50, deadline - Date.now()))
  }
  return hasExited(child)
}

async function stop(
  child: ChildProcess | undefined,
  hasExited: (child: ChildProcess) => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  if (!child) return
  signalProcessTree(child, "SIGTERM")
  if (await waitForExit(child, hasExited, timeoutMs)) return
  signalProcessTree(child, "SIGKILL")
  if (await waitForExit(child, hasExited, timeoutMs)) return
  throw new Error(`${description} did not exit after SIGKILL`)
}

export function stopProcessTree(child: ChildProcess | undefined, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  return stop(child, processTreeHasExited, timeoutMs, "aigw process group")
}

export function stopChild(child: ChildProcess | undefined, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  return stop(child, processHasExited, timeoutMs, "gateway service process")
}

async function pollUntilReady(
  child: Pick<ChildProcess, "exitCode">,
  timeoutMs: number,
  attempt: () => Promise<boolean>,
  exitedMessage: string,
  timeoutMessage: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${exitedMessage} with code ${child.exitCode}`)
    if (await attempt()) return
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(timeoutMessage)
}

export function waitForHealth(origin: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  return pollUntilReady(child, timeoutMs, async () => {
    try {
      return (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) })).ok
    } catch {
      return false
    }
  }, "aigw run exited before readiness", "aigw run did not become ready before the deadline")
}

function envoyAdminOrigin(address: string): string | undefined {
  const match = /^127\.0\.0\.1:(\d{1,5})\s*$/.exec(address)
  if (!match) return undefined
  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  return `http://127.0.0.1:${port}`
}

export function waitForEnvoyRunReadiness(
  runtimeDirectory: string,
  runId: string,
  child: Pick<ChildProcess, "exitCode">,
  timeoutMs: number,
): Promise<void> {
  const adminAddressPath = join(runtimeDirectory, runId, "admin-address.txt")
  return pollUntilReady(child, timeoutMs, async () => {
    try {
      const origin = envoyAdminOrigin(await readFile(adminAddressPath, "utf8"))
      if (!origin) return false
      return (await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(1_000) })).ok
    } catch {
      return false
    }
  }, "aigw run exited before Envoy readiness", "aigw Envoy run did not become ready before the deadline")
}

export function waitForListener(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  return pollUntilReady(child, timeoutMs, () => new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    const finish = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1_000, () => finish(false))
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  }), "aigw run exited before Envoy readiness", "Envoy listener did not become ready before the deadline")
}
