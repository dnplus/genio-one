import { expect, test } from "bun:test"

import {
  managedMcpConfig,
  managedMcpEndpointsFromCatalog,
  managedMcpServerName,
  managedMcpTarget,
} from "./ce-demo-mcp"

const notionResourceId = "resource-2a55a5d9-3d76-40af-b65e-04babfe93a8f"

test("creates only fixed CE resource server entries for the CE documents Bot", () => {
  const endpoints = managedMcpEndpointsFromCatalog({ capabilities: [
    { resource_id: "genio.demo.context7", access: "ENTITLED", publication_endpoint: { hostname: "context7.stellar-freight.localhost", base_path: "/" } },
    { resource_id: "genio.demo.archify", access: "AUTO_GRANT", publication_endpoint: { hostname: "archify.stellar-freight.localhost", base_path: "/" } },
  ] }, "genio.demo.bot", [])
  const environment = {
    GENIO_ONE_MCP_ORIGIN: "https://old-context7.example.test",
    GENIO_ONE_MCP_URL: "http://one.localhost:1975/mcp",
    GENIO_ONE_MCP_RELAY_ORIGIN: "https://bot.example.test",
  } as NodeJS.ProcessEnv
  expect(managedMcpConfig("genio.demo.bot", "session/a", endpoints, environment)).toEqual({
    "mcp_servers.genio_context7": {
      url: "https://bot.example.test/api/mcp-gateway/session%2Fa/genio.demo.context7/mcp",
      bearer_token_env_var: "GENIO_ONE_MCP_BEARER_TOKEN",
      default_tools_approval_mode: "writes",
      required: false,
    },
    "mcp_servers.genio_archify": {
      url: "https://bot.example.test/api/mcp-gateway/session%2Fa/genio.demo.archify/mcp",
      bearer_token_env_var: "GENIO_ONE_MCP_BEARER_TOKEN",
      default_tools_approval_mode: "writes",
      required: false,
    },
  })
  expect(managedMcpTarget("genio.demo.context7", endpoints, environment)).toBe("http://context7.stellar-freight.localhost:1975/")
  expect(managedMcpTarget("genio.demo.archify", endpoints, environment)).toBe("http://archify.stellar-freight.localhost:1975/")
  expect(managedMcpTarget("genio.demo.archify", {}, environment)).toBeNull()
})

test("keeps configured gateway transport separate from each publication endpoint", () => {
  expect(managedMcpTarget("genio.demo.archify", {
    "genio.demo.archify": {
      hostname: "archify.stellar-freight.localhost",
      base_path: "/mcp",
    },
  }, {
    GENIO_ONE_MCP_URL: "https://gateway.example.test:8443/ignored",
    GENIO_ONE_MCP_ORIGIN: "http://context7.stellar-freight.localhost:1975",
  } as NodeJS.ProcessEnv)).toBe("https://archify.stellar-freight.localhost:8443/mcp")
})

test("rejects transport data encoded in a catalog hostname", () => {
  expect(managedMcpEndpointsFromCatalog({
    capabilities: [{
      resource_id: "genio.demo.context7",
      access: "ENTITLED",
      publication_endpoint: { hostname: "context7.stellar-freight.localhost:8443", base_path: "/" },
    }],
  }, "genio.demo.bot", [])).toEqual({})
})

test("projects only authorized CE publication endpoints from the catalog", () => {
  expect(managedMcpEndpointsFromCatalog({
    capabilities: [
      {
        resource_id: "genio.demo.context7",
        access: "REQUEST",
        publication_endpoint: { hostname: "context7.stellar-freight.localhost", base_path: "/" },
      },
      {
        resource_id: "genio.demo.archify",
        access: "AUTO_GRANT",
        publication_endpoint: { hostname: "archify.stellar-freight.localhost", base_path: "/" },
      },
      {
        resource_id: "unrelated",
        access: "ENTITLED",
        publication_endpoint: { hostname: "other.stellar-freight.localhost", base_path: "/" },
      },
    ],
  }, "genio.demo.bot", [])).toEqual({
    "genio.demo.archify": { hostname: "archify.stellar-freight.localhost", base_path: "/" },
  })
})

