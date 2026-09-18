import { describe, expect, test } from "bun:test"
import type { BotBinding } from "../bots-storage"
import type { GenioCatalogCapability } from "./genio-one"
import {
  boundEnterpriseToolCount,
  catalogLaneFor,
  companyModelGroups,
  enterpriseToolGroups,
  isInvokeModelCapability,
  isLabCatalogName,
  replaceResourceBindings,
} from "./catalog-surface"

function cap(over: Partial<GenioCatalogCapability>): GenioCatalogCapability {
  return {
    resource_id: "res",
    resource_display_name: "ServiceNow CSM",
    capability_id: "mcp-tool-read",
    capability_display_name: "read_case",
    access: "AUTO_GRANT",
    hub_status: "CONNECTED",
    connection_status: "READY",
    ...over,
  }
}

describe("catalog surface lanes", () => {
  test("lab names are hidden from ordinary tool lists", () => {
    expect(isLabCatalogName("Walking Skeleton AI Gateway 20260829")).toBe(true)
    expect(isLabCatalogName("Tokenization E2E 20260830")).toBe(true)
    expect(isLabCatalogName("ServiceNow CSM")).toBe(false)
    expect(isLabCatalogName("Notion")).toBe(false)
  })

  test("invoke model is a model lane, not a tool", () => {
    const model = cap({
      resource_display_name: "Company GPT",
      capability_display_name: "Invoke model",
      resource_kind: "LLM",
    })
    expect(isInvokeModelCapability(model)).toBe(true)
    expect(catalogLaneFor(model)).toBe("model")
  })

  test("enterprise tools group by resource and drop lab plus models", () => {
    const capabilities = [
      cap({ resource_id: "snow", resource_display_name: "ServiceNow CSM", capability_display_name: "read_case" }),
      cap({
        resource_id: "gw",
        resource_display_name: "Walking Skeleton AI Gateway 20260829",
        capability_display_name: "Invoke model",
        resource_kind: "LLM",
      }),
      cap({
        resource_id: "notion",
        resource_display_name: "Notion",
        capability_id: "mcp-tool-notion",
        capability_display_name: "Invoke MCP tools",
      }),
    ]
    const tools = enterpriseToolGroups(capabilities)
    expect(tools.map((row) => row.title).sort()).toEqual(["Notion", "ServiceNow CSM"])
    expect(companyModelGroups(capabilities)).toHaveLength(0)
    expect(companyModelGroups(capabilities, true)).toHaveLength(1)
  })
})

 test("built-in Discovery is included by default and counted once", () => {
  const capabilities = [cap({ resource_id: "genio-one-discovery", capability_id: "search_resources", builtin_service: "DISCOVERY" }), cap({ resource_id: "genio-one-discovery", capability_id: "get_resource", builtin_service: "DISCOVERY" })]
  expect(enterpriseToolGroups(capabilities)[0]?.bound).toBe(true)
  expect(boundEnterpriseToolCount([], capabilities)).toBe(1)
})

test("resource groups keep same capability IDs isolated", () => {
  const capabilities = [
    cap({ resource_id: "mail2000", resource_display_name: "Mail2000", capability_id: "mcp.invoke" }),
    cap({ resource_id: "servicenow-csm", resource_display_name: "ServiceNow CSM", capability_id: "mcp.invoke" }),
    cap({ resource_id: "genio-one-discovery", resource_display_name: "Discovery", capability_id: "search_resources", builtin_service: "DISCOVERY" }),
  ]
  const serviceNowBinding: BotBinding = {
    resourceId: "servicenow-csm",
    capabilityId: "mcp.invoke",
    version: "1.0.0",
    state: "INSTALLED",
    kind: "MCP",
  }
  const groups = enterpriseToolGroups(capabilities, [serviceNowBinding])
  expect(groups.find((group) => group.resourceId === "mail2000")?.bound).toBe(false)
  expect(groups.find((group) => group.resourceId === "servicenow-csm")?.bound).toBe(true)
  expect(groups.find((group) => group.resourceId === "genio-one-discovery")?.bound).toBe(true)
})

test("replacing or removing one resource preserves other resource bindings", () => {
  const mailBinding: BotBinding = {
    resourceId: "mail2000",
    capabilityId: "mcp.invoke",
    version: "1.0.0",
    state: "INSTALLED",
    kind: "MCP",
  }
  const serviceNowBinding: BotBinding = {
    resourceId: "servicenow-csm",
    capabilityId: "mcp.invoke",
    version: "1.0.0",
    state: "INSTALLED",
    kind: "MCP",
  }
  const discoveryBinding: BotBinding = {
    resourceId: "genio-one-discovery",
    capabilityId: "search_resources",
    version: "1.0.0",
    state: "INSTALLED",
    kind: "MCP",
  }
  const bindings = [mailBinding, serviceNowBinding, discoveryBinding]
  const replacement = { ...mailBinding, capabilityId: "mcp.list_mailboxes" }
  expect(replaceResourceBindings(bindings, "mail2000", replacement)).toEqual([
    serviceNowBinding,
    discoveryBinding,
    replacement,
  ])
  expect(replaceResourceBindings(bindings, "mail2000", null)).toEqual([
    serviceNowBinding,
    discoveryBinding,
  ])
})
