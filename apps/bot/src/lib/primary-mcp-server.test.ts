import { expect, test } from "bun:test"
import type { BotBinding } from "../bots-storage"
import { activeMcpServers, isActiveMcpServer, mcpConnectionStatus, primaryMcpServer } from "./primary-mcp-server"

test("default-only Bot observes Discovery instead of the empty company gateway", () => {
  expect(primaryMcpServer()).toBe("genio_discovery")
  expect(primaryMcpServer([{ resourceId: "genio-one-discovery", capabilityId: "search_resources", version: "1", state: "INSTALLED", kind: "MCP" }])).toBe("genio_discovery")
})

test("an installed enterprise MCP still requires the company gateway", () => {
  expect(primaryMcpServer([{ resourceId: "customer-mcp", capabilityId: "read", version: "1", state: "INSTALLED", kind: "MCP" }])).toBe("genio_one")
})

test("uses every live managed MCP server instead of the legacy company gateway name", () => {
  const bindings: BotBinding[] = [
    { resourceId: "mail2000", capabilityId: "mail.search", version: "1", state: "INSTALLED", kind: "MCP" },
    { resourceId: "notion", capabilityId: "notion.search", version: "1", state: "INSTALLED", kind: "MCP" },
  ]
  const statuses = [
    { name: "genio_one", runtimeStatus: "connected", authStatus: "authenticated", tools: {} },
    { name: "genio_mcp_mail2000", runtimeStatus: "connected", authStatus: "authenticated", tools: { search_mail: {} } },
    { name: "genio_mcp_notion", runtimeStatus: "connected", authStatus: "authenticated", tools: { search: {}, list_pages: {} } },
  ]

  expect(activeMcpServers(bindings, ["genio_mcp_mail2000", "genio_mcp_notion"], statuses)).toEqual(statuses.slice(1))
  expect(mcpConnectionStatus(bindings, ["genio_mcp_mail2000", "genio_mcp_notion"], statuses)).toEqual({ connected: true, message: "3 個工具 · 2 個服務 · GenioOne SSO" })
})

test("uses the latest managed server configuration while the Bot binding readback is pending", () => {
  const statuses = [
    { name: "genio_discovery", runtimeStatus: "connected", authStatus: "authenticated", tools: { search: {} } },
    { name: "genio_mcp_mail2000", runtimeStatus: "connected", authStatus: "authenticated", tools: { search_mail: {} } },
    { name: "genio_mcp_notion", runtimeStatus: "connected", authStatus: "authenticated", tools: { search: {}, list_pages: {} } },
  ]
  const managedServerNames = ["genio_mcp_mail2000", "genio_mcp_notion"]

  expect(activeMcpServers([], managedServerNames, statuses)).toEqual(statuses.slice(1))
  expect(isActiveMcpServer([], managedServerNames, "genio_mcp_mail2000")).toBe(true)
  expect(isActiveMcpServer([], managedServerNames, "genio_discovery")).toBe(false)
  expect(mcpConnectionStatus([], managedServerNames, statuses)).toEqual({ connected: true, message: "3 個工具 · 2 個服務 · GenioOne SSO" })
})

test("does not call a partially connected managed tool set ready", () => {
  const bindings: BotBinding[] = [
    { resourceId: "mail2000", capabilityId: "mail.search", version: "1", state: "INSTALLED", kind: "MCP" },
    { resourceId: "notion", capabilityId: "notion.search", version: "1", state: "INSTALLED", kind: "MCP" },
  ]
  const statuses = [
    { name: "genio_mcp_mail2000", runtimeStatus: "connected", authStatus: "authenticated", tools: { search_mail: {} } },
    { name: "genio_mcp_notion", runtimeStatus: "failed", authStatus: "authenticated", tools: {} },
  ]

  expect(mcpConnectionStatus(bindings, ["genio_mcp_mail2000", "genio_mcp_notion"], statuses)).toEqual({ connected: false, message: "GENIO_MANAGED_MCP_UNAVAILABLE" })
})

test("does not count an unrelated old managed server when an expected mount is missing", () => {
  const bindings: BotBinding[] = [
    { resourceId: "mail2000", capabilityId: "mail.search", version: "1", state: "INSTALLED", kind: "MCP" },
    { resourceId: "notion", capabilityId: "notion.search", version: "1", state: "INSTALLED", kind: "MCP" },
  ]
  const statuses = [
    { name: "genio_mcp_mail2000", runtimeStatus: "connected", authStatus: "authenticated", tools: { search_mail: {} } },
    { name: "genio_mcp_previous_bot", runtimeStatus: "connected", authStatus: "authenticated", tools: { old_tool: {} } },
  ]

  expect(mcpConnectionStatus(bindings, ["genio_mcp_mail2000", "genio_mcp_notion"], statuses)).toEqual({ connected: false, message: "GENIO_MANAGED_MCP_UNAVAILABLE" })
})
