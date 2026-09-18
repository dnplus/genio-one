import { expect, test } from "bun:test"
import { primaryMcpServer } from "./primary-mcp-server"

test("default-only Bot observes Discovery instead of the empty company gateway", () => {
  expect(primaryMcpServer()).toBe("genio_discovery")
  expect(primaryMcpServer([{ resourceId: "genio-one-discovery", capabilityId: "search_resources", version: "1", state: "INSTALLED", kind: "MCP" }])).toBe("genio_discovery")
})

test("an installed enterprise MCP still requires the company gateway", () => {
  expect(primaryMcpServer([{ resourceId: "customer-mcp", capabilityId: "read", version: "1", state: "INSTALLED", kind: "MCP" }])).toBe("genio_one")
})
