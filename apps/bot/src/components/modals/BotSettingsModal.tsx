import { useCallback, useEffect, useMemo, useState } from "react"
import { Copy, Trash2, X } from "lucide-react"

import { AVAILABLE_SKILLS, type BotInstance, type BotSharePolicy } from "../../bots-storage"
import type { GenioCatalog } from "../../lib/genio-one"
import type { ModelRoute } from "../../lib/model-route"
import { botCopy } from "../../lib/ui-copy"
import {
  addBotBinding,
  getBotCatalogAdd,
  getAccountOAuthStatus,
  getBotRuntimePolicy,
  startAccountOAuth,
  type CatalogAddRow,
  type CatalogAddState,
  type RuntimePolicySnapshot,
} from "../../lib/bot-api"
import { resolveCatalogAddState } from "../../../server/bot-binding-add"
import { ProfileForm } from "../common/ProfileForm"
import { CapabilityToolsPanel } from "./CapabilityToolsPanel"
import type { ConnectCardPath, ConnectCardResult } from "./ConnectCard"
import { statusLabelFor, mapEnterpriseToSurfaceStatus } from "../../../server/bot-capability-surface"
import {
  denialCopyFor,
  humanDenialFor,
  sanitizeUserFacingError,
} from "../../../server/bot-capability-deny-copy"

const OAUTH_CONNECTION_COPY = {
  signInRequired: ["Sign in before completing the connection", "需要登入後才能完成連線"],
  connectionPending: ["The connection status is not confirmed", "連線狀態尚未確認"],
  unsupportedPath: ["This connection method is not supported", "不支援的連線方式"],
  allowPopup: ["Allow the OAuth window to open, then try again", "請允許開啟 OAuth 視窗後再試一次"],
  notReady: ["This connection is not ready. Try again later", "此連線尚未就緒，請稍後重試"],
  missingConnectionId: ["The connection did not return a Connection ID", "正式連線未回傳 Connection ID"],
  missingAuthorizationUrl: ["OAuth did not return an authorization URL", "正式 OAuth 未回傳授權網址"],
  invalidAuthorizationUrl: ["The authorization URL is invalid", "授權網址無效"],
  statusUnconfirmed: ["The connection status could not be confirmed", "正式連線狀態無法確認"],
  notComplete: ["OAuth is not complete. Finish authorization, then try again", "OAuth 尚未完成，請完成授權後再試一次"],
  connectedAndAdded: ["Connected and added", "已完成連線並加入"],
  addSignInRequired: ["Sign in before adding this capability; a checkbox is not authorization.", "需要登入後才能建立 BotBinding（checkbox 不是授權）"],
} as const

export type OAuthConnectionCopyKey = keyof typeof OAUTH_CONNECTION_COPY

export function oauthConnectionCopy(key: OAuthConnectionCopyKey): string {
  const [english, traditionalChinese] = OAUTH_CONNECTION_COPY[key]
  return botCopy<string>(english, traditionalChinese)
}

export function oauthConnectionRequiredCopy(statusLabel: string): string {
  return botCopy("Connection required · Complete your OAuth connection first.", `${statusLabel} · 請先完成使用者 OAuth 連線。`)
}

function capabilityStatusCopy(status: ReturnType<typeof mapEnterpriseToSurfaceStatus>): string {
  switch (status) {
    case "available":
    case "added":
      return botCopy("Available", statusLabelFor(status))
    case "connect_first":
      return botCopy("Connection required", statusLabelFor(status))
    case "request":
      return botCopy("Request access", statusLabelFor(status))
    case "unavailable":
      return botCopy("Unavailable", statusLabelFor(status))
    case "pending":
      return botCopy("Awaiting approval", statusLabelFor(status))
  }
}

function capabilityDenialCopy(kind: string, traditionalChinese: string): string {
  switch (kind) {
    case "connection":
      return botCopy("This capability needs an account connection before it can be added or invoked.", traditionalChinese)
    case "entitlement":
      return botCopy("You do not have access to this capability.", traditionalChinese)
    case "execution":
      return botCopy("This operation cannot run right now.", traditionalChinese)
    case "exposure":
      return botCopy("This capability is not available to this Bot.", traditionalChinese)
    default:
      return traditionalChinese
  }
}

