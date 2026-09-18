import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { renderToStaticMarkup } from "react-dom/server"
import { McpHtmlArtifacts, mcpHtmlPreviewDocument } from "./McpHtmlArtifacts"
import type { ThreadItem } from "../../../server/generated/v2/ThreadItem"

test("MCP HTML artifact card exposes preview and download without rendering its source as chat text", () => {
  const text = "<!doctype html><main>Architecture diagram</main>"
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex")
  const item = {
    type: "mcpToolCall",
    id: "archify",
    server: "archify",
    tool: "render",
    status: "completed",
    arguments: {},
    appContext: null,
    pluginId: null,
    readOnlyHint: true,
    result: { content: [{ type: "text", text: "已產生架構圖" }], structuredContent: null, _meta: { "genio/artifacts": [{ name: "architecture.html", mimeType: "text/html", text, sha256 }] } },
    error: null,
    durationMs: 1,
  } as ThreadItem
  const html = renderToStaticMarkup(<McpHtmlArtifacts item={item} />)
  expect(html).toContain("architecture.html")
  expect(html).toContain("預覽")
  expect(html).toContain("下載 HTML")
  expect(html).not.toContain("Architecture diagram")
  expect(html).not.toContain("iframe")
})

test("interactive preview permits scripts in an opaque sandbox while CSP blocks Bot-origin access", () => {
  const document = mcpHtmlPreviewDocument("<script>document.body.dataset.ready = 'true'</script>")
  expect(document).toContain("Content-Security-Policy")
  expect(document).toContain("connect-src 'none'")
  expect(document).toContain("form-action 'none'")
  expect(document).toContain("script-src 'unsafe-inline'")
  const iframe = renderToStaticMarkup(<iframe sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document} />)
  expect(iframe).toContain('sandbox="allow-scripts"')
  expect(iframe).not.toContain("allow-same-origin")
  expect(iframe).not.toContain("allow-forms")
  expect(iframe).not.toContain("allow-popups")
  expect(iframe).not.toContain("allow-top-navigation")
})
