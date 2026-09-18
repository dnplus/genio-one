import { FileDown, PanelTop } from "lucide-react"
import { useState } from "react"
import type { ThreadItem } from "../../../server/generated/v2/ThreadItem"
import { mcpHtmlArtifacts, type McpHtmlArtifact } from "../../../shared/mcp-html-artifacts"

const previewCsp = "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src data: blob:; form-action 'none'; frame-src 'none'; img-src data: blob:; media-src data: blob:; navigate-to 'none'; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'none'"

export function mcpHtmlPreviewDocument(text: string) {
  return `<meta http-equiv="Content-Security-Policy" content="${previewCsp}">${text}`
}

function download(artifact: McpHtmlArtifact) {
  const url = URL.createObjectURL(new Blob([artifact.text], { type: "text/html;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url
  link.download = artifact.name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function McpHtmlArtifacts({ item }: { item?: ThreadItem }) {
  const artifacts = mcpHtmlArtifacts(item)
  const [preview, setPreview] = useState<McpHtmlArtifact | null>(null)
  if (!artifacts.length) return null

  return <section className="mcp-html-artifacts" aria-label="HTML 成品">
    <div className="mcp-html-artifacts-heading">
      <strong>HTML 成品</strong>
      <small>{artifacts.length} 個可用檔案</small>
    </div>
    {artifacts.map((artifact) => <div className="mcp-html-artifact-row" key={`${artifact.name}:${artifact.sha256}`}>
      <span><strong title={artifact.name}>{artifact.name}</strong></span>
      <span className="mcp-html-artifact-actions">
        <button type="button" className="secondary-button" onClick={() => setPreview(artifact)}><PanelTop />預覽</button>
        <button type="button" className="secondary-button" onClick={() => download(artifact)}><FileDown />下載 HTML</button>
      </span>
    </div>)}
    {preview && <div className="mcp-html-preview" role="dialog" aria-modal="true" aria-label={`${preview.name} 預覽`}>
      <div className="mcp-html-preview-header">
        <strong>{preview.name}</strong>
        <button type="button" className="secondary-button" onClick={() => setPreview(null)}>關閉</button>
      </div>
      <iframe title={preview.name} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={mcpHtmlPreviewDocument(preview.text)} />
    </div>}
  </section>
}
