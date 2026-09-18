import { test, expect } from "bun:test"
import { installServiceNow } from "./install"

const config = { platformOrigin: "https://cp.test", tenantId: "tenant", ownerOrganizationId: "org", environmentId: "dev", gatewayId: "gateway", upstreamEndpoint: "https://connector.test/mcp", hostname: "gateway.test", basePath: "/mcp", dnsTarget: "gateway.test", identityIssuer: "https://identity.test/realms/genio-one", identityAudience: "api", serviceNowOrigin: "https://sn.test", oauthClientId: "registered", oauthScopes: [] }

test("standard installer publishes through CP with default Auto Grant and reuses installed resources", async () => {
  let resource: any
  let connection: any
  const mutations: string[] = []
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (init?.method) mutations.push(path)
    if (path.endsWith("/resources")) {
      if (!init) return (resource ? [resource] : []) as T
      resource = { ...body, resource_id: "resource", lifecycle: "DRAFT" }
      return resource as T
    }
    if (path.endsWith("/connections")) {
      if (!init) return (connection ? [connection] : []) as T
      connection = { ...body, connection_id: "connection", verification_state: "VERIFIED", mcp_selected_tools: [] }
      return connection as T
    }
    if (path.endsWith("/mcp-discovery/latest")) return { state: "SUCCEEDED", candidates: ["list_cases", "get_case", "create_case", "update_case", "delete_case"].map((name) => ({ candidate_id: name, tool_name: name, revision_digest: "digest" })) } as T
    if (path.includes("/candidates/") && path.endsWith("/decision")) connection.mcp_selected_tools.push(path.split("/").at(-2))
    if (path.endsWith("/publication-endpoint")) {
      expect(body.visibility).toBe("PUBLIC")
      resource.publication_endpoint = body
    }
    if (path.endsWith("/publication-requests")) return { request_id: "request" } as T
    if (path.endsWith("/review")) resource.lifecycle = "PUBLISHED"
    if (path.endsWith("/resource") && !init) return resource as T
    return {} as T
  }
  expect((await installServiceNow(config, api)).access).toBe("AUTO_GRANT")
  expect(connection.downstream_identity.mode).toBe("USER_OAUTH")
  expect(mutations.some((path) => path.includes("entitlements"))).toBe(false)
  const previous = mutations.length
  expect((await installServiceNow(config, api)).lifecycle).toBe("PUBLISHED")
  expect(mutations.length).toBe(previous)
})
