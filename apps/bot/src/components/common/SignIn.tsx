import { useState } from "react"
import { LoaderCircle, ShieldCheck } from "lucide-react"
import { beginGenioLogin } from "../../lib/genio-one"
import { botCopy } from "../../lib/ui-copy"
import genioOneLogo from "../../../../../packages/brand/assets/logo-02.svg"

export function SignIn() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const startLogin = (forceReauthentication = false) => {
    setBusy(true)
    setError("")
    void beginGenioLogin(forceReauthentication ? { forceReauthentication: true } : undefined)
      .catch(() => {
        setError(botCopy("The sign-in service is temporarily unavailable. Please try again.", "登入服務暫時無法使用，請稍後重試。"))
        setBusy(false)
      })
  }

  return (
    <main className="gate-shell">
      <section className="gate-card">
        <img className="gate-brand-logo" src={genioOneLogo} alt="GenioOne" />
        <p className="quiet-label">Genio Bot</p>
        <h1>{botCopy("Start with your organization account", "用同一個企業身份開始")}</h1>
        <p>{botCopy("After you sign in to GenioOne, the Bot sees only Resources you can use or request.", "登入 GenioOne 後，Bot 只會看見你可使用或可申請的 Resource。")}</p>
        <button
          className="primary-button"
          disabled={busy}
          type="button"
          onClick={() => startLogin()}
        >
          {busy ? <LoaderCircle className="spin" /> : <ShieldCheck />}
          {botCopy("Sign in with GenioOne", "使用 GenioOne 登入")}
        </button>
        <button
          className="secondary-button"
          disabled={busy}
          type="button"
          onClick={() => startLogin(true)}
        >
          {botCopy("Sign in with another account", "使用其他帳號登入")}
        </button>
        {error ? <p className="designer-error" role="alert">{error}</p> : null}
      </section>
    </main>
  )
}
