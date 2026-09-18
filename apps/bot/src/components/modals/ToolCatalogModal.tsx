import { useMemo, useState } from "react"
import { Check, Plug, Sparkles, X } from "lucide-react"
import type { BotInstance } from "../../bots-storage"
import type { GenioCatalog, GenioCatalogCapability } from "../../lib/genio-one"
import {
  companyModelGroups,
  enterpriseToolGroups,
  humanAddLabel,
} from "../../lib/catalog-surface"
import { resolveCatalogAddState } from "../../../server/bot-binding-add"
import { PersonalConnectionCard } from "./PersonalConnectionCard"

export function ToolCatalogModal({
  catalog,
  toolStatusText,
  mcpStatus,
  activeBot,
  accessToken,
  onClose,
  onRetryMcp,
  onToggleBinding,
}: {
  catalog: GenioCatalog | null
  toolStatusText: string
  mcpStatus: string
  activeBot?: BotInstance
  accessToken?: string
  onClose: () => void
  onRetryMcp: () => void
  onToggleBinding?: (botId: string, resourceId: string, capabilityId: string, currentlyInstalled: boolean) => Promise<void>
}) {
  const capabilities = catalog?.capabilities ?? []
  const [showLab, setShowLab] = useState(false)
  const [connecting, setConnecting] = useState<GenioCatalogCapability | null>(null)
  const [pane, setPane] = useState<"in-use" | "available">("in-use")
  const [bindingBusyKey, setBindingBusyKey] = useState<string | null>(null)
  const [bindingError, setBindingError] = useState("")

  const toolGroups = useMemo(
    () => enterpriseToolGroups(capabilities, activeBot?.bindings, showLab),
    [capabilities, activeBot?.bindings, showLab],
  )
  const inUse = toolGroups.filter((group) => group.bound)
  const available = toolGroups.filter((group) => !group.bound)
  const models = useMemo(() => companyModelGroups(capabilities, showLab), [capabilities, showLab])
  const runtimePending = mcpStatus !== "已連線" && !mcpStatus.includes("個工具") && inUse.length > 0

  const handleToggle = async (cap: GenioCatalogCapability, currentlyInstalled: boolean) => {
    if (!activeBot || !onToggleBinding) return
    const actionKey = `${cap.resource_id}:${currentlyInstalled ? "remove" : "add"}`
    if (bindingBusyKey) return
    setBindingError("")
    setBindingBusyKey(actionKey)
    try {
      await onToggleBinding(activeBot.id, cap.resource_id, cap.capability_id, currentlyInstalled)
      onRetryMcp()
    } catch (error) {
      setBindingError(error instanceof Error && error.message ? error.message : "工具變更失敗")
    } finally {
      setBindingBusyKey(null)
    }
  }

  const renderGroup = (group: (typeof toolGroups)[number], bound: boolean) => {
    const primary = group.capabilities[0]!
    const decision = resolveCatalogAddState(primary)
    const canEnable = decision.state === "AUTO_GRANT" || decision.state === "ENTITLED" || decision.state === "CONNECTED"
    const summary = [...new Set(group.capabilities.map((cap) => cap.capability_display_name).filter(Boolean))].join("、")
    return (
      <div className="resource-row" key={group.resourceId}>
        <span className="resource-icon"><Plug /></span>
        <span className="resource-copy">
          <strong>{group.title}</strong>
          <small>{summary || "企業工具"}</small>
        </span>
        <div className="resource-action-wrap">
          {!primary.builtin_service && accessToken && (primary.access === "AUTO_GRANT" || primary.access === "ENTITLED") ? (
            <button type="button" className="catalog-action-btn" onClick={() => setConnecting(primary)}>連線設定</button>
          ) : null}
          {primary.builtin_service ? <span className="installed-badge"><Check size={13} />預設內建</span> : bound ? (
            <>
              <span className="installed-badge"><Check size={13} />這個 Bot 正在用</span>
              {onToggleBinding && (
                <button
                  type="button"
                  className="catalog-action-btn disable-btn"
                  disabled={bindingBusyKey !== null}
                  onClick={() => void handleToggle(primary, true)}
                >
                  {bindingBusyKey === `${group.resourceId}:remove` ? "處理中…" : "移出"}
                </button>
              )}
            </>
          ) : (
            <>
              <span className={decision.state === "REQUEST" || decision.state === "DENIED" ? "requestable" : "available"}>
                {humanAddLabel(decision.state)}
              </span>
              {canEnable && onToggleBinding && (
                <button
                  type="button"
                  className="catalog-action-btn enable-btn"
                  disabled={bindingBusyKey !== null}
                  onClick={() => void handleToggle(primary, false)}
                >
                  {bindingBusyKey === `${group.resourceId}:add` ? "處理中…" : "加入這個 Bot"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className="profile-dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section className="profile-dialog catalog-dialog" role="dialog" aria-modal="true">
        <header>
          <span>
            <strong>這個 Bot 的工具</strong>
            <small>{catalog?.subject_display_name || "已驗證成員"} · {toolStatusText}</small>
          </span>
          <button type="button" className="icon-button" onClick={onClose} aria-label="關閉">
            <X />
          </button>
        </header>
        <div className="catalog-content">
          {connecting && catalog && accessToken ? <PersonalConnectionCard
            key={connecting.resource_id}
            tenantId={catalog.tenant_id}
            resourceId={connecting.resource_id}
            resourceName={connecting.resource_display_name}
            accessToken={accessToken}
            onClose={() => setConnecting(null)}
            onConnected={onRetryMcp}
          /> : null}
          {runtimePending && (
            <div className="catalog-alert">
              <span><Plug />這場對話的工具尚未就緒，請確認模型登入與連線狀態後重試。</span>
              <button type="button" onClick={onRetryMcp}>重試</button>
            </div>
          )}
          {bindingError && <div className="catalog-alert" role="alert">工具變更未完成：{bindingError}</div>}

          <div className="catalog-pane-tabs">
            <button type="button" className={pane === "in-use" ? "active" : ""} onClick={() => setPane("in-use")}>
              正在用（{inUse.length}）
            </button>
            <button type="button" className={pane === "available" ? "active" : ""} onClick={() => setPane("available")}>
              可加入（{available.length}）
            </button>
          </div>

          {pane === "in-use" ? (
            <div className="resource-list">
              {inUse.map((group) => renderGroup(group, true))}
              {inUse.length === 0 && (
                <div className="search-empty">這個 Bot 還沒帶企業工具。可從「可加入」選你真正要用的資源，不會自動全開。</div>
              )}
            </div>
          ) : (
            <div className="resource-list">
              {available.map((group) => renderGroup(group, false))}
              {available.length === 0 && (
                <div className="search-empty">目前沒有可加入這個 Bot 的企業工具。</div>
              )}
            </div>
          )}

          <div className="catalog-model-note">
            <Sparkles size={14} />
            <span>
              對話要用哪顆模型，在輸入框旁選擇。公司模型不會出現在工具清單裡。
              {models.length > 0 ? ` 目前可見 ${models.length} 個公司模型。` : " 目前沒有可選的公司模型。"}
            </span>
          </div>

          <label className="catalog-lab-toggle">
            <input type="checkbox" checked={showLab} onChange={(event) => setShowLab(event.target.checked)} />
            顯示測試／實驗資源
          </label>
        </div>
      </section>
    </div>
  )
}