function humanAddFeedback(addState: CatalogAddState, reason: string, note?: string): string {
  const status = mapEnterpriseToSurfaceStatus({ addState, binding: null })
  const label = capabilityStatusCopy(status)
  const denial = humanDenialFor({ addState, reasonCode: reason, phase: "list" })
  const safeNote = note ? sanitizeUserFacingError(note, "") : ""
  if (denial) {
    const message = capabilityDenialCopy(denial.kind, denial.message)
    return safeNote
      ? botCopy(`${label} · ${message} (${safeNote})`, `${label} · ${message}（${safeNote}）`)
      : `${label} · ${message}`
  }
  return safeNote ? botCopy(`${label} (${safeNote})`, `${label}（${safeNote}）`) : label
}

export function BotSettingsModal({
  bot,
  catalog,
  modelDirectory,
  accessToken,
  onClose,
  onSave,
  onDuplicate,
  onDelete,
  onBindingsChanged,
}: {
  bot: BotInstance
  catalog: GenioCatalog | null
  modelDirectory?: ModelRoute | null
  accessToken?: string
  onClose(): void
  onSave(updated: BotInstance): void
  onDuplicate?: () => void
  onDelete?: () => void
  onBindingsChanged?: (bot: BotInstance) => void
}) {
  const [tab, setTab] = useState<"basic" | "skills" | "plugins" | "sharing">("basic")
  const [name, setName] = useState(bot.name)
  const [title, setTitle] = useState(bot.title || bot.role)
  const [description, setDescription] = useState(bot.description || bot.role)
  const [avatar, setAvatar] = useState(bot.avatar)
  const [skills, setSkills] = useState<string[]>(bot.skills || [])
  const [modelRoute, setModelRoute] = useState<ModelRoute>(bot.modelRoute === "genio-gateway" ? "genio-gateway" : "codex-subscription")
  const [sharePolicy, setSharePolicy] = useState<BotSharePolicy>(bot.sharePolicy ?? {
    visibility: "PRIVATE",
    discoverable: false,
    invocable: false,
    approval: "ALWAYS_ASK",
    audienceIds: [],
  })
  const [catalogRows, setCatalogRows] = useState<CatalogAddRow[]>([])
  const [addMessage, setAddMessage] = useState("")
  const [addBusy, setAddBusy] = useState<string | null>(null)
  const [runtimePolicy, setRuntimePolicy] = useState<RuntimePolicySnapshot | null>(null)
  const [runtimePolicyLoading, setRuntimePolicyLoading] = useState(() => Boolean(accessToken))
  const [runtimePolicyError, setRuntimePolicyError] = useState("")

  const localRows = useMemo(() => {
    return (catalog?.capabilities ?? []).map((cap) => {
      const decision = resolveCatalogAddState(cap)
      const existing = bot.bindings?.find(
        (b) => b.resourceId === cap.resource_id && b.capabilityId === cap.capability_id,
      ) ?? null
      return {
        resourceId: cap.resource_id,
        capabilityId: cap.capability_id,
        resourceDisplayName: cap.resource_display_name,
        capabilityDisplayName: cap.capability_display_name,
        addState: decision.state,
        connectionStatus: decision.connectionStatus,
        reason: decision.reason,
        approvalPolicyRef: decision.approvalPolicyRef,
        skillId: decision.skillId,
        installBinding: decision.installBinding,
        pendingBinding: decision.pendingBinding,
        usableFromCatalogAlone: false as const,
        binding: existing,
      } satisfies CatalogAddRow
    })
  }, [catalog, bot.bindings])

  const loadRuntimePolicy = useCallback(async () => {
    if (!accessToken) {
      setRuntimePolicy(null)
      setRuntimePolicyError("")
      return
    }
    setRuntimePolicyLoading(true)
    setRuntimePolicyError("")
    try {
      setRuntimePolicy(await getBotRuntimePolicy(accessToken, bot.id))
    } catch {
      setRuntimePolicy(null)
      setRuntimePolicyError(botCopy("Runtime policy could not be loaded. Runtime capabilities are paused.", "Runtime policy 無法載入，Runtime 能力暫停。"))
    } finally {
      setRuntimePolicyLoading(false)
    }
  }, [accessToken, bot.id])

  useEffect(() => {
    if (tab !== "plugins") return
    if (!accessToken) {
      setCatalogRows(localRows)
      setRuntimePolicy(null)
      setRuntimePolicyError("")
      return
    }
    let cancelled = false
    void getBotCatalogAdd(accessToken, bot.id)
      .then((result) => {
        if (!cancelled) setCatalogRows(result.catalog)
      })
      .catch(() => {
        if (!cancelled) setCatalogRows(localRows)
      })
    void loadRuntimePolicy()
    return () => { cancelled = true }
  }, [tab, accessToken, bot.id, localRows, loadRuntimePolicy])

  const handleSave = () => {
    const nextDescription = description.trim() || bot.description || bot.role
    onSave({
      ...bot,
      name: name.trim() || bot.name,
      title: title.trim() || bot.title || nextDescription,
      description: nextDescription,
      role: nextDescription,
      avatar,
      skills,
      // Keep existing preference projection; plugins tab no longer writes checkbox auth.
      allowedTools: bot.allowedTools ?? [],
      modelRoute,
      sharePolicy,
    })
    onClose()
  }

  const toggleSkill = (id: string) => {
    setSkills((curr) => curr.includes(id) ? curr.filter((s) => s !== id) : [...curr, id])
  }

  const finishConnection = async (row: CatalogAddRow, connectionId: string): Promise<void> => {
    if (!accessToken) throw new Error(oauthConnectionCopy("signInRequired"))
    if (!connectionId.trim()) throw new Error(oauthConnectionCopy("connectionPending"))
    const added = await addBotBinding(accessToken, bot.id, {
      resourceId: row.resourceId,
      capabilityId: row.capabilityId,
      skillId: row.skillId ?? undefined,
      approvalPolicyRef: row.approvalPolicyRef ?? undefined,
    })
    setAddMessage(humanAddFeedback(added.addState, added.reason, oauthConnectionCopy("connectedAndAdded")))
    const refreshed = await getBotCatalogAdd(accessToken, bot.id)
    setCatalogRows(refreshed.catalog)
    onBindingsChanged?.({ ...bot, bindings: refreshed.bindings })
  }

  const handleConnectPath = async (row: CatalogAddRow, path: ConnectCardPath): Promise<ConnectCardResult> => {
    if (!accessToken) {
      throw new Error(oauthConnectionCopy("signInRequired"))
    }
    if (path !== "oauth") throw new Error(oauthConnectionCopy("unsupportedPath"))

    const popup = typeof window === "undefined" ? null : window.open("about:blank", "genio-one-oauth", "popup,width=520,height=720")
    if (!popup) throw new Error(oauthConnectionCopy("allowPopup"))
    popup.opener = null
    try {
      const started = await startAccountOAuth(accessToken, row.resourceId)
      if (started.provider !== "platform") throw new Error(oauthConnectionCopy("notReady"))
      const connectionId = started.connectionId?.trim()
      if (!connectionId) throw new Error(oauthConnectionCopy("missingConnectionId"))
      if (started.status === "CONNECTED" || started.alreadyConnected) {
        popup.close()
        await finishConnection(row, connectionId)
        return { status: "CONNECTED", connectionId }
      }
      const authorizationUrl = started.authorizationUrl?.trim()
      if (!authorizationUrl) throw new Error(oauthConnectionCopy("missingAuthorizationUrl"))
      const parsedUrl = new URL(authorizationUrl)
      if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsedUrl.hostname))) {
        throw new Error(oauthConnectionCopy("invalidAuthorizationUrl"))
      }
      popup.location.href = parsedUrl.toString()
      const expiry = typeof started.expiresAt === "number" && Number.isFinite(started.expiresAt)
        ? started.expiresAt * 1000
        : Date.now() + 120_000
      const deadline = Math.min(expiry, Date.now() + 120_000)
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        const status = await getAccountOAuthStatus(accessToken, row.resourceId, connectionId)
        if (status.provider !== "platform" || status.connectionId !== connectionId) throw new Error(oauthConnectionCopy("statusUnconfirmed"))
        if (status.status === "CONNECTED") {
          popup.close()
          await finishConnection(row, connectionId)
          return { status: "CONNECTED", connectionId }
        }
      }
      throw new Error(oauthConnectionCopy("notComplete"))
    } finally {
      if (!popup.closed) popup.close()
    }
  }

  const handleAdd = async (row: CatalogAddRow) => {
    setAddMessage("")
    if (row.addState === "DENIED") {
      const copy = humanDenialFor({ addState: row.addState, reasonCode: row.reason, phase: "list" })
        ?? denialCopyFor("entitlement")
      setAddMessage(`${copy.statusLabel} · ${copy.message}`)
      return
    }
    if (!accessToken) {
      setAddMessage(oauthConnectionCopy("addSignInRequired"))
      return
    }
    const key = `${row.resourceId}:${row.capabilityId}`
    setAddBusy(key)
    try {
      if (row.addState === "NEEDS_CONNECTION") {
        setAddMessage(oauthConnectionRequiredCopy(denialCopyFor("connection").statusLabel))
        return
      }

      const result = await addBotBinding(accessToken, bot.id, {
        resourceId: row.resourceId,
        capabilityId: row.capabilityId,
        skillId: row.skillId ?? undefined,
        approvalPolicyRef: row.approvalPolicyRef ?? undefined,
      })
      setAddMessage(humanAddFeedback(result.addState, result.reason, result.note))
      const refreshed = await getBotCatalogAdd(accessToken, bot.id)
      setCatalogRows(refreshed.catalog)
      onBindingsChanged?.({ ...bot, bindings: refreshed.bindings })
    } catch (error) {
      setAddMessage(sanitizeUserFacingError(
        error instanceof Error ? error.message : "",
        "加入未完成，請稍後再試。",
      ))
    } finally {
      setAddBusy(null)
    }
  }

  const rows = catalogRows.length > 0 ? catalogRows : localRows

  return (
    <div className="profile-dialog-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-dialog-title">
        <header>
          <span>
            <strong id="profile-dialog-title">{botCopy("Bot settings", "Bot 設定")} · {bot.name}</strong>
            <small>{botCopy("Manage your profile, Bot-specific skills, and enterprise capabilities/tools", "管理基本資料、專屬技能與企業能力／工具")}</small>
          </span>
          <button className="icon-button" aria-label={botCopy("Close settings", "關閉設定")} onClick={onClose}><X /></button>
        </header>

        <nav className="bot-settings-tabs">
          <button type="button" className={`bot-tab-btn ${tab === "basic" ? "active" : ""}`} onClick={() => setTab("basic")}>{botCopy("Profile", "基本資料")}</button>
          <button type="button" className={`bot-tab-btn ${tab === "skills" ? "active" : ""}`} onClick={() => setTab("skills")}>{botCopy("Bot skills", "專屬技能")}</button>
          <button type="button" className={`bot-tab-btn ${tab === "plugins" ? "active" : ""}`} onClick={() => setTab("plugins")}>{botCopy("Capabilities / tools", "能力／工具")}</button>
          <button type="button" className={`bot-tab-btn ${tab === "sharing" ? "active" : ""}`} onClick={() => setTab("sharing")}>{botCopy("Sharing & @", "分享與 @")}</button>
        </nav>

        <div className="bot-tab-content">
          {tab === "basic" && (
            <>
              <div className="model-route-setting">
                <label className="setting-field">
                  <span>{botCopy("Model route", "模型路線")}</span>
                  <select value={modelRoute} onChange={(event) => setModelRoute(event.target.value === "genio-gateway" ? "genio-gateway" : "codex-subscription")}>
                    <option value="codex-subscription">{botCopy("Personal Codex", "個人 Codex")}</option>
                    <option value="genio-gateway">{botCopy("Company model (Genio Gateway)", "公司模型（Genio Gateway）")}</option>
                  </select>
                  <small>
                    {modelRoute === "genio-gateway"
                      ? modelDirectory === "genio-gateway"
                        ? botCopy("This Bot uses the company model and can select only models allowed by company policy.", "目前使用公司模型；只能選擇公司政策允許的可用模型。")
                        : botCopy("The company model is not loaded yet. Saving will check available models and access.", "尚未載入公司模型；儲存後將檢查可用模型與使用權限。")
                      : botCopy("Conversations use your Codex account and may require sign-in.", "開始對話時會使用你的 Codex 帳號，必要時要求登入。")}
                  </small>
                </label>
              </div>
              <ProfileForm
                profile={{ name, title, description, role: description, avatar }}
                submitLabel={botCopy("Save changes", "儲存變更")}
                onComplete={(updated) => {
                  setName(updated.name)
                  setTitle(updated.title)
                  setDescription(updated.description)
                  setAvatar(updated.avatar)
                  onSave({
                    ...bot,
                    name: updated.name,
                    title: updated.title,
                    description: updated.description,
                    role: updated.description,
                    avatar: updated.avatar,
                    skills,
                    allowedTools: bot.allowedTools ?? [],
                    modelRoute,
                    sharePolicy,
                  })
                  onClose()
                }}
              />
              {onDelete && (
                <div className="danger-zone-box" style={{ marginTop: "20px", paddingTop: "16px", borderTop: "1px solid #fee4e2" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <strong style={{ color: "#b42318", fontSize: "13px" }}>危險區域</strong>
                      <p style={{ margin: "2px 0 0", color: "#657571", fontSize: "12px" }}>刪除此 Bot 及其所有對話紀錄與設定。此動作無法復原。</p>
                    </div>
                    <button
                      type="button"
                      className="danger-button"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        background: "#fee4e2",
                        color: "#b42318",
                        border: "1px solid #fecdca",
                        borderRadius: "8px",
                        padding: "6px 12px",
                        fontSize: "13px",
                        cursor: "pointer",
                        fontWeight: 600,
                      }}
                      onClick={() => {
                        if (window.confirm(`確定要刪除「${bot.name}」嗎？此動作無法復原。`)) {
                          onDelete()
                          onClose()
                        }
                      }}
                    >
                      <Trash2 size={14} /> 刪除 Bot
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === "skills" && (
            <div className="skill-list">
              <p style={{ fontSize: "13px", color: "#657571", marginBottom: "8px" }}>
                專屬技能是此 Bot 的作業指導手冊與 SOP 指引（Prompt），未啟用的技能不會佔用上下文：
              </p>
              {AVAILABLE_SKILLS.map((skill) => (
                <label key={skill.id} className="skill-item">
                  <input
                    type="checkbox"
                    checked={skills.includes(skill.id)}
                    onChange={() => toggleSkill(skill.id)}
                  />
                  <div className="skill-copy">
                    <strong>{skill.name}</strong>
                    <small>{skill.description}</small>
                  </div>
                </label>
              ))}
              <div style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end" }}>
                <button type="button" className="primary-button" onClick={handleSave}>儲存技能設定</button>
              </div>
            </div>
          )}

          {tab === "plugins" && (
            <CapabilityToolsPanel
              catalogRows={rows}
              addBusy={addBusy}
              addMessage={addMessage}
              onEnterpriseAction={(row) => void handleAdd(row)}
              onConnectPath={(row, path) => handleConnectPath(row, path)}
              personalConnection={catalog?.tenant_id && accessToken ? {
                tenantId: catalog.tenant_id,
                accessToken,
                onComplete: async (row, status, connectionId) => {
                  await finishConnection(row, connectionId)
                  if (status === "SAVED") setAddMessage("帳密已保存，使用工具時會再驗證服務連線。")
                },
              } : undefined}
              runtimePolicy={runtimePolicy}
              runtimePolicyLoading={runtimePolicyLoading}
              runtimePolicyError={runtimePolicyError}
              onRetryRuntimePolicy={() => void loadRuntimePolicy()}
            />
          )}

          {tab === "sharing" && (
            <div className="sharing-setting-box">
              <p style={{ fontSize: "13px", color: "#657571", marginBottom: "12px" }}>
                只有明確開啟分享與呼叫，其他使用者才會在 @ 選單看見這個 Bot。
              </p>
              <label className="setting-field">
                <span>可見範圍</span>
                <select value={sharePolicy.visibility} onChange={(event) => setSharePolicy((current) => ({ ...current, visibility: event.target.value as BotSharePolicy["visibility"] }))}>
                  <option value="PRIVATE">私人</option>
                  <option value="SELECTED">指定成員</option>
                  <option value="TEAM">團隊</option>
                  <option value="ORG">整個組織</option>
                </select>
              </label>
              {sharePolicy.visibility === "SELECTED" && <label className="setting-field"><span>指定成員 Subject ID</span><input value={sharePolicy.audienceIds.join(", ")} onChange={(event) => setSharePolicy((current) => ({ ...current, audienceIds: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) }))} placeholder="person-a, person-b" /></label>}
              <label className="skill-item"><input type="checkbox" checked={sharePolicy.discoverable} onChange={(event) => setSharePolicy((current) => ({ ...current, discoverable: event.target.checked }))} /><div className="skill-copy"><strong>允許被搜尋</strong><small>出現在符合範圍的 Bot 選單</small></div></label>
              <label className="skill-item"><input type="checkbox" checked={sharePolicy.invocable} onChange={(event) => setSharePolicy((current) => ({ ...current, invocable: event.target.checked }))} /><div className="skill-copy"><strong>允許被 @ 呼叫</strong><small>接受其他 Bot 的工作請求</small></div></label>
              <label className="setting-field"><span>呼叫核准方式</span><select value={sharePolicy.approval} onChange={(event) => setSharePolicy((current) => ({ ...current, approval: event.target.value as BotSharePolicy["approval"] }))}><option value="ALWAYS_ASK">每次詢問我</option><option value="POLICY_AUTO_APPROVE">符合政策自動核准</option></select></label>
              <div className="setting-actions">
                {onDuplicate && <button type="button" className="secondary-button" onClick={onDuplicate}><Copy /> 複製 Bot</button>}
                <button type="button" className="primary-button" onClick={handleSave}>儲存分享設定</button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
