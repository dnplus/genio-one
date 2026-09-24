import {
  createDistillationTriageHandoff,
  distillationTriageHandoffPath,
  type DistillationTriageHandoff,
} from "./local-distillation-triage-handoff.mjs"
import {
  distillationPortRole,
  listeningPortOwners,
  portIsOccupied,
  portOwnerRevalidation,
  processCommand,
  processCwd,
} from "./local-port-owner.mjs"

export const LOCAL_DISTILLATION_TRIAGE_PORT = 8182
export { LOCAL_DISTILLATION_TRIAGE_MARKER, LOCAL_PROCESSOR_SERVER_MARKER } from "./local-port-owner.mjs"

export interface DistillationPortOwner {
  pid: string
  cwd: string
  command: string
}

export type DistillationTriagePortRelease = "idle" | "retained-processor" | "standalone-triage"
export type DistillationOwnerRevalidation = "current" | "exited" | "changed"

export { distillationPortRole, distillationTriageHandoffPath }

export function assertKnownDistillationPortOwnership(
  owners: readonly DistillationPortOwner[],
  portOccupied: boolean,
): void {
  if (portOccupied && owners.length === 0) {
    throw new Error("port 8182 is listening but its PID, cwd, and command could not be verified")
  }
}

export async function releaseLocalDistillationTriage(input: {
  checkoutRoot: string
  owners: DistillationPortOwner[]
  writeHandoff: (path: string) => void
  stopPid: (pid: string) => void
  waitUntilPortFree: () => Promise<boolean>
  revalidateOwner?(owner: DistillationPortOwner): DistillationOwnerRevalidation
}): Promise<DistillationTriagePortRelease> {
  if (input.owners.length === 0) return "idle"
  const roles = input.owners.map((owner) => distillationPortRole(owner, input.checkoutRoot))
  if (roles.every((role) => role === "processor")) {
    input.writeHandoff(distillationTriageHandoffPath(input.checkoutRoot))
    stopReleasedOwners(input, input.owners)
    if (!(await input.waitUntilPortFree())) throw new Error("retained processor did not release port 8182")
    return "retained-processor"
  }
  if (!roles.every((role) => role === "local-triage")) {
    throw new Error("port 8182 is occupied by a process other than the local distillation triage")
  }
  input.writeHandoff(distillationTriageHandoffPath(input.checkoutRoot))
  stopReleasedOwners(input, input.owners)
  if (!(await input.waitUntilPortFree())) throw new Error("local distillation triage did not release port 8182")
  return "standalone-triage"
}

function stopReleasedOwners(
  input: Pick<Parameters<typeof releaseLocalDistillationTriage>[0], "revalidateOwner" | "stopPid">,
  owners: readonly DistillationPortOwner[],
): void {
  for (const owner of owners) {
    const state = input.revalidateOwner?.(owner) ?? "current"
    if (state === "changed") throw new Error(`port 8182 owner ${owner.pid} changed before signal`)
    if (state === "exited") continue
    input.stopPid(owner.pid)
  }
}

function signalPid(pid: string, signal: NodeJS.Signals): void {
  try {
    process.kill(Number(pid), signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

function ownerRevalidation(owner: DistillationPortOwner): DistillationOwnerRevalidation {
  return portOwnerRevalidation(owner, { cwd: processCwd(owner.pid), command: processCommand(owner.pid) })
}

function signalOwner(owner: DistillationPortOwner, signal: NodeJS.Signals): void {
  const state = ownerRevalidation(owner)
  if (state === "changed") throw new Error(`port 8182 owner ${owner.pid} changed before signal`)
  if (state === "exited") return
  signalPid(owner.pid, signal)
}

export async function releaseLocalDistillationTriageForProcessor(
  checkoutRoot: string,
): Promise<DistillationTriageHandoff> {
  const owners = listeningPortOwners(LOCAL_DISTILLATION_TRIAGE_PORT)
  assertKnownDistillationPortOwnership(owners, await portIsOccupied(LOCAL_DISTILLATION_TRIAGE_PORT))
  let handoff: DistillationTriageHandoff | undefined
  await releaseLocalDistillationTriage({
    checkoutRoot,
    owners,
    writeHandoff(path) {
      if (path !== distillationTriageHandoffPath(checkoutRoot)) {
        throw new Error("distillation triage handoff path changed during release")
      }
      handoff = createDistillationTriageHandoff(checkoutRoot, "taking-over")
    },
    stopPid(pid) {
      signalPid(pid, "SIGTERM")
    },
    revalidateOwner: ownerRevalidation,
    async waitUntilPortFree() {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        if (!(await portIsOccupied(LOCAL_DISTILLATION_TRIAGE_PORT))) return true
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      }
      for (const owner of owners) signalOwner(owner, "SIGKILL")
      const killDeadline = Date.now() + 1_000
      while (Date.now() < killDeadline) {
        if (!(await portIsOccupied(LOCAL_DISTILLATION_TRIAGE_PORT))) return true
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      }
      return false
    },
  })
  return handoff ?? createDistillationTriageHandoff(checkoutRoot, "taking-over")
}
