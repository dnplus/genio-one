import { Plug, Terminal } from "lucide-react"
import { useState } from "react"

import type { CatalogAddRow, RuntimePolicySnapshot } from "../../lib/bot-api"
import { botCopy } from "../../lib/ui-copy"
import {
  buildCapabilitySurface,
  runtimeExposePolicyFromSnapshot,
  type CapabilitySurfaceRow,
} from "../../../server/bot-capability-surface"
import {
  CODEX_CORE_CAPABILITY_DEFS,
  CODEX_SUBSCRIPTION_CAPABILITY_DEF,
  GENIO_DESKTOP_ADAPTER_CAPABILITY_DEFS,
} from "../../../server/codex-runtime-catalog"
import { ConnectCard, type ConnectCardPath, type ConnectCardResult, type ConnectCardPhase } from "./ConnectCard"
import { PersonalConnectionCard } from "./PersonalConnectionCard"

export function catalogRowsToEnterpriseInputs(rows: CatalogAddRow[]) {
  return rows.map((row) => ({
    resourceId: row.resourceId,
    capabilityId: row.capabilityId,
    resourceDisplayName: row.resourceDisplayName,
    capabilityDisplayName: row.capabilityDisplayName,
    addState: row.addState,
    reason: row.reason,
    binding: row.binding
      ? { state: row.binding.state as "INSTALLED" | "PENDING" | "DENIED" | "FAILED" }
      : null,
  }))
}

export function buildBotCapabilityRows(catalogRows: CatalogAddRow[], runtimePolicy: RuntimePolicySnapshot | null): CapabilitySurfaceRow[] {
  const runtimeDefs = [
    CODEX_SUBSCRIPTION_CAPABILITY_DEF,
    ...CODEX_CORE_CAPABILITY_DEFS,
    ...GENIO_DESKTOP_ADAPTER_CAPABILITY_DEFS.map((definition) => ({
      ...definition,
      display_name: botCopy("Genio desktop", "Genio 桌面"),
      description: botCopy("Operate this Bot's managed desktop", "操作這個 Bot 的受管理桌面"),
    })),
  ]
  return buildCapabilitySurface({
    enterprise: catalogRowsToEnterpriseInputs(catalogRows),
    runtimeDefs,
    runtimePolicy: runtimeExposePolicyFromSnapshot(runtimePolicy),
  })
}

export function groupEnterpriseCapabilityRows(surface: CapabilitySurfaceRow[]) {
  const groups = new Map<string, { resourceId: string; title: string; rows: CapabilitySurfaceRow[] }>()
  for (const row of surface) {
    if (!row.enterprise) continue
    const id = row.enterprise.resourceId
    const group = groups.get(id)
    if (group) group.rows.push(row)
    else groups.set(id, { resourceId: id, title: row.title, rows: [row] })
  }
  return [...groups.values()]
}

export function runtimePolicySourceLabel(snapshot: RuntimePolicySnapshot): string {
  const sources = new Set(snapshot.decisions.map((decision) => JSON.stringify([
    decision.policy_id,
    decision.policy_display_name,
    decision.policy_revision,
  ])))
  return sources.size > 1
    ? botCopy("Multiple policies", "多項政策")
    : snapshot.policy_display_name ?? botCopy("No policy source provided", "未提供政策來源")
}

function capabilityStatusLabel(row: CapabilitySurfaceRow): string {
  switch (row.status) {
    case "available":
    case "added":
      return botCopy("Available", row.statusLabel)
    case "connect_first":
      return botCopy("Connection required", row.statusLabel)
    case "request":
      return botCopy("Request access", row.statusLabel)
    case "unavailable":
      return botCopy("Unavailable", row.statusLabel)
    case "pending":
      return botCopy("Awaiting approval", row.statusLabel)
  }
}

function capabilityActionLabel(row: CapabilitySurfaceRow): string {
  switch (row.status) {
    case "available":
      return botCopy(row.source === "runtime" ? "Ready" : "Add", row.ctaLabel)
    case "added":
      return botCopy("Added", row.ctaLabel)
    case "connect_first":
      return botCopy("Connect", row.ctaLabel)
    case "request":
      return botCopy("Request access", row.ctaLabel)
    case "unavailable":
      return botCopy("Unavailable", row.ctaLabel)
    case "pending":
      return botCopy("Awaiting approval", row.ctaLabel)
  }
}

function capabilityUserMessage(row: CapabilitySurfaceRow): string | undefined {
  if (!row.userMessage) return undefined
  switch (row.status) {
    case "connect_first":
      return botCopy("This capability needs an account connection before it can be added or invoked.", row.userMessage)
    case "request":
      return botCopy("You do not have access yet, but you can request it.", row.userMessage)
    case "pending":
      return botCopy("Your access request was sent and is awaiting approval.", row.userMessage)
    case "unavailable":
      switch (row.denialKind) {
        case "connection":
          return botCopy("This capability needs an account connection before it can be added or invoked.", row.userMessage)
        case "execution":
          return botCopy("This operation cannot run right now. The preflight check did not pass.", row.userMessage)
        case "exposure":
          return botCopy("This capability is not available to this Bot.", row.userMessage)
        default:
          return botCopy("You do not have access to this capability.", row.userMessage)
      }
    default:
      return row.userMessage
  }
}

