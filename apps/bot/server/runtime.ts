import { handsBackendFor } from "./hands-provider"
import { configuredRuntimeKind } from "./runtime-contract"
import type { BotWorkspaceStore } from "./bot-workspace-store"
import type { ManagedDesktop, RuntimeCallbacks, RuntimeProvisionRequest } from "./runtime-contract"

export * from "./runtime-contract"
export { appServerArguments, appServerCommand, codexChildEnvironment, createCodexRuntime, resolveBotRelayOrigin, resolveGenioDiscoveryMcpUrl, resolveGenioOneMcpUrl } from "./native-app-server"
export type { AppServerMcpConfiguration } from "./native-app-server"
export { e2bCommandResult, remoteCodexBootstrapCommand, remoteCodexPathPrefix, remoteExecServerCommand, requiresCodexBootstrap } from "./e2b-hands"

export async function createManagedRuntime(request: RuntimeProvisionRequest, callbacks: Pick<RuntimeCallbacks, "onExit">, workspaces?: BotWorkspaceStore): Promise<ManagedDesktop> {
  const runtime = configuredRuntimeKind()
  if (runtime === "local") throw new Error("REMOTE_RUNTIME_NOT_CONFIGURED")
  const provider = request.workspace?.provider ?? runtime
  if (provider === "endpoint") throw new Error("HANDS_PROVIDER_INVALID")
  return handsBackendFor(provider).provision(request, callbacks, workspaces)
}

export const createManagedDesktop = createManagedRuntime
