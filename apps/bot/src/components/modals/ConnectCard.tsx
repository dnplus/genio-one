import { Link2, CheckCircle2 } from "lucide-react"

import { botCopy } from "../../lib/ui-copy"
import { InteractionCard } from "../common/InteractionCard"

export type ConnectCardPath = "oauth"
export type ConnectCardPhase = "choose" | "oauth_pending" | "connected" | "failed"

export interface ConnectCardResult {
  status: "CONNECTED"
  connectionId: string
}

export interface ConnectCardProps {
  resourceDisplayName: string
  resourceId: string
  phase: ConnectCardPhase
  busy?: boolean
  message?: string
  onSelectPath: (path: ConnectCardPath) => void
  onCancel: () => void
  onConnectedContinue?: () => void
}

export function connectCardPhaseLabel(phase: ConnectCardPhase): string {
  switch (phase) {
    case "choose":
      return botCopy("Connection required", "需連線")
    case "oauth_pending":
      return botCopy("Connecting", "連線中")
    case "connected":
      return botCopy("Available", "可用")
    case "failed":
      return botCopy("Connection required", "需連線")
  }
}

export function ConnectCard({
  resourceDisplayName,
  resourceId,
  phase,
  busy,
  message,
  onSelectPath,
  onCancel,
  onConnectedContinue,
}: ConnectCardProps) {
  const choose = phase === "choose" || phase === "failed"
  return (
    <InteractionCard
      tone="connect"
      testId="connect-card"
      extraClassName="connect-card"
      icon={<Link2 size={18} />}
      title={botCopy(`Connect · ${resourceDisplayName}`, `連接 · ${resourceDisplayName}`)}
      subtitle={botCopy(
        `Status: ${connectCardPhaseLabel(phase)} · It will return to “Available” when complete`,
        `狀態：${connectCardPhaseLabel(phase)} · 完成後即可回到「可用」`,
      )}
      onDismiss={busy ? undefined : onCancel}
      dismissLabel={botCopy("Close connection card", "關閉連接卡")}
      actions={choose ? (
        <button
          type="button"
          className="primary-button"
          data-connect-path="oauth"
          disabled={busy}
          onClick={() => onSelectPath("oauth")}
        >
          <Link2 size={14} /> {busy ? botCopy("Connecting…", "連線中…") : botCopy("Connect my account", "連接我的帳號")}
        </button>
      ) : phase === "connected" ? (
        <button type="button" className="primary-button" onClick={onConnectedContinue ?? onCancel}>
          {botCopy("Back to list", "回到列表")}
        </button>
      ) : undefined}
    >
      <div data-phase={phase} data-resource-id={resourceId}>
        {choose ? (
          <p>{botCopy("Connect your account for this service before adding it to this Bot.", "請先連接你在此服務的帳號，完成後才能加入這個 Bot。")}</p>
        ) : null}
        {phase === "oauth_pending" ? <p>{botCopy("Waiting for the account authorization callback. It will not be marked available until the connection is confirmed.", "正在等待帳號授權回呼，連線狀態確認前不會顯示可用。")}</p> : null}
        {phase === "connected" ? (
          <p className="connect-card-success"><CheckCircle2 size={18} /> {botCopy("Connected. The capability is available again; you can continue adding or invoking it.", "連線完成。能力狀態已回到「可用」，可繼續加入或呼叫。")}</p>
        ) : null}
        {message ? <p className="connect-card-message">{message}</p> : null}
      </div>
    </InteractionCard>
  )
}