export function CapabilityToolsPanel({
  catalogRows,
  addBusy,
  addMessage,
  onEnterpriseAction,
  onConnectPath,
  personalConnection,
  runtimePolicy,
  runtimePolicyLoading = false,
  runtimePolicyError,
  onRetryRuntimePolicy,
}: {
  catalogRows: CatalogAddRow[]
  addBusy: string | null
  addMessage: string
  onEnterpriseAction: (row: CatalogAddRow) => void
  onConnectPath?: (row: CatalogAddRow, path: ConnectCardPath) => Promise<ConnectCardResult>
  personalConnection?: {
    tenantId: string
    accessToken: string
    onComplete: (row: CatalogAddRow, status: "CONNECTED" | "SAVED", connectionId: string) => Promise<void> | void
  }
  runtimePolicy: RuntimePolicySnapshot | null
  runtimePolicyLoading?: boolean
  runtimePolicyError?: string
  onRetryRuntimePolicy?: () => void
}) {
  const surface = buildBotCapabilityRows(catalogRows, runtimePolicy)
  const catalogByKey = new Map<string, CatalogAddRow>(
    catalogRows.map((row) => [`enterprise:${row.resourceId}:${row.capabilityId}`, row]),
  )

  const [connectKey, setConnectKey] = useState<string | null>(null)
  const [connectPhase, setConnectPhase] = useState<ConnectCardPhase>("choose")
  const [connectMessage, setConnectMessage] = useState("")
  const [connectBusy, setConnectBusy] = useState(false)

  const connectEnterprise = connectKey ? catalogByKey.get(connectKey) : undefined
  const connectRow = connectKey ? surface.find((r) => r.key === connectKey) : undefined

  const closeConnect = () => {
    setConnectKey(null)
    setConnectPhase("choose")
    setConnectMessage("")
    setConnectBusy(false)
  }

  const handleSelectPath = async (path: ConnectCardPath) => {
    if (!connectEnterprise) return
    setConnectBusy(true)
    setConnectPhase("oauth_pending")
    setConnectMessage("")
    try {
      if (!onConnectPath) throw new Error(botCopy("Connection features are not ready. Try again later.", "連線功能尚未就緒，請稍後重試。"))
      const result = await onConnectPath(connectEnterprise, path)
      if (!result.connectionId.trim()) throw new Error(botCopy("The connection status is not confirmed", "連線狀態尚未確認"))
      setConnectPhase("connected")
      setConnectMessage(botCopy("Connection completed and status confirmed.", "連接已完成，連線狀態已確認。"))
    } catch (error) {
      setConnectPhase("failed")
      setConnectMessage(error instanceof Error ? error.message : botCopy("Connection is not complete. Try again.", "連線未完成，請再試一次。"))
    } finally {
      setConnectBusy(false)
    }
  }

  const handlePersonalConnection = async (status: "CONNECTED" | "SAVED", connectionId: string) => {
    if (!connectEnterprise || !personalConnection) return
    setConnectBusy(true)
    setConnectMessage("")
    try {
      await personalConnection.onComplete(connectEnterprise, status, connectionId)
      closeConnect()
    } catch (error) {
      setConnectMessage(error instanceof Error ? error.message : botCopy("Connection is not complete. Try again.", "連線尚未完成，請再試一次。"))
    } finally {
      setConnectBusy(false)
    }
  }

  const enterpriseGroups = groupEnterpriseCapabilityRows(surface)
  const runtimeRows = surface.filter((row) => row.source === "runtime")
  const renderRow = (row: CapabilitySurfaceRow) => {
    const enterprise = row.source === "enterprise" ? catalogByKey.get(row.key) : undefined
    const busyKey = enterprise ? `${enterprise.resourceId}:${enterprise.capabilityId}` : null
    const busy = busyKey !== null && addBusy === busyKey
    const isConnect = row.status === "connect_first"
    const userMessage = capabilityUserMessage(row)
    const disabled =
      row.source === "runtime"
        ? true
        : row.ctaDisabled || busy || !enterprise

    return (
      <div
        key={row.key}
        className={`plugin-item plugin-add-row capability-surface-row source-${row.source}${row.status === "unavailable" ? " is-denied" : ""}`}
        data-source={row.source}
        data-status={row.status}
        data-denial-kind={row.denialKind || ""}
        data-effective-allow={row.effectiveAllow ? "true" : "false"}
      >
        <span className="capability-surface-icon" aria-hidden>
          {row.source === "runtime" ? <Terminal size={16} /> : <Plug size={16} />}
        </span>
        <div className="plugin-copy">
          <strong>{row.source === "enterprise" ? row.subtitle : row.title}</strong>
          {row.source === "runtime" ? <small>{row.subtitle}</small> : null}
          <small
            className={
              row.status === "unavailable" || row.status === "request" || row.status === "connect_first"
                ? "requestable"
                : "available"
            }
          >
            {row.source === "runtime" ? "Runtime" : botCopy("Enterprise", "企業")} · {capabilityStatusLabel(row)}
          </small>
          {userMessage ? <small className="capability-user-message">{userMessage}</small> : null}
        </div>
        {enterprise?.builtinService !== "DISCOVERY" && <button
          type="button"
          className="primary-button"
          disabled={disabled && !isConnect}
          onClick={() => {
            if (!enterprise) return
            if (isConnect) {
              setConnectKey(row.key)
              setConnectPhase("choose")
              setConnectMessage("")
              return
            }
            onEnterpriseAction(enterprise)
          }}
        >
          {busy ? "…" : capabilityActionLabel(row)}
        </button>}
      </div>
    )
  }
  return (
    <div className="plugin-list capability-tools-panel">
      <p className="capability-panel-note">{botCopy("Choose the enterprise tools this Bot can use, then review access and connection status.", "選擇這個 Bot 要使用的企業工具，並查看存取與連線狀態。")}</p>

      {connectEnterprise && connectRow && connectEnterprise.resourceId === "mail2000" && personalConnection ? (
        <PersonalConnectionCard
          tenantId={personalConnection.tenantId}
          resourceId={connectEnterprise.resourceId}
          resourceName={connectEnterprise.resourceDisplayName || connectEnterprise.resourceId}
          accessToken={personalConnection.accessToken}
          onClose={closeConnect}
          onConnected={(connectionId) => void handlePersonalConnection("CONNECTED", connectionId)}
          onSaved={(connectionId) => void handlePersonalConnection("SAVED", connectionId)}
        />
      ) : connectEnterprise && connectRow && connectEnterprise.resourceId === "mail2000" ? (
        <div className="catalog-alert" data-testid="mail2000-connection-unavailable">
          <span>{botCopy("Account connection settings are not loaded. Try again later.", "帳號連線設定尚未載入，請稍後重試。")}</span>
        </div>
      ) : connectEnterprise && connectRow ? (
        <ConnectCard
          resourceId={connectEnterprise.resourceId}
          resourceDisplayName={connectEnterprise.resourceDisplayName || connectEnterprise.resourceId}
          phase={connectPhase}
          busy={connectBusy}
          message={connectMessage}
          onSelectPath={(path) => void handleSelectPath(path)}
          onCancel={closeConnect}
          onConnectedContinue={closeConnect}
        />
      ) : null}

      <section className="enterprise-capabilities" aria-labelledby="enterprise-capabilities-title">
        <h3 id="enterprise-capabilities-title">{botCopy("Enterprise tools", "企業工具")}</h3>
        {enterpriseGroups.length ? enterpriseGroups.map((group) => (
          <section className="enterprise-resource-group" key={group.resourceId}>
            <h4>{group.title}{catalogByKey.get(group.rows[0]!.key)?.builtinService === "DISCOVERY" ? <span className="capability-builtin">{botCopy("Built in", "平台內建")}</span> : null}</h4>
            {group.rows.map(renderRow)}
          </section>
        )) : <p className="search-empty">{botCopy("No enterprise tools are available.", "目前沒有可顯示的企業工具。")}</p>}
      </section>
      <details className="runtime-capabilities">
        <summary>{botCopy("Runtime capabilities", "Runtime 能力")} <span>{botCopy(`${runtimeRows.length} items`, `${runtimeRows.length} 項`)}</span></summary>
        <p className="capability-panel-note">{botCopy("Execution environment capabilities managed by company policy.", "由公司政策管理的執行環境能力。")}</p>
      {runtimePolicyLoading ? (
        <p style={{ fontSize: "12px", color: "#657571", margin: "0 0 10px" }}>{botCopy("Runtime policy is loading. Runtime capabilities are paused.", "Runtime policy 載入中，能力暫停。")}</p>
      ) : runtimePolicy ? (
        <p style={{ fontSize: "12px", color: "#657571", margin: "0 0 10px" }} data-testid="runtime-policy-source">
          {botCopy("Runtime policy", "Runtime 政策")} · {runtimePolicySourceLabel(runtimePolicy)}{runtimePolicy.policy_revision !== null ? ` · v${runtimePolicy.policy_revision}` : ""}
        </p>
      ) : (
        <div className="catalog-alert" style={{ marginBottom: 10 }} data-testid="runtime-policy-unavailable">
          <span>{runtimePolicyError || botCopy("Runtime policy is not available. Runtime capabilities are paused.", "Runtime policy 尚未取得，Runtime 能力暫停。")}</span>
          {onRetryRuntimePolicy ? <button type="button" className="secondary-button" onClick={onRetryRuntimePolicy}>{botCopy("Retry", "重試")}</button> : null}
        </div>
      )}
        {runtimeRows.map(renderRow)}
      </details>
      {addMessage ? (
        <div className="catalog-alert" style={{ marginTop: 12 }}>
          <span>{addMessage}</span>
        </div>
      ) : null}
    </div>
  )
}
