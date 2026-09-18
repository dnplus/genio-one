import { expect, test } from "bun:test"
import { discoverMcpConnection } from "../../runtimes/gateway/controller/mcp-discovery"
import { createMail2000Handler } from "./mail2000/server"
import { createMail2000Imap } from "./mail2000/imap"
import { createMail2000Smtp } from "./mail2000/smtp"
import { createMail2000Dav } from "./mail2000/dav"
import { createServiceNowHandler } from "./servicenow-csm/server"
import { MAIL2000_TOOLS } from "./mail2000/install"

(process.env.GENIO_CONNECTOR_HTTP_TEST === "1" ? test : test.skip)("Gateway Runtime client discovers standard connector HTTP endpoints before personal login", async () => {
  const mail = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createMail2000Handler({
    ...createMail2000Imap({ host: "mail.example.test", port: 993 }),
    sendMail: createMail2000Smtp({ host: "mail.example.test", port: 465 }),
    caldav: createMail2000Dav({ url: "https://mail.example.test/caldav/", kind: "caldav" }),
    carddav: createMail2000Dav({ url: "https://mail.example.test/carddav/", kind: "carddav" }),
  }) })
  const sn = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createServiceNowHandler({ instanceUrl: "https://sn.example.test" }) })
  try {
    const mailDiscovery = await discoverMcpConnection({ endpoint: `http://127.0.0.1:${mail.port}/mcp` })
    expect(mailDiscovery.tools.map((tool) => tool.name).sort()).toEqual([...MAIL2000_TOOLS].sort())
    const snDiscovery = await discoverMcpConnection({ endpoint: `http://127.0.0.1:${sn.port}/mcp` })
    expect(snDiscovery.tools.map((tool) => tool.name).sort()).toEqual(["list_cases", "get_case", "create_case", "update_case", "delete_case"].sort())
    for (const [port, tool, error] of [[mail.port, "list_mailboxes", "MAIL2000_CONNECTION_REQUIRED"], [sn.port, "list_cases", "SERVICENOW_AUTHORIZATION_REQUIRED"]] as const) {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: {} } }) })
      const body = await response.json() as any
      expect(body.result.isError).toBe(true)
      expect(body.result.content[0].text).toBe(error)
    }
  } finally { await mail.stop(true); await sn.stop(true) }
})
