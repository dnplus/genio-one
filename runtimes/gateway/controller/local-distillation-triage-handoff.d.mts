export type DistillationTriageHandoffPhase = "taking-over" | "ready"

export interface DistillationTriageHandoff {
  path: string
  targetPath: string
  contents: string
  phase: DistillationTriageHandoffPhase
  generation?: string
  managed: boolean
}

export function distillationTriageHandoffPath(checkoutRoot: string): string
export function distillationTriageHandoffLockPath(checkoutRoot: string): string
export function parseDistillationTriageHandoff(contents: unknown): {
  phase: DistillationTriageHandoffPhase
  generation: string | undefined
}
export function readDistillationTriageHandoff(checkoutRoot: string): DistillationTriageHandoff | undefined
export function createDistillationTriageHandoff(
  checkoutRoot: string,
  phase?: DistillationTriageHandoffPhase,
): DistillationTriageHandoff
export function promoteDistillationTriageHandoff(
  handoff: DistillationTriageHandoff,
  phase: DistillationTriageHandoffPhase,
): DistillationTriageHandoff | undefined
export function removeDistillationTriageHandoff(handoff: DistillationTriageHandoff): boolean
