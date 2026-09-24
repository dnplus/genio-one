import type { CapabilityGate } from "./capability-gate"
import type { BotRegistry } from "./bot-registry"
import type { BotWorkspaceStore } from "./bot-workspace-store"
import type { HandsPlacementGate } from "./hands-placement-gate"
import type { BotModelDirectory } from "./model-directory"
import type { RuntimeBroker } from "./runtime-broker"
import type { CodexRuntimeFactory } from "./runtime"
import type { BotToolSessions } from "./bot-tool-sessions"
import type { RuntimePolicyResolver } from "./runtime-policy-contract"

export interface BotServerContext {
  botSchedules: import("./bot-schedules").BotSchedules
  botDeletionReconciler: import("./bot-deletion-reconciler").BotDeletionReconciler
  localHands?: import("./local-hands").LocalHands
  botToolSessions: BotToolSessions
  runtimeBroker: RuntimeBroker
  capabilityGate: CapabilityGate
  modelDirectory: BotModelDirectory
  botRegistry: BotRegistry
  workspaces: BotWorkspaceStore
  handsPlacement: HandsPlacementGate
  createCodexRuntime?: CodexRuntimeFactory
  runtimePolicy: RuntimePolicyResolver
}
