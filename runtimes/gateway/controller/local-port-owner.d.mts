export interface PortOwner {
  pid: string
  cwd: string
  command: string
}

export type DistillationPortRole = "local-triage" | "processor" | "other"
export type PortOwnerRevalidation = "current" | "exited" | "changed"

export const LOCAL_DISTILLATION_TRIAGE_MARKER: "local-distillation-triage.ts"
export const LOCAL_PROCESSOR_SERVER_MARKER: "services/processor/server.ts"

export function distillationPortRole(
  owner: Pick<PortOwner, "cwd" | "command">,
  checkoutRoot: string,
): DistillationPortRole
export function listeningPids(port: number): string[]
export function processCommand(pid: string): string
export function processCwd(pid: string): string
export function listeningPortOwners(port: number): PortOwner[]
export function portOwnerRevalidation(
  owner: Pick<PortOwner, "cwd" | "command">,
  currentOwner: Pick<PortOwner, "cwd" | "command">,
): PortOwnerRevalidation
export function portIsOccupied(port: number): Promise<boolean>
