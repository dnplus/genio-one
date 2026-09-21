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
  listBots,
  getBotRuntimePolicy,
  startAccountOAuth,
  type CatalogAddRow,
  type CatalogAddState,
  type RuntimePolicySnapshot,
} from "../../lib/bot-api"
import { resolveCatalogAddState } from "../../../server/bot-binding-add"
import { ProfileForm } from "../common/ProfileForm"
import { CapabilityToolsPanel } from "./CapabilityToolsPanel"
import { BotOwnedSkillsPanel } from "./BotOwnedSkillsPanel"
import { BotSchedulesPanel } from "./BotSchedulesPanel"
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

function sharePolicyFor(bot: BotInstance): BotSharePolicy {
  return bot.sharePolicy ?? {
    visibility: "PRIVATE",
    discoverable: false,
    invocable: false,
    approval: "ALWAYS_ASK",
    audienceIds: [],
  }
}

function modelRouteFor(bot: BotInstance): ModelRoute {
  return bot.modelRoute === "genio-gateway" ? "genio-gateway" : "codex-subscription"
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function rebaseValue<T>(base: T, current: T, latest: T): T {
  return sameValue(base, current) ? latest : current
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
  onSave(updated: BotInstance): Promise<void> | void
  onDuplicate?: () => void
  onDelete?: () => void
  onBindingsChanged?: (bot: BotInstance) => void
}) {
  const [tab, setTab] = useState<"basic" | "skills" | "plugins" | "schedules" | "sharing">("basic")
  const [skillsVisited, setSkillsVisited] = useState(false)
  const [ownedSkillsDirty, setOwnedSkillsDirty] = useState(false)
  const [ownedSkillsBusy, setOwnedSkillsBusy] = useState(false)
  const [scheduleVisited, setScheduleVisited] = useState(false)
  const [scheduleDirty, setScheduleDirty] = useState(false)
  const [scheduleBusy, setScheduleBusy] = useState(false)
  const [formBase, setFormBase] = useState(bot)
  const [name, setName] = useState(bot.name)
  const [title, setTitle] = useState(bot.title || bot.role)
  const [description, setDescription] = useState(bot.description || bot.role)
  const [avatar, setAvatar] = useState(bot.avatar)
  const [skills, setSkills] = useState<string[]>(bot.skills || [])
  const [modelRoute, setModelRoute] = useState<ModelRoute>(modelRouteFor(bot))
  const [sharePolicy, setSharePolicy] = useState<BotSharePolicy>(sharePolicyFor(bot))
  const [catalogRows, setCatalogRows] = useState<CatalogAddRow[]>([])
  const [addMessage, setAddMessage] = useState("")
  const [addBusy, setAddBusy] = useState<string | null>(null)
  const [runtimePolicy, setRuntimePolicy] = useState<RuntimePolicySnapshot | null>(null)
  const [runtimePolicyLoading, setRuntimePolicyLoading] = useState(() => Boolean(accessToken))
  const [runtimePolicyError, setRuntimePolicyError] = useState("")
  const [saveError, setSaveError] = useState("")
  const [profileConflict, setProfileConflict] = useState(false)
  const [profileRefreshBusy, setProfileRefreshBusy] = useState(false)
  const [saveMessage, setSaveMessage] = useState("")
  const [savingSettings, setSavingSettings] = useState(false)
  const settingsBusy = savingSettings || scheduleBusy
  const profileSaveBlocked = savingSettings || ownedSkillsBusy || scheduleBusy
  const confirmDiscardSettingsDraft = () => !(ownedSkillsDirty || scheduleDirty) || window.confirm(botCopy("Discard unsaved Skill or schedule edits and close settings?", "要放棄尚未儲存的 Skill 或排程修改並關閉設定嗎？"))
  const requestClose = useCallback(() => {
    if (settingsBusy || ownedSkillsBusy) return
    if (!confirmDiscardSettingsDraft()) return
    onClose()
  }, [onClose, ownedSkillsBusy, ownedSkillsDirty, scheduleDirty, settingsBusy])

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

  const updatedBot = (): BotInstance => {
    const nextName = name.trim() || formBase.name
    const nextDescription = description.trim() || formBase.description || formBase.role
    const nextTitle = title.trim() || formBase.title || nextDescription
    return {
      ...formBase,
      name: nextName,
      title: nextTitle,
      description: nextDescription,
      role: nextDescription,
      avatar,
      skills,
      allowedTools: formBase.allowedTools ?? [],
      modelRoute,
      sharePolicy,
    }
  }

  const handleSave = async () => {
    if (profileRefreshBusy || profileSaveBlocked) return
    setSavingSettings(true)
    setSaveError("")
    setSaveMessage("")
    try {
      await onSave(updatedBot())
      requestClose()
    } catch (error) {
      const raw = error instanceof Error ? error.message : ""
      const conflict = /REVISION_CONFLICT/i.test(raw)
      setProfileConflict(conflict)
      setSaveError(conflict
        ? botCopy("This Bot changed elsewhere. Use the latest version to reapply your current edits, then save again.", "此 Bot 已在其他地方更新。請使用最新版本重新套用目前修改後再儲存。")
        : sanitizeUserFacingError(raw, botCopy("Settings could not be saved. Your changes are still here.", "設定尚未儲存。你的修改已保留。")))
    } finally {
      setSavingSettings(false)
    }
  }

  const hasNewerProfile = bot.id === formBase.id && (bot.revision ?? 0) > (formBase.revision ?? 0)

  const rebaseForm = async () => {
    if (!accessToken) {
      setSaveError(botCopy("Sign in to load the latest Bot version. Your current edits are still here.", "請登入後載入最新 Bot 版本。目前修改仍保留在畫面上。"))
      return
    }
    setProfileRefreshBusy(true)
    try {
      const latest = (await listBots(accessToken)).find((candidate) => candidate.id === bot.id)
      if (!latest) throw new Error("BOT_NOT_FOUND")
      const oldBase = formBase
      setName((current) => rebaseValue(oldBase.name, current, latest.name))
      setTitle((current) => rebaseValue(oldBase.title || oldBase.role, current, latest.title || latest.role))
      setDescription((current) => rebaseValue(oldBase.description || oldBase.role, current, latest.description || latest.role))
      setAvatar((current) => rebaseValue(oldBase.avatar, current, latest.avatar))
      setSkills((current) => rebaseValue(oldBase.skills ?? [], current, latest.skills ?? []))
      setModelRoute((current) => rebaseValue(modelRouteFor(oldBase), current, modelRouteFor(latest)))
      setSharePolicy((current) => rebaseValue(sharePolicyFor(oldBase), current, sharePolicyFor(latest)))
      setFormBase(latest)
      setProfileConflict(false)
      setSaveError("")
      setSaveMessage(botCopy("Latest Bot version loaded. Review your current edits, then save to apply them.", "已載入最新 Bot 版本。請確認目前修改後再儲存，以重新套用你的內容。"))
    } catch {
      setSaveError(botCopy("The latest Bot version could not be loaded. Your current edits are still here; try again before saving.", "無法載入最新 Bot 版本。目前修改仍保留；請重試後再儲存。"))
    } finally {
      setProfileRefreshBusy(false)
    }
  }

  const revisionNotice = (className = "") => (hasNewerProfile || profileConflict) ? (
    <div className={`bot-default-tools-notice ${className}`.trim()} role="status">
      <span>{botCopy("A newer Bot version is available. Your current edits stay on screen until you choose to apply them to that version.", "已有較新的 Bot 版本。目前修改會保留在畫面上，直到你選擇套用到最新版本。")}</span>
      <button type="button" className="secondary-button" onClick={() => void rebaseForm()} disabled={profileRefreshBusy}>{botCopy("Use latest version", "使用最新版本重新套用")}</button>
    </div>
  ) : null

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
  const selectTab = (next: typeof tab) => {
    if (settingsBusy) return
    if (next === "skills") setSkillsVisited(true)
    if (next === "schedules") setScheduleVisited(true)
    setTab(next)
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        requestClose()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [requestClose])

  return (
    <div className="profile-dialog-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-dialog-title">
        <header>
          <span>
            <strong id="profile-dialog-title">{botCopy("Bot settings", "Bot 設定")} · {bot.name}</strong>
            <small>{botCopy("Manage your profile, Bot-specific skills, and enterprise capabilities/tools", "管理基本資料、專屬技能與企業能力／工具")}</small>
          </span>
          <button className="icon-button" aria-label={botCopy("Close settings", "關閉設定")} onClick={requestClose} disabled={settingsBusy || ownedSkillsBusy}><X /></button>
        </header>

        <nav className="bot-settings-tabs">
          <button type="button" className={`bot-tab-btn ${tab === "basic" ? "active" : ""}`} onClick={() => selectTab("basic")} disabled={settingsBusy}>{botCopy("Profile", "基本資料")}</button>
          <button type="button" className={`bot-tab-btn ${tab === "skills" ? "active" : ""}`} onClick={() => selectTab("skills")} disabled={settingsBusy}>{botCopy("Bot skills", "專屬技能")}</button>
          <button type="button" className={`bot-tab-btn ${tab === "plugins" ? "active" : ""}`} onClick={() => selectTab("plugins")} disabled={settingsBusy}>{botCopy("Capabilities / tools", "能力／工具")}</button>
          <button type="button" className={`bot-tab-btn ${tab === "schedules" ? "active" : ""}`} onClick={() => selectTab("schedules")} disabled={settingsBusy}>{botCopy("Schedules", "排程")}</button>
          <button type="button" className={`bot-tab-btn ${tab === "sharing" ? "active" : ""}`} onClick={() => selectTab("sharing")} disabled={settingsBusy}>{botCopy("Sharing & @", "分享與 @")}</button>
        </nav>

        <div className="bot-tab-content">
          {tab === "basic" && (
            <>
              <div className="model-route-setting">
                <label className="setting-field">
                  <span>{botCopy("Model route", "模型路線")}</span>
                  <select value={modelRoute} onChange={(event) => setModelRoute(event.target.value === "genio-gateway" ? "genio-gateway" : "codex-subscription")} disabled={profileSaveBlocked}>
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
                onChange={(updated) => {
                  setName(updated.name)
                  setTitle(updated.title)
                  setDescription(updated.description)
                  setAvatar(updated.avatar)
                }}
                onComplete={() => void handleSave()}
                disabled={profileSaveBlocked}
              />
              {revisionNotice()}
              {saveMessage && <p role="status" className="bot-default-tools-message">{saveMessage}</p>}
              {saveError && <p role="alert" className="bot-default-tools-error">{saveError}</p>}
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
                        if (settingsBusy || ownedSkillsBusy || !confirmDiscardSettingsDraft()) return
                        if (window.confirm(`確定要刪除「${bot.name}」嗎？此動作無法復原。`)) {
                          onDelete()
                          onClose()
                        }
                      }}
                      disabled={settingsBusy || ownedSkillsBusy}
                    >
                      <Trash2 size={14} /> 刪除 Bot
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {skillsVisited && (
            <div hidden={tab !== "skills"}>
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
                    disabled={savingSettings}
                  />
                  <div className="skill-copy">
                    <strong>{skill.name}</strong>
                    <small>{skill.description}</small>
                  </div>
                </label>
              ))}
              <div style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end" }}>
                <button type="button" className="primary-button" disabled={savingSettings} onClick={() => void handleSave()}>儲存技能設定</button>
              </div>
              {saveError && <p role="alert" className="bot-default-tools-error">{saveError}</p>}
              {revisionNotice()}
              {saveMessage && <p role="status" className="bot-default-tools-message">{saveMessage}</p>}
              <BotOwnedSkillsPanel botId={bot.id} accessToken={accessToken} disabled={savingSettings} onDirtyChange={setOwnedSkillsDirty} onBusyChange={setOwnedSkillsBusy} />
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

          {scheduleVisited && <div hidden={tab !== "schedules"}><BotSchedulesPanel botId={bot.id} accessToken={accessToken} onBusyChange={setScheduleBusy} onDirtyChange={setScheduleDirty} /></div>}

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
                <button type="button" className="primary-button" disabled={savingSettings} onClick={() => void handleSave()}>儲存分享設定</button>
              </div>
              {saveError && <p role="alert" className="bot-default-tools-error">{saveError}</p>}
              {revisionNotice()}
              {saveMessage && <p role="status" className="bot-default-tools-message">{saveMessage}</p>}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
