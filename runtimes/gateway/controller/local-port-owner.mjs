import { spawnSync } from "node:child_process"
import { readlinkSync } from "node:fs"
import { createConnection } from "node:net"
import { resolve, sep } from "node:path"

export const LOCAL_DISTILLATION_TRIAGE_MARKER = "local-distillation-triage.ts"
export const LOCAL_PROCESSOR_SERVER_MARKER = "services/processor/server.ts"

export function distillationPortRole(owner, checkoutRoot) {
  if (!owner.cwd?.trim()) return "other"
  const root = resolve(checkoutRoot)
  const cwd = resolve(owner.cwd)
  const inside = cwd === root || cwd.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  if (!inside || !owner.command) return "other"
  if (owner.command.includes(LOCAL_DISTILLATION_TRIAGE_MARKER)) return "local-triage"
  if (owner.command.includes(LOCAL_PROCESSOR_SERVER_MARKER)) return "processor"
  return "other"
}

export function listeningPids(port) {
  const lsof = spawnSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN", "-n", "-P"], { encoding: "utf8" })
  const lsofOwners = lsof.status === 0
    ? lsof.stdout.trim().split(/\s+/).filter((value) => /^\d+$/.test(value))
    : []
  if (lsofOwners.length > 0) return [...new Set(lsofOwners)]

  // lsof is not installed on every supported local development host. ss is
  // available on current Linux distributions and exposes the listener PID.
  const ss = spawnSync("ss", ["-ltnp", `sport = :${port}`], { encoding: "utf8" })
  const ssOutput = typeof ss.stdout === "string" ? ss.stdout : ""
  const ssOwners = [...ssOutput.matchAll(/pid=(\d+)/g)].map((match) => match[1] ?? "").filter(Boolean)
  if (ssOwners.length > 0) return [...new Set(ssOwners)]

  // fuser is the portability fallback for smaller Linux images without ss.
  const fuser = spawnSync("fuser", ["-n", "tcp", String(port)], { encoding: "utf8" })
  if (fuser.status !== 0 || typeof fuser.stdout !== "string") return []
  return [...new Set(fuser.stdout.match(/\b\d+\b/g)?.filter((value) => value !== String(port)) ?? [])]
}

export function processCommand(pid) {
  const result = spawnSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : ""
}

export function processCwd(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    const result = spawnSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8" })
    const path = typeof result.stdout === "string"
      ? result.stdout.split(/\r?\n/).find((line) => line.startsWith("n"))?.slice(1)
      : ""
    return path ?? ""
  }
}

export function listeningPortOwners(port) {
  return listeningPids(port).map((pid) => ({
    pid,
    cwd: processCwd(pid),
    command: processCommand(pid),
  }))
}

export function portOwnerRevalidation(owner, currentOwner) {
  if (!currentOwner.cwd && !currentOwner.command) return "exited"
  return currentOwner.cwd === owner.cwd && currentOwner.command === owner.command ? "current" : "changed"
}

export function portIsOccupied(port) {
  return new Promise((resolveOccupied) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    const finish = (occupied) => {
      socket.destroy()
      resolveOccupied(occupied)
    }
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.setTimeout(300, () => finish(false))
  })
}
