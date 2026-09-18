import { useEffect, useState } from "react"
import type { RuntimeDetails } from "../../lib/codex-client"

function shellQuote(value: string) { return `'${value.replaceAll("'", "'\\''")}'` }

const messages: Record<string, string> = {
  LOCAL_HANDS_RUNTIME_CONFLICT: "請先停止目前的 Headless 沙盒，再連接本機。",
  LOCAL_HANDS_TURN_RUNNING: "請等目前工作完成或先停止，再連接本機。",
  BOT_NOT_SELECTED: "Bot 尚未準備好，請稍後重試。",
  RUNTIME_SESSION_NOT_FOUND: "對話尚未連線，請等 Bot 就緒後重試。",
}

export function LocalHandsModal({ botId, token, runtime, onClose }: { botId: string; token: string; runtime: RuntimeDetails | null; onClose(): void }) {
  const [folder, setFolder] = useState("")
  const [pairing, setPairing] = useState<{ token: string; expiresAt: number; executorVersion: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())
  const endpoint = runtime?.endpoint?.botId === botId ? runtime : null
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose() }
    document.addEventListener("keydown", key)
    return () => { clearInterval(timer); document.removeEventListener("keydown", key) }
  }, [onClose])
  useEffect(() => { if (endpoint) setPairing(null) }, [endpoint])
  const act = async (stop: boolean) => {
    setBusy(true); setError(""); setCopied(false)
    try {
      if (!token) throw new Error("請先登入 Bot；示範模式無法連接本機。")
      const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/local-hands${stop ? "" : "/pair"}`, { method: stop ? "DELETE" : "POST", headers: { authorization: `Bearer ${token}` } })
      const body = await response.json()
      if (!response.ok) throw new Error(messages[body.error] ?? `無法${stop ? "停止連線" : "取得配對碼"}：${body.error}`)
      setPairing(stop ? null : body)
    } catch (failure) { setError(failure instanceof Error ? failure.message : "本機連線失敗") }
    finally { setBusy(false) }
  }
  const command = `genio-endpoint-hands --bot-url ${shellQuote(location.origin)} --workspace ${shellQuote(folder.trim())}`
  const expired = Boolean(pairing && pairing.expiresAt <= now)
  return <div className="profile-dialog-backdrop" onClick={onClose}>
    <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="local-hands-title" onClick={(event) => event.stopPropagation()} style={{ width: "min(560px, calc(100vw - 32px))", padding: 24, maxHeight: "85vh", overflowY: "auto" }}>
      <h2 id="local-hands-title">連接本機電腦</h2>
      <p>讓這個 Bot 在你指定的本機資料夾執行命令及修改檔案。需要額外權限時，核准請求會顯示在對話中。</p>
      {endpoint ? <>
        <p role="status">{endpoint.execReady ? "已連接" : "連線已中斷，未確認的命令不會重送"}：{endpoint.endpoint?.hostname}</p>
        <p style={{ overflowWrap: "anywhere" }}>{endpoint.cwd}</p>
        <p>這次連線最晚於 {new Date(endpoint.endpoint!.expiresAt).toLocaleTimeString()} 結束。</p>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(true)}>{endpoint.execReady ? "停止本機連線" : "清除連線，重新配對"}</button>
      </> : <>
        <div className="setup-col-info"><label>本機工作資料夾<input autoFocus value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="例如 /Users/你的帳號/Projects/my-work" /></label></div>
        <p>在要連接的電腦安裝 Genio Endpoint CLI 後，執行以下指令，再貼上配對碼。macOS／Linux 的 Codex CLI 版本需為 0.153.4。</p>
        <button type="button" className="primary-button" disabled={busy || !folder.trim().startsWith("/") || /[\0\r\n]/.test(folder)} onClick={() => void act(false)}>{busy ? "取得配對碼中…" : pairing ? "重新產生配對碼" : "產生一次性配對碼"}</button>
        {pairing && <>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text" }}>{command}</pre>
          <label>一次性配對碼<input readOnly value={pairing.token} aria-label="一次性配對碼" style={{ display: "block", width: "100%", boxSizing: "border-box", margin: "8px 0" }} /></label>
          <button type="button" className="secondary-button" disabled={expired} onClick={() => void navigator.clipboard.writeText(pairing.token).then(() => setCopied(true)).catch(() => setError("無法複製，請選取配對碼手動複製。"))}>{copied ? "已複製配對碼" : "複製配對碼"}</button>
          <p role="status">{expired ? "配對碼已過期，請重新產生。" : `等待本機連線，配對碼 ${Math.ceil((pairing.expiresAt - now) / 1000)} 秒後失效。`}</p>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(true)}>取消配對</button>
        </>}
      </>}
      {error && <p role="alert">{error}</p>}
      <div style={{ marginTop: 20 }}><button type="button" className="secondary-button" onClick={onClose}>關閉</button></div>
    </section>
  </div>
}
