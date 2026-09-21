import { expect, test } from "bun:test"

import {
  authorizedManagedMcpMount,
  isManagedMcpServerName,
  managedMcpConfig,
  managedMcpMountsFromCatalog,
  managedMcpTarget,
  resolveManagedMcpMounts,
  type ManagedMcpBinding,
} from "./managed-mcp"

const notionResourceId = "resource-2a55a5d9-3d76-40af-b65e-04babfe93a8f"

function installed(resourceId: string, capabilityId: string): ManagedMcpBinding {
  return { resourceId, capabilityId, state: "INSTALLED", kind: "MCP" }
}

const ceBindings = [
  installed("genio.demo.context7", "context7"),
  installed("genio.demo.archify", "archify"),
]

const ceCatalog = {
  capabilities: [
    { resource_id: "genio.demo.context7", capability_id: "context7", access: "ENTITLED", publication_endpoint: { hostname: "context7.stellar-freight.localhost", base_path: "/" } },
    { resource_id: "genio.demo.archify", capability_id: "archify", access: "AUTO_GRANT", publication_endpoint: { hostname: "archify.stellar-freight.localhost", base_path: "/" } },
  ],
}

const environment = {
  GENIO_ONE_MCP_URL: "http://one.localhost:1975/mcp",
  GENIO_ONE_MCP_RELAY_ORIGIN: "https://bot.example.test",
} as NodeJS.ProcessEnv

test("mounts the CE starter resources through ordinary installed bindings", () => {
  const mounts = managedMcpMountsFromCatalog(ceCatalog, ceBindings)

  expect(mounts).toEqual({
    "genio.demo.context7": {
      resourceId: "genio.demo.context7",
      capabilityId: "context7",
      serverName: "genio_mcp_context7",
      hostname: "context7.stellar-freight.localhost",
      basePath: "/",
    },
    "genio.demo.archify": {
      resourceId: "genio.demo.archify",
      capabilityId: "archify",
      serverName: "genio_mcp_archify",
      hostname: "archify.stellar-freight.localhost",
      basePath: "/",
    },
  })
  expect(managedMcpConfig("session/a", mounts, environment)).toEqual({
    "mcp_servers.genio_mcp_context7": {
      url: "https://bot.example.test/api/mcp-gateway/session%2Fa/genio.demo.context7/mcp",
      bearer_token_env_var: "GENIO_ONE_MCP_BEARER_TOKEN",
      default_tools_approval_mode: "writes",
      required: false,
    },
    "mcp_servers.genio_mcp_archify": {
      url: "https://bot.example.test/api/mcp-gateway/session%2Fa/genio.demo.archify/mcp",
      bearer_token_env_var: "GENIO_ONE_MCP_BEARER_TOKEN",
      default_tools_approval_mode: "writes",
      required: false,
    },
  })
})

test("does not mount a catalog entry the Bot has no installed binding for", () => {
  expect(managedMcpMountsFromCatalog(ceCatalog, [installed("genio.demo.context7", "context7")]))
    .toEqual({
      "genio.demo.context7": {
        resourceId: "genio.demo.context7",
        capabilityId: "context7",
        serverName: "genio_mcp_context7",
        hostname: "context7.stellar-freight.localhost",
        basePath: "/",
      },
    })
  expect(managedMcpMountsFromCatalog(ceCatalog, [])).toEqual({})
})

test("requires the binding to be an installed MCP binding", () => {
  const pending = [{ ...installed("genio.demo.context7", "context7"), state: "PENDING" }]
  const skill = [{ ...installed("genio.demo.context7", "context7"), kind: "SKILL" }]
  expect(managedMcpMountsFromCatalog(ceCatalog, pending)).toEqual({})
  expect(managedMcpMountsFromCatalog(ceCatalog, skill)).toEqual({})
})

test("projects only entitled capabilities that publish an endpoint", () => {
  const mounts = managedMcpMountsFromCatalog({
    capabilities: [
      { resource_id: "requested", capability_id: "mcp.invoke", access: "REQUEST", publication_endpoint: { hostname: "requested.stellar-freight.localhost", base_path: "/mcp" } },
      { resource_id: "no-endpoint", capability_id: "mcp.invoke", access: "ENTITLED" },
      { resource_id: notionResourceId, capability_id: "notion.search", access: "ENTITLED", publication_endpoint: { hostname: "notion.stellar-freight.localhost", base_path: "/mcp" } },
    ],
  }, [
    installed("requested", "mcp.invoke"),
    installed("no-endpoint", "mcp.invoke"),
    installed(notionResourceId, "notion.search"),
  ])

  expect(Object.keys(mounts)).toEqual([notionResourceId])
  expect(mounts[notionResourceId]!.serverName).toBe("genio_mcp_notion")
})

test("rejects transport data encoded in a catalog hostname", () => {
  expect(managedMcpMountsFromCatalog({
    capabilities: [{
      resource_id: "genio.demo.context7",
      capability_id: "context7",
      access: "ENTITLED",
      publication_endpoint: { hostname: "context7.stellar-freight.localhost:8443", base_path: "/" },
    }],
  }, ceBindings)).toEqual({})
})

