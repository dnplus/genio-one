import type { GenioCatalog, GenioIdentity } from "../../lib/genio-one"
import { readBotMessages, readBotThreads, type BotInstance } from "../../bots-storage"
import { isEnglishBotLocale } from "../../lib/ui-copy"

export const roles = ["研究助理", "營運夥伴", "專案執行者"]

export function demoIdentity(): GenioIdentity {
  return {
    tenant_id: "tenant-acme",
    subject_id: "demo-user",
    display_name: "林小華",
    email: "xiaohua.lin@acme.example.com",
    acting_client_id: "genio-one-bot",
    role: "USER",
    organization_ids: ["acme"],
    scopes: ["genioone-invocation"],
  }
}

export function demoCatalog(): GenioCatalog {
  return {
    tenant_id: "tenant-acme",
    catalog_revision: "rev-2026-09",
    subject_id: "demo-user",
    subject_display_name: "林小華",
    capabilities: [
      {
        resource_id: "servicenow-csm",
        resource_display_name: "ServiceNow CSM",
        capability_id: "mcp-tool-b4d8a1398c5aee3cb2839945d26145e6",
        capability_display_name: "客戶工單查詢 (Read Case)",
        access: "AUTO_GRANT",
        hub_status: "AVAILABLE",
        connection_status: "READY",
        resource_kind: "mcp",
      },
      {
        resource_id: "jira",
        resource_display_name: "Jira Issue",
        capability_id: "mcp-tool-jira-read",
        capability_display_name: "Issue 讀取 (Read Issue)",
        access: "REQUEST",
        hub_status: "AVAILABLE",
        connection_status: "READY",
        resource_kind: "mcp",
      },
      {
        resource_id: "secret-vault",
        resource_display_name: "企業機密庫 (Vault)",
        capability_id: "mcp-tool-vault-read",
        capability_display_name: "機密憑證檢索",
        access: "REQUEST",
        hub_status: "REQUEST_ACCESS",
        connection_status: "UNAVAILABLE",
        resource_kind: "mcp",
      },
    ],
  }
}

export function isUuid(str?: string | null): boolean {
  if (!str) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim())
}

export function getSubjectDisplayName(identity: GenioIdentity | null, catalog?: GenioCatalog | null): string {
  if (identity?.display_name?.trim() && !isUuid(identity.display_name)) {
    return identity.display_name.trim()
  }
  if (catalog?.subject_display_name?.trim() && !isUuid(catalog.subject_display_name)) {
    return catalog.subject_display_name.trim()
  }
  if (identity?.email?.trim()) {
    const prefix = identity.email.trim().split("@")[0]
    if (prefix === "admin" || prefix.includes("admin")) return "平台管理員 (Admin)"
    return prefix
  }
  const id = identity?.subject_id?.trim() || ""
  if (!id || id === "demo-user") return "林小華"
  if (id === "person-platform-admin" || id === "admin") return "平台管理員"
  if (id === "person-organization-admin") return "組織管理員"
  if (id.startsWith("person-")) {
    return id.replace(/^person-/, "").split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
  }
  if (isUuid(id)) {
    if (identity?.role === "TENANT_ADMINISTRATOR") return "平台管理員 (Admin)"
    if (identity?.role === "ORGANIZATION_ADMINISTRATOR") return "組織管理員"
    return "企業成員"
  }
  return id || "企業成員"
}

export function formatMessageTime(timestamp?: number): string {
  if (!timestamp) return ""
  const date = new Date(timestamp)
  return date.toLocaleTimeString(isEnglishBotLocale() ? "en-US" : "zh-TW", { hour: "numeric", minute: "2-digit", hour12: true })
}

export function formatDividerTime(timestamp?: number): string {
  if (!timestamp) return ""
  const date = new Date(timestamp)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday = date.toDateString() === yesterday.toDateString()

  const timeStr = date.toLocaleTimeString(isEnglishBotLocale() ? "en-US" : "zh-TW", { hour: "numeric", minute: "2-digit", hour12: true })
  if (isEnglishBotLocale()) {
    if (isToday) return `Today ${timeStr}`
    if (isYesterday) return `Yesterday ${timeStr}`
    return `${date.getMonth() + 1}/${date.getDate()} ${timeStr}`
  }
  if (isToday) return `今天 ${timeStr}`
  if (isYesterday) return `昨天 ${timeStr}`
  return `${date.getMonth() + 1}/${date.getDate()} ${timeStr}`
}

export function formatSidebarTime(timestamp?: number): string {
  if (!timestamp) return ""
  const date = new Date(timestamp)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  if (isToday) {
    return date.toLocaleTimeString(isEnglishBotLocale() ? "en-US" : "zh-TW", { hour: "numeric", minute: "2-digit", hour12: true })
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) {
    return isEnglishBotLocale() ? "Yesterday" : "昨天"
  }
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (diffDays < 7) {
    if (isEnglishBotLocale()) return date.toLocaleDateString("en-US", { weekday: "short" })
    const days = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"]
    return days[date.getDay()]!
  }
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export function getBotSummary(bot: BotInstance): { preview: string; timestamp?: number } {
  const threads = readBotThreads(bot.id)
  const initial = threads[0]?.id || `thread-${bot.id}-default`
  const msgs = readBotMessages(bot.id, initial)
  if (msgs.length > 0) {
    const last = msgs[msgs.length - 1]!
    return {
      preview: last.text.slice(0, 32),
      timestamp: last.createdAt || threads[0]?.updatedAt || bot.createdAt,
    }
  }
  return {
    preview: bot.title || bot.description || bot.role,
    timestamp: threads[0]?.updatedAt || bot.createdAt,
  }
}
