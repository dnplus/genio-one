import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { ChatComposer } from "../../src/components/chat/ChatComposer"
import "../../src/styles.css"

function Harness() {
  const [draft, setDraft] = useState("原有草稿")
  const [view, setView] = useState(1)
  const ref = useRef<HTMLTextAreaElement>(null)
  return <main style={{ maxWidth: 760, margin: "60px auto", padding: 16 }}>
    <h1>語音輸入分段驗證</h1>
    <p>合成測試音源與測試 API；非完整產品 E2E。</p>
    <button type="button" onClick={() => { setView((current) => current + 1); setDraft("另一個對話") }}>切換對話</button>
    <ChatComposer key={view} voiceToken="component-test" input={draft} setInput={setDraft} textareaRef={ref}
      isInputDisabled={false} isRunning={false} activeBotName="語音測試 Bot" hasCodexLogin={false} threadReady channelReady
      approval={null} onDecideApproval={() => {}} models={[]} selectedModel="" onSelectModel={() => {}}
      inputHistory={[]} onSendMessage={() => setDraft("")} onInterrupt={() => {}} allMentionItems={[]} onExecuteSlashAction={() => {}} />
  </main>
}

createRoot(document.getElementById("root")!).render(<Harness />)