test("falls back to a stable hashed name when publication labels collide", () => {
  const mounts = managedMcpMountsFromCatalog({
    capabilities: [
      { resource_id: "alpha", capability_id: "mcp.invoke", access: "ENTITLED", publication_endpoint: { hostname: "shared.tenant-a.localhost", base_path: "/mcp" } },
      { resource_id: "beta", capability_id: "mcp.invoke", access: "ENTITLED", publication_endpoint: { hostname: "shared.tenant-b.localhost", base_path: "/mcp" } },
    ],
  }, [installed("alpha", "mcp.invoke"), installed("beta", "mcp.invoke")])

  expect(mounts.alpha!.serverName).toMatch(/^genio_mcp_[a-f0-9]{24}$/)
  expect(mounts.beta!.serverName).toMatch(/^genio_mcp_[a-f0-9]{24}$/)
  expect(mounts.alpha!.serverName).not.toBe(mounts.beta!.serverName)
})

test("keeps configured gateway transport separate from each publication endpoint", () => {
  expect(managedMcpTarget({
    resourceId: "genio.demo.archify",
    capabilityId: "archify",
    serverName: "genio_mcp_archify",
    hostname: "archify.stellar-freight.localhost",
    basePath: "/mcp",
  }, { GENIO_ONE_MCP_URL: "https://gateway.example.test:8443/ignored" } as NodeJS.ProcessEnv))
    .toBe("https://archify.stellar-freight.localhost:8443/mcp")
})

test("uses the local Bot relay when no public relay origin is configured", () => {
  expect(managedMcpConfig("session/a", managedMcpMountsFromCatalog(ceCatalog, ceBindings), {
    GENIO_BOT_PORT: "5192",
    GENIO_ONE_MCP_URL: "http://one.localhost:1975/mcp",
  } as NodeJS.ProcessEnv)).toMatchObject({
    "mcp_servers.genio_mcp_context7": { url: "http://127.0.0.1:5192/api/mcp-gateway/session%2Fa/genio.demo.context7/mcp" },
    "mcp_servers.genio_mcp_archify": { url: "http://127.0.0.1:5192/api/mcp-gateway/session%2Fa/genio.demo.archify/mcp" },
  })
})

test("revokes a relay request once the binding is uninstalled", () => {
  const mounts = managedMcpMountsFromCatalog(ceCatalog, ceBindings)
  expect(authorizedManagedMcpMount("genio.demo.context7", mounts, ceBindings)).toMatchObject({ serverName: "genio_mcp_context7" })
  expect(authorizedManagedMcpMount("genio.demo.context7", mounts, [])).toBeNull()
  expect(authorizedManagedMcpMount("genio.demo.gemini", mounts, ceBindings)).toBeNull()
})

test("reserves the whole genio_ server namespace", () => {
  for (const name of ["genio_one", "genio_discovery", "genio_bot", "genio_mcp_context7", "genio_mcp_a1b2c3d4e5f6a1b2c3d4e5f6"]) {
    expect(isManagedMcpServerName(name)).toBe(true)
  }
  for (const name of ["customer_server", "Genio_one", "genio-one", "", null, undefined, 7]) {
    expect(isManagedMcpServerName(name)).toBe(false)
  }
})

test("degrades to no mounts when the catalog is unreachable", async () => {
  const reasons: string[] = []
  const mounts = await resolveManagedMcpMounts({
    bindings: ceBindings,
    tenantId: "tenant-a",
    accessToken: "token",
    environment,
    fetcher: (async () => { throw new Error("ECONNREFUSED") }) as unknown as typeof fetch,
    onDegraded: (reason) => reasons.push(reason),
  })
  expect(mounts).toEqual({})
  expect(reasons).toEqual(["MANAGED_MCP_CATALOG_UNREACHABLE"])
})

test("degrades to no mounts when the catalog rejects the request", async () => {
  const reasons: string[] = []
  const mounts = await resolveManagedMcpMounts({
    bindings: ceBindings,
    tenantId: "tenant-a",
    accessToken: "token",
    environment,
    fetcher: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    onDegraded: (reason) => reasons.push(reason),
  })
  expect(mounts).toEqual({})
  expect(reasons).toEqual(["MANAGED_MCP_CATALOG_STATUS_503"])
})

test("throws when the catalog answers with an unreadable contract", async () => {
  await expect(resolveManagedMcpMounts({
    bindings: ceBindings,
    tenantId: "tenant-a",
    accessToken: "token",
    environment,
    fetcher: (async () => new Response(JSON.stringify({ unexpected: true }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  })).rejects.toThrow("MANAGED_MCP_CATALOG_INVALID")
})

test("skips the catalog entirely for a Bot with no installed MCP bindings", async () => {
  let called = false
  const mounts = await resolveManagedMcpMounts({
    bindings: [{ resourceId: "genio.demo.bot", capabilityId: "skill.archify", state: "INSTALLED", kind: "SKILL" }],
    tenantId: "tenant-a",
    accessToken: "token",
    environment,
    fetcher: (async () => { called = true; return new Response("{}") }) as unknown as typeof fetch,
  })
  expect(mounts).toEqual({})
  expect(called).toBe(false)
})