test("uses the local Bot relay when no public relay origin is configured", () => {
  const config = managedMcpConfig("genio.demo.bot", "session/a", {
    "genio.demo.context7": { hostname: "context7.stellar-freight.localhost", base_path: "/" },
    "genio.demo.archify": { hostname: "archify.stellar-freight.localhost", base_path: "/" },
  }, {
    GENIO_BOT_PORT: "5192",
    GENIO_ONE_MCP_ORIGIN: "https://old-context7.example.test",
    GENIO_ONE_MCP_URL: "http://one.localhost:1975/mcp",
  } as NodeJS.ProcessEnv)
  expect(config).toMatchObject({
    "mcp_servers.genio_context7": {
      url: "http://127.0.0.1:5192/api/mcp-gateway/session%2Fa/genio.demo.context7/mcp",
    },
    "mcp_servers.genio_archify": {
      url: "http://127.0.0.1:5192/api/mcp-gateway/session%2Fa/genio.demo.archify/mcp",
    },
  })
})

test("mounts only an installed generic MCP binding with an authorized publication endpoint", () => {
  const endpoints = managedMcpEndpointsFromCatalog({
    capabilities: [
      {
        resource_id: notionResourceId,
        capability_id: "notion.search",
        access: "ENTITLED",
        publication_endpoint: { hostname: "notion.stellar-freight.localhost", base_path: "/mcp" },
      },
      {
        resource_id: "resource-missing-endpoint",
        capability_id: "mcp.invoke",
        access: "ENTITLED",
      },
      {
        resource_id: "resource-unauthorized",
        capability_id: "mcp.invoke",
        access: "REQUEST",
        publication_endpoint: { hostname: "unauthorized.stellar-freight.localhost", base_path: "/mcp" },
      },
      {
        resource_id: "resource-uninstalled",
        capability_id: "mcp.invoke",
        access: "AUTO_GRANT",
        publication_endpoint: { hostname: "uninstalled.stellar-freight.localhost", base_path: "/mcp" },
      },
    ],
  }, "custom-bot", [{
    resourceId: notionResourceId,
    capabilityId: "notion.search",
    state: "INSTALLED",
    kind: "MCP",
  }])
  const environment = {
    GENIO_ONE_MCP_URL: "http://one.localhost:1975/mcp",
    GENIO_ONE_MCP_RELAY_ORIGIN: "https://bot.example.test",
  } as NodeJS.ProcessEnv

  expect(endpoints).toEqual({
    [notionResourceId]: {
      hostname: "notion.stellar-freight.localhost",
      base_path: "/mcp",
      capabilityId: "notion.search",
    },
  })
  expect(managedMcpTarget(notionResourceId, endpoints, environment)).toBe("http://notion.stellar-freight.localhost:1975/mcp")
  expect(managedMcpConfig("custom-bot", "session/a", endpoints, environment)).toEqual({
    [`mcp_servers.${managedMcpServerName("custom-bot", notionResourceId)}`]: {
      url: `https://bot.example.test/api/mcp-gateway/session%2Fa/${notionResourceId}/mcp`,
      bearer_token_env_var: "GENIO_ONE_MCP_BEARER_TOKEN",
      default_tools_approval_mode: "writes",
      required: false,
    },
  })
  expect(managedMcpServerName("custom-bot", notionResourceId)).toMatch(/^genio_mcp_[a-f0-9]{24}$/)
  expect(managedMcpTarget("resource-missing-endpoint", endpoints, environment)).toBeNull()
  expect(managedMcpTarget("resource-unauthorized", endpoints, environment)).toBeNull()
  expect(managedMcpTarget("resource-uninstalled", endpoints, environment)).toBeNull()
})
