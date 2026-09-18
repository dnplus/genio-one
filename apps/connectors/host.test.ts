import { expect, test } from "bun:test"
import { connectorConfigurationToken, readConnectorConfigurationToken, type ConnectorConfiguration } from "./configuration"
import { createConnectorHost } from "./host"
import { createServiceNowHandler } from "./servicenow-csm/server"
import { createMail2000Handler } from "./mail2000/server"

const key = "test-connector-configuration-key-0000000001"
function rpc(path: string, method: string, params: unknown = {}, authorization?: string) {
  return new Request(`http://connector.test${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
}

test("installed hosts expose mail and case tools without advertising unconfigured DAV", async () => {
  for (const kind of ["servicenow-csm", "mail2000"] as const) {
    const handler = createConnectorHost({ kind, configurationKey: key, discoveryHandler: kind === "mail2000" ? createMail2000Handler() : createServiceNowHandler(), configuredHandler: () => { throw new Error("unexpected") } })
    expect((await handler(new Request("http://connector.test/health"))).status).toBe(200)
    const result = await (await handler(rpc("/mcp", "tools/list"))).json() as { result: { tools: unknown[] } }
    expect(result.result.tools).toHaveLength(kind === "mail2000" ? 11 : 5)
  }
})

test("mail site configuration does not require invented calendar or contact endpoints", () => {
  const configuration: ConnectorConfiguration = { kind: "mail2000", imap_host: "mail.gss.com.tw", imap_port: 993, smtp_host: "mail.gss.com.tw", smtp_port: 465 }
  expect(readConnectorConfigurationToken(connectorConfigurationToken(configuration, key), key)).toEqual(configuration)
})

test("signed per-connection sites remain isolated and tampered sites cannot receive credentials", async () => {
  const received: string[] = []
  const handler = createConnectorHost({ kind: "servicenow-csm", configurationKey: key, discoveryHandler: createServiceNowHandler(), configuredHandler(configuration) {
    if (configuration.kind !== "servicenow-csm") throw new Error("wrong kind")
    return createServiceNowHandler({ instanceUrl: configuration.instance_url, request: async (url, init) => {
      received.push(`${new URL(String(url)).origin}:${new Headers(init?.headers).get("authorization")}`)
      return Response.json({ result: [] })
    } })
  } })
  const site = (hostname: string): ConnectorConfiguration => ({ kind: "servicenow-csm", instance_url: `https://${hostname}`, oauth_client_id: "client", oauth_scopes: [] })
  const a = connectorConfigurationToken(site("a.test"), key)
  const b = connectorConfigurationToken(site("b.test"), key)
  await Promise.all([handler(rpc(`/mcp/${a}`, "tools/call", { name: "list_cases", arguments: {} }, "Bearer caller-a")), handler(rpc(`/mcp/${b}`, "tools/call", { name: "list_cases", arguments: {} }, "Bearer caller-b"))])
  expect(received.sort()).toEqual(["https://a.test:Bearer caller-a", "https://b.test:Bearer caller-b"])
  const forged = connectorConfigurationToken(site("attacker.test"), "another-test-key-with-at-least-32-characters")
  expect((await handler(rpc(`/mcp/${forged}`, "tools/list", {}, "Bearer caller-a"))).status).toBe(403)
  expect(received).toHaveLength(2)
})
