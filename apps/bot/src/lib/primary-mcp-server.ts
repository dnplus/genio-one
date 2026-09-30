import type { BotBinding } from "../bots-storage"

export interface McpServerStatus {
  name: string
  runtimeStatus: string | null
  authStatus: string
  tools: Record<string, unknown>
}

export function hasInstalledManagedMcpBinding(bindings?: BotBinding[]) {
  return bindings?.some((binding) =>
    binding.state === "INSTALLED" && binding.kind === "MCP" && binding.resourceId !== "genio-one-discovery") ?? false
}

export function hasManagedMcpServerConfiguration(bindings: BotBinding[] | undefined, managedServerNames: readonly string[]) {
  return managedServerNames.length > 0 || hasInstalledManagedMcpBinding(bindings)
}

export function primaryMcpServer(bindings?: BotBinding[]): "genio_one" | "genio_discovery" {
  return hasInstalledManagedMcpBinding(bindings)
    ? "genio_one"
    : "genio_discovery"
}

export function isActiveMcpServer(bindings: BotBinding[] | undefined, managedServerNames: readonly string[], name: string) {
  if (hasManagedMcpServerConfiguration(bindings, managedServerNames)) return managedServerNames.includes(name)
  return name === primaryMcpServer(bindings)
}

export function activeMcpServers(bindings: BotBinding[] | undefined, managedServerNames: readonly string[], statuses: McpServerStatus[]) {
  return statuses.filter((status) => isActiveMcpServer(bindings, managedServerNames, status.name))
}

export function mcpConnectionStatus(bindings: BotBinding[] | undefined, managedServerNames: readonly string[], statuses: McpServerStatus[]) {
  const hasManagedConfiguration = hasManagedMcpServerConfiguration(bindings, managedServerNames)
  const expectedManagedServerNames = [...new Set(managedServerNames)]
  const active = activeMcpServers(bindings, managedServerNames, statuses)
  if (active.length === 0) {
    return {
      connected: false,
      message: hasManagedConfiguration ? "GENIO_MANAGED_MCP_NOT_CONFIGURED" : "GENIO_ONE_MCP_NOT_CONFIGURED",
    }
  }
  const connected = active.filter((server) => server.runtimeStatus === "connected")
  const tools = connected.reduce((count, server) => count + Object.keys(server.tools).length, 0)
  const allExpectedManagedServersPresent = !hasManagedConfiguration || (expectedManagedServerNames.length > 0 && active.length === expectedManagedServerNames.length)
  if (allExpectedManagedServersPresent && connected.length === active.length) {
    return { connected: true, message: `${tools} 個工具 · ${connected.length} 個服務 · GenioOne SSO` }
  }
  if (active.some((server) => server.authStatus === "notLoggedIn" || server.runtimeStatus === "authenticationRequired")) {
    return { connected: false, message: "GenioOne SSO session 無法使用" }
  }
  return { connected: false, message: "GENIO_MANAGED_MCP_UNAVAILABLE" }
}
