import { test, expect } from "bun:test"
import { installMail2000, MAIL2000_TOOLS } from "./install"

test("Mail2000 installs one password Connection with Auto Grant and upgrades only missing tools", async () => {
  const config = { platformOrigin: "https://cp.test", tenantId: "tenant", ownerOrganizationId: "org", environmentId: "dev", gatewayId: "gateway", upstreamEndpoint: "https://mail.test/mcp", hostname: "gateway.test", basePath: "/mcp", dnsTarget: "gateway.test", identityIssuer: "https://identity.test/realms/genio-one", identityAudience: "api" }
  let resource: any
  let connection: any
  let resourcesCreated = 0
  let connectionsCreated = 0
  const decisions: string[] = []
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path.endsWith("/resources")) {
      if (!init) return (resource ? [resource] : []) as T
      resourcesCreated++
      resource = { ...body, resource_id: "resource", lifecycle: "DRAFT" }
      return resource as T
    }
    if (path.endsWith("/connections")) {
      if (!init) return (connection ? [connection] : []) as T
      connectionsCreated++
      connection = { ...body, connection_id: "connection", verification_state: "VERIFIED", mcp_selected_tools: [] }
      return connection as T
    }
    if (path.endsWith("/mcp-discovery/latest")) return { state: "SUCCEEDED", candidates: MAIL2000_TOOLS.map((name) => ({ candidate_id: name, tool_name: name, revision_digest: "digest" })) } as T
    if (path.endsWith("/decision")) {
      const name = path.split("/").at(-2)!
      decisions.push(name)
      connection.mcp_selected_tools.push(name)
    }
    if (path.endsWith("/publication-endpoint")) resource.publication_endpoint = body
    if (path.endsWith("/publication-requests")) return { request_id: "request" } as T
    if (path.endsWith("/review")) resource.lifecycle = "PUBLISHED"
    if (path.endsWith("/resource") && !init) return resource as T
    return {} as T
  }
  expect((await installMail2000(config, api)).access).toBe("AUTO_GRANT")
  expect(resource.publication_endpoint.visibility).toBe("PUBLIC")
  expect(connection.downstream_identity).toEqual({ mode: "USER_PASSWORD" })
  expect(connection.mcp_selected_tools).toHaveLength(21)
  await installMail2000(config, api)
  expect(decisions).toHaveLength(21)
  connection.mcp_selected_tools = connection.mcp_selected_tools.filter((name: string) => name !== "send_mail")
  await installMail2000(config, api)
  expect(decisions).toHaveLength(22)
  expect(decisions.at(-1)).toBe("send_mail")
  expect(resourcesCreated).toBe(1)
  expect(connectionsCreated).toBe(1)
})
