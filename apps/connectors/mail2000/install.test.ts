import { test, expect } from "bun:test"
import { installMail2000, MAIL2000_TOOLS } from "./install"

test("Mail2000 installs one password Connection with Auto Grant and never auto-publishes tools added to a published resource", async () => {
  const config = { platformOrigin: "https://cp.test", tenantId: "tenant", ownerOrganizationId: "org", environmentId: "dev", gatewayId: "gateway", upstreamEndpoint: "https://mail.test/mcp", hostname: "gateway.test", basePath: "/mcp", dnsTarget: "gateway.test", identityIssuer: "https://identity.test/realms/genio-one", identityAudience: "api" }
  let resource: any
  let connection: any
  let resourcesCreated = 0
  let connectionsCreated = 0
  const decisions: string[] = []
  const policyMutations: string[] = []
  let enforcement: any
  let draft: any
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path.endsWith("/enforcement-chain")) {
      if (!enforcement) throw new Error(`STANDARD_INSTALL_HTTP_404:${path}`)
      return enforcement as T
    }
    if (path.endsWith("/policy-draft")) {
      if (!init) {
        if (!draft) throw new Error(`STANDARD_INSTALL_HTTP_404:${path}`)
        return draft as T
      }
      policyMutations.push(path)
      draft = {
        version: (draft?.version ?? 0) + 1,
        base_revision: body.base_revision,
        content_digest: `draft-${(draft?.version ?? 0) + 1}`,
        lifecycle: "DRAFT",
        content: body.content,
      }
      return draft as T
    }
    if (path.endsWith("/policy-draft/validate")) {
      policyMutations.push(path)
      draft = { ...draft, lifecycle: "VALIDATED" }
      return draft as T
    }
    if (path.endsWith("/policy-draft/review")) {
      policyMutations.push(path)
      draft = { ...draft, lifecycle: "REVIEWED" }
      return draft as T
    }
    if (path.endsWith("/policy-draft/publish")) {
      policyMutations.push(path)
      enforcement = {
        one_policy_revision: draft.content.definition.one_policy_revision,
        chain: { eligible_connection_ids: [connection.connection_id], steps: draft.content.definition.steps },
      }
      draft = undefined
      return enforcement as T
    }
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
  expect(connection.mcp_selected_tools).toHaveLength(MAIL2000_TOOLS.length)
  expect(policyMutations).toHaveLength(4)
  expect(policyMutations.map((path) => path.split("/").at(-1))).toEqual(["policy-draft", "validate", "review", "publish"])
  await installMail2000(config, api)
  expect(decisions).toHaveLength(MAIL2000_TOOLS.length)
  expect(policyMutations).toHaveLength(4)
  // Rerunning after an upgrade adds tools (here the CardDAV directory tools) must not silently expand a
  // published resource: the admin setup playbook requires new tools to be selected and authorized explicitly.
  const upgradeTools = ["carddav_search_directory", "carddav_get_self_context"]
  connection.mcp_selected_tools = connection.mcp_selected_tools.filter((name: string) => !upgradeTools.includes(name))
  expect((await installMail2000(config, api)).pendingTools).toEqual(upgradeTools)
  expect(decisions).toHaveLength(MAIL2000_TOOLS.length)
  expect(connection.mcp_selected_tools).not.toContain("carddav_search_directory")
  // Even when the publication must be re-reviewed, the installer still does not publish tool decisions.
  resource.publication_request = { request_id: "request", state: "APPROVED", publication_state: "APPLYING" }
  expect((await installMail2000(config, api)).pendingTools).toEqual(upgradeTools)
  expect(decisions).toHaveLength(MAIL2000_TOOLS.length)
  expect(connection.mcp_selected_tools).not.toContain("carddav_get_self_context")
  expect(resourcesCreated).toBe(1)
  expect(connectionsCreated).toBe(1)
})
