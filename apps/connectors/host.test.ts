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

const configurations: Record<"mail2000" | "servicenow-csm", ConnectorConfiguration> = {
  mail2000: { kind: "mail2000", imap_host: "mail.example.test", imap_port: 993, smtp_host: "mail.example.test", smtp_port: 465 },
  "servicenow-csm": { kind: "servicenow-csm", instance_url: "https://cases.example.test", oauth_client_id: "test-client", oauth_scopes: [] },
}

function guardedHost(kind: "mail2000" | "servicenow-csm") {
  const calls = { configured: 0, upstream: 0, discovery: 0 }
  const handler = createConnectorHost({
    kind, configurationKey: key,
    configuredHandler: () => {
      calls.configured++
      return async () => { calls.upstream++; return Response.json({ unexpected: true }) }
    },
    discoveryHandler: async () => { calls.discovery++; return Response.json({ discovery: true }) },
  })
  return { handler, calls }
}

for (const kind of ["mail2000", "servicenow-csm"] as const) {
  test(`${kind} host rejects a correctly signed configuration for the other connector before dispatch`, async () => {
    const otherKind = kind === "mail2000" ? "servicenow-csm" : "mail2000"
    const token = connectorConfigurationToken(configurations[otherKind], key)
    // Prove this is a valid signed token, isolating the connector-kind fence.
    expect(readConnectorConfigurationToken(token, key)).toEqual(configurations[otherKind])
    const { handler, calls } = guardedHost(kind)
    const response = await handler(rpc(`/mcp/${token}`, "tools/call", { name: "unexpected", arguments: {} }, "Bearer fixture-credential"))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "CONNECTOR_CONFIGURATION_UNTRUSTED" })
    expect(calls).toEqual({ configured: 0, upstream: 0, discovery: 0 })
  })
}

test("malformed configuration tokens never dispatch or pass caller credentials upstream", async () => {
  const { handler, calls } = guardedHost("servicenow-csm")
  for (const token of ["missing-signature", "payload.signature.extra", "a.b", `${"a".repeat(2048)}.b`]) {
    const response = await handler(rpc(`/mcp/${token}`, "tools/call", {}, "Bearer fixture-credential"))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "CONNECTOR_CONFIGURATION_UNTRUSTED" })
  }
  expect(calls).toEqual({ configured: 0, upstream: 0, discovery: 0 })
})

test("missing per-connection path does not accidentally invoke a configured handler", async () => {
  const { handler, calls } = guardedHost("mail2000")
  for (const path of ["/mcp/", "/mcp//", "/mcp/invalid/extra"]) {
    expect((await handler(rpc(path, "tools/call", {}, "Bearer fixture-credential"))).status).toBe(404)
  }
  expect(calls).toEqual({ configured: 0, upstream: 0, discovery: 0 })
  // The exact /mcp route is intentionally available for unconfigured discovery.
  expect((await handler(rpc("/mcp", "tools/list"))).status).toBe(200)
  expect(calls).toEqual({ configured: 0, upstream: 0, discovery: 1 })
})

test("host construction requires a sufficiently long configuration signing key", () => {
  for (const configurationKey of ["", "short-fixture-key", "x".repeat(31)]) {
    expect(() => createConnectorHost({ kind: "mail2000", configurationKey, configuredHandler: () => async () => Response.json({}), discoveryHandler: async () => Response.json({}) })).toThrow("CONNECTOR_CONFIGURATION_KEY_REQUIRED")
  }
})
