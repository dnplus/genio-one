import { useCallback, useEffect, useState } from "react"
import { Link2 } from "lucide-react"
import { InteractionCard } from "../common/InteractionCard"
import "./PersonalConnectionCard.css"

interface PersonalConnection {
  connection_id: string
  display_name: string
  authentication: "OAUTH" | "PASSWORD"
  status: "CONNECTED" | "SAVED" | "NEEDS_CONNECTION"
}

function PasswordConnectionForm({ busy, onSave }: { busy: boolean; onSave: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  return <form className="personal-credential-form" onSubmit={(event) => { event.preventDefault(); void onSave(username, password).finally(() => setPassword("")) }}>
    <label>帳號<input name="username" autoComplete="username" required maxLength={512} value={username} disabled={busy} onChange={(event) => setUsername(event.target.value)} /></label>
    <label>密碼<input name="password" type="password" autoComplete="current-password" required maxLength={4096} value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>
    <button type="submit" className="primary-button" disabled={busy || !username.trim() || !password}>保存帳密</button>
  </form>
}

export function PersonalConnectionCard({ tenantId, resourceId, resourceName, reason, accessToken, onClose, onConnected, onSaved }: {
  tenantId: string
  resourceId: string
  resourceName: string
  reason?: string
  accessToken: string
  onClose: () => void | Promise<void>
  onConnected: (connectionId: string) => void | Promise<void>
  onSaved?: (connectionId: string) => void | Promise<void>
}) {
  const [connections, setConnections] = useState<PersonalConnection[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [loaded, setLoaded] = useState(false)
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}/me/resource-connections/${encodeURIComponent(resourceId)}`
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(base, { headers: { authorization: `Bearer ${accessToken}` }, signal })
    if (!response.ok) throw new Error(response.status === 403 ? "目前沒有這個工具的使用權限。" : "無法讀取連線狀態，請稍後重試。")
    const rows = await response.json() as PersonalConnection[]
    if (!signal?.aborted) {
      setConnections(rows)
      setLoaded(true)
    }
    return rows
  }, [base, accessToken])
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal).catch((error) => {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "無法讀取連線狀態。")
    })
    return () => controller.abort()
  }, [refresh])
  const authorize = async (connectionId: string) => {
    const popup = window.open("about:blank", "_blank")
    if (!popup) { setMessage("請允許開啟授權視窗，再按一次授權連線。"); return }
    popup.opener = null
    setBusy(true)
    setMessage("")
    try {
      const response = await fetch(`${base}/${encodeURIComponent(connectionId)}/authorize`, { method: "POST", headers: { authorization: `Bearer ${accessToken}` } })
      if (!response.ok) throw new Error("無法啟動授權，請確認連線設定後重試。")
      const result = await response.json() as { authorization_url: string }
      const url = new URL(result.authorization_url)
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error("授權網址無效。")
      popup.location.href = url.toString()
      setMessage("請在新視窗完成授權，再回來按「確認連線狀態」。")
    } catch (error) {
      popup.close()
      setMessage(error instanceof Error ? error.message : "無法啟動授權。")
    } finally { setBusy(false) }
  }
  const savePassword = async (connectionId: string, username: string, password: string) => {
    setBusy(true)
    setMessage("")
    try {
      const response = await fetch(`${base}/${encodeURIComponent(connectionId)}/password`, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ username, password }) })
      if (!response.ok) throw new Error("帳密未保存，請確認資料後重試。")
      await refresh()
      await onSaved?.(connectionId)
      setMessage("帳密已加密保存，將在使用工具時驗證連線。")
    } catch (error) { setMessage(error instanceof Error ? error.message : "帳密未保存。") }
    finally { setBusy(false) }
  }
  const check = async () => {
    setBusy(true)
    try {
      const rows = await refresh()
      if (rows.some((connection) => connection.status === "CONNECTED")) {
        setMessage("連線完成，可以使用工具。")
        const connected = rows.find((connection) => connection.status === "CONNECTED")
        if (connected) await onConnected(connected.connection_id)
      } else if (rows.some((connection) => connection.status === "SAVED")) {
        const saved = rows.find((connection) => connection.status === "SAVED")
        if (saved) await onSaved?.(saved.connection_id)
        setMessage("帳密已保存，將在使用工具時驗證連線。")
      }
      else setMessage("尚未完成連線設定，請完成後再確認。")
    } catch (error) { setMessage(error instanceof Error ? error.message : "無法讀取連線狀態。") }
    finally { setBusy(false) }
  }
  const close = async () => {
    setBusy(true)
    try {
      await onClose()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "無法取消連線設定。")
    } finally {
      setBusy(false)
    }
  }
  return <InteractionCard tone="connect" icon={<Link2 size={18} />} title={`連接 ${resourceName}`} subtitle={reason || "授權保存在你的帳號，可供其他 Bot 使用。"} testId="personal-connection-card" onDismiss={() => { if (!busy) void close() }} actions={
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void check()}>確認連線狀態</button>
  }>
    {!loaded && !message ? <p>正在讀取連線設定…</p> : null}
    {loaded && connections.length === 0 ? <p>目前沒有需要個人授權的連線。若工具尚未可用，請聯絡管理者確認服務設定。</p> : null}
    {connections.map((connection) => <div key={connection.connection_id}>
      <p>{connection.display_name} · {connection.status === "CONNECTED" ? "已連線" : connection.status === "SAVED" ? "已保存帳密" : connection.authentication === "PASSWORD" ? "尚未設定帳密" : "尚未授權"}</p>
      {connection.authentication === "PASSWORD" ? <PasswordConnectionForm busy={busy} onSave={(username, password) => savePassword(connection.connection_id, username, password)} /> : <button type="button" className="primary-button" disabled={busy} onClick={() => void authorize(connection.connection_id)}>{connection.status === "CONNECTED" ? "重新授權" : "授權連線"}</button>}
    </div>)}
    {message ? <p role="status">{message}</p> : null}
  </InteractionCard>
}
