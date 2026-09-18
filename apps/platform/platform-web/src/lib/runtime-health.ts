import type { RuntimeInventoryEntry } from "@/domain/contracts"

export function runtimeConvergence(runtime: RuntimeInventoryEntry) {
  if (!runtime.observed_state) return "Never reported"
  if (runtime.in_sync && runtime.pending_command_count === 0) return "In sync"
  if (runtime.pending_command_count > 0) return "Applying"
  return "Drifted"
}

export function runtimeRemediation(runtime: RuntimeInventoryEntry) {
  switch (runtime.operator_alert_code) {
    case "RUNTIME_HEALTH_TIMEOUT":
      return "Check the Runtime process and network path, then restore its control channel."
    case "RUNTIME_DISCONNECTED":
      return "Reconnect the Runtime control channel and confirm the next report arrives."
    case "RUNTIME_CONFIGURATION_OUT_OF_SYNC":
      return "Inspect pending commands and reapply the current desired configuration."
    case "RUNTIME_DEGRADED":
      return "Inspect reported module health and recover the degraded dependency."
    default:
      return "No remediation is required."
  }
}
