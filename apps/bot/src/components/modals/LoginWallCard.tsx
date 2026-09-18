/**
 * UX P2 Login wall: human takeover / request_help.
 * Intentionally has NO password / secret input fields — login happens on the shared desktop.
 */
import { Hand, Monitor, ShieldAlert } from "lucide-react"

import { InteractionCard } from "../common/InteractionCard"
import { loginWallCardTitle, loginWallStatusLabel, type LoginWallView } from "../chat/hands-ui"

export interface LoginWallCardProps {
  wall: LoginWallView
  busy?: boolean
  onTakeover: () => void
  onCompleted: () => void
  onDismiss: () => void
}

export function LoginWallCard({ wall, busy, onTakeover, onCompleted, onDismiss }: LoginWallCardProps) {
  return (
    <InteractionCard
      tone="login"
      testId="login-wall-card"
      extraClassName="login-wall-card"
      icon={<ShieldAlert size={18} />}
      title={loginWallCardTitle(wall)}
      subtitle={`狀態：${loginWallStatusLabel(wall.status)} · 請在共用電腦操作，不要把密碼貼到聊天`}
      onDismiss={busy ? undefined : onDismiss}
      dismissLabel="關閉登入牆"
      actions={(
        <>
          <button
            type="button"
            className="primary-button"
            data-login-wall-action="takeover"
            disabled={busy || wall.status === "completed"}
            onClick={onTakeover}
          >
            <Hand size={14} /> {wall.status === "takeover_open" ? "繼續接管桌面" : "人類接管桌面"}
          </button>
          <button
            type="button"
            className="secondary-button"
            data-login-wall-action="completed"
            disabled={busy || wall.status === "completed"}
            onClick={onCompleted}
          >
            <Monitor size={14} /> 我已在桌面完成登入
          </button>
        </>
      )}
    >
      <p data-kind={wall.kind} data-status={wall.status} data-collects-password="false">
        {wall.reason}
      </p>
      <p className="login-wall-card-hint">
        登入畫面只出現在 Hands／遠端桌面預覽。此卡片<strong>不會</strong>收集密碼、OTP 或憑證。
      </p>
    </InteractionCard>
  )
}

export function loginWallCardHasPasswordInputs(container: {
  querySelectorAll: (sel: string) => ArrayLike<Element>
}): boolean {
  return container.querySelectorAll('input[type="password"], input[name*="password" i], input[name*="passwd" i]').length > 0
}
