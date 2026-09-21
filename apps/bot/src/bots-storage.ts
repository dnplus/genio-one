import type { ChatMessage } from "../shared/bot-timeline"
import {
  DEFAULT_BLOUB_AVATAR,
  isBloubAvatarValue,
  type BloubAvatarValue,
} from "./avatar/bloub-avatar"

/** Slice A profile fields. `role` is legacy alias of description — do not use as SoT. */
export interface BotProfile {
  name: string
  title: string
  description: string
  antiJobs?: string
  voice?: string
  wake?: "chat" | "routine" | "both" | ""
  avatar: BloubAvatarValue
  modelRoute?: "codex-subscription" | "genio-gateway"
  /** @deprecated legacy mirror of description; prefer title/description */
  role?: string
}

export type RuntimeTier = "none" | "headless" | "desktop"

export interface BotSharePolicy {
  visibility: "PRIVATE" | "SELECTED" | "TEAM" | "ORG"
  discoverable: boolean
  invocable: boolean
  approval: "ALWAYS_ASK" | "POLICY_AUTO_APPROVE"
  audienceIds: string[]
}

export interface BotBinding {
  id?: string
  botId?: string
  resourceId: string
  capabilityId: string
  version: string
  artifactDigest?: string | null
  state: "INSTALLED" | "PENDING" | "DENIED" | "FAILED"
  kind: "SKILL" | "PLUGIN" | "MCP" | "CONNECTION"
  skillId?: string | null
  approvalPolicyRef?: string | null
  reason?: string | null
}

export interface BotInstance {
  id: string
  revision?: number
  botId?: string
  name: string
  /** @deprecated legacy mirror of description — prefer title/description */
  role: string
  title: string
  description: string
  antiJobs?: string
  voice?: string
  wake?: "chat" | "routine" | "both" | ""
  tenantId?: string
  ownerSubjectId?: string
  agentSubjectId?: string
  avatar: BloubAvatarValue
  workspacePath: string
  skills: string[]
  allowedTools?: string[]
  modelRoute?: "codex-subscription" | "genio-gateway"
  defaultRuntimeTier?: RuntimeTier
  sharePolicy?: BotSharePolicy
  sourceResourceId?: string | null
  sourceVersion?: string | null
  sourceDigest?: string | null
  bindings?: BotBinding[]
  createdAt: number
  updatedAt?: number
}

export interface BotThread {
  id: string
  title: string
  updatedAt: number
  messageCount: number
}

export const DEFAULT_BOT_ID = "bot-default"

export const AVAILABLE_SKILLS = [
  { id: "servicenow-csm", name: "ServiceNow CSM 助手", description: "查詢客戶工單、讀取案件歷程與狀態更新" },
  { id: "code-review", name: "代碼審查與測試", description: "執行靜態代碼檢查、單元測試驗證與 PR 變更審查" },
  { id: "log-investigation", name: "日誌與根因分析", description: "分析分散式追蹤日誌、定位服務異常與異常堆疊" },
  { id: "doc-search", name: "企業文檔與知識庫", description: "檢索內部產品規格書、標準作業程序 (SOP) 與架構設計" },
]

export function codexThreadStorageKey(botId: string, threadId: string) {
  return `genio.bot.thread_id.${botId}.${threadId}`
}

function parseAllowedTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  if (!value.every((item) => typeof item === "string")) return undefined
  return value
}

function parseBot(value: unknown): BotInstance | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== "string" || typeof record.name !== "string") {
    return null
  }
  const description = typeof record.description === "string" ? record.description
    : typeof record.role === "string" ? record.role
    : typeof record.title === "string" ? record.title
    : ""
  if (!description) return null
  const title = typeof record.title === "string" ? record.title : description
  const role = typeof record.role === "string" ? record.role : description
  return {
    id: record.id,
    botId: typeof record.botId === "string" ? record.botId : record.id,
    name: record.name,
    role,
    title,
    description,
    tenantId: typeof record.tenantId === "string" ? record.tenantId : undefined,
    ownerSubjectId: typeof record.ownerSubjectId === "string" ? record.ownerSubjectId : undefined,
    agentSubjectId: typeof record.agentSubjectId === "string" ? record.agentSubjectId : undefined,
    avatar: isBloubAvatarValue(record.avatar) ? record.avatar : DEFAULT_BLOUB_AVATAR,
    workspacePath: typeof record.workspacePath === "string" ? record.workspacePath : `/workspaces/${record.id}`,
    skills: Array.isArray(record.skills) ? record.skills.filter((item): item is string => typeof item === "string") : [],
    allowedTools: parseAllowedTools(record.allowedTools),
    modelRoute: record.modelRoute === "genio-gateway" ? "genio-gateway" : "codex-subscription",
    defaultRuntimeTier: record.defaultRuntimeTier === "headless" || record.defaultRuntimeTier === "desktop" ? record.defaultRuntimeTier : "none",
    sharePolicy: record.sharePolicy && typeof record.sharePolicy === "object" ? record.sharePolicy as BotSharePolicy : undefined,
    sourceResourceId: typeof record.sourceResourceId === "string" ? record.sourceResourceId : null,
    sourceVersion: typeof record.sourceVersion === "string" ? record.sourceVersion : null,
    sourceDigest: typeof record.sourceDigest === "string" ? record.sourceDigest : null,
    bindings: Array.isArray(record.bindings) ? record.bindings as BotBinding[] : [],
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : undefined,
  }
}

/**
 * DEMO FALLBACK ONLY — browser localStorage is NOT production roster SoT.
 * Production roster must come from server BotProfile registry (GET /api/bots).
 * Pass `demo=true` for ?demo=1 UI. Use `readLegacyLocalBots()` only for one-shot migrate.
 */
export function readBots(demo = false): BotInstance[] {
  if (!demo) return []
  return readLegacyLocalBots(true)
}

/** One-shot migration helper. Not production SoT. */
export function readLegacyLocalBots(includeDemoSeed = false): BotInstance[] {
  const stored = localStorage.getItem("genio.bots.list")
  if (stored) {
    try {
      const list = JSON.parse(stored)
      if (Array.isArray(list)) {
        const bots = list.map(parseBot).filter((bot): bot is BotInstance => bot !== null)
        if (bots.length > 0) return bots
      }
    } catch {}
  }
  const legacy = localStorage.getItem("genio.bot.profile")
  if (legacy) {
    try {
      const val = JSON.parse(legacy)
      if (val.name && val.role) {
        const migrated: BotInstance = {
          id: DEFAULT_BOT_ID,
          name: val.name,
          title: typeof val.title === "string" ? val.title : val.role,
          description: typeof val.description === "string" ? val.description : val.role,
          role: val.role,
          avatar: isBloubAvatarValue(val.avatar) ? val.avatar : DEFAULT_BLOUB_AVATAR,
          workspacePath: `/workspaces/${DEFAULT_BOT_ID}`,
          skills: ["servicenow-csm"],
          createdAt: Date.now(),
        }
        localStorage.setItem("genio.bots.list", JSON.stringify([migrated]))
        return [migrated]
      }
    } catch {}
  }
  if (includeDemoSeed) {
    return [
      {
        id: "bot-default",
        name: "HH 運營夥伴",
        title: "企業營運夥伴",
        description: "處理日常工作與資源協調",
        role: "處理日常工作與資源協調",
        avatar: DEFAULT_BLOUB_AVATAR,
        workspacePath: "/workspaces/bot-default",
        skills: ["servicenow-csm", "doc-search"],
        sharePolicy: { visibility: "ORG", discoverable: true, invocable: true, approval: "ALWAYS_ASK", audienceIds: [] },
        createdAt: Date.now() - 100000,
      },
      {
        id: "bot-nova",
        name: "Nova 客服專家",
        title: "ServiceNow CSM 客服專家",
        description: "ServiceNow CSM 客服工單專家",
        role: "ServiceNow CSM 客服工單專家",
        avatar: { shape: "galet", expression: "attentif", color: DEFAULT_BLOUB_AVATAR.color },
        workspacePath: "/workspaces/bot-nova",
        skills: ["servicenow-csm"],
        sharePolicy: { visibility: "ORG", discoverable: true, invocable: true, approval: "ALWAYS_ASK", audienceIds: [] },
        createdAt: Date.now() - 50000,
      },
    ]
  }
  return []
}

/** DEMO FALLBACK ONLY — do not use as production roster SoT. */
export function saveBots(bots: BotInstance[]) {
  localStorage.setItem("genio.bots.list", JSON.stringify(bots))
}

export function readActiveBotId(): string | null {
  return localStorage.getItem("genio.bots.active_id")
}

export function saveActiveBotId(id: string) {
  localStorage.setItem("genio.bots.active_id", id)
}

export function readBotThreads(botId: string): BotThread[] {
  const stored = localStorage.getItem(`genio.bot.threads.${botId}`)
  if (stored) {
    try {
      const list = JSON.parse(stored)
      if (Array.isArray(list) && list.length > 0) return list
    } catch {}
  }
  return [
    {
      id: `thread-${botId}-default`,
      title: "日常對話工作階段",
      updatedAt: Date.now(),
      messageCount: 1,
    },
  ]
}

export function saveBotThreads(botId: string, threads: BotThread[]) {
  localStorage.setItem(`genio.bot.threads.${botId}`, JSON.stringify(threads))
}

export type { ChatMessage } from "../shared/bot-timeline"

export function readBotMessages(botId: string, threadId: string): ChatMessage[] {
  const stored = localStorage.getItem(`genio.bot.messages.${botId}.${threadId}`)
  if (stored) {
    try {
      const list = JSON.parse(stored)
      if (Array.isArray(list)) {
        return list.filter((message: ChatMessage) => {
          if (message?.role !== "assistant" || typeof message.text !== "string") return true
          return !(/^###\s+bot-/.test(message.text) && /Handoff delivered/i.test(message.text))
        })
      }
    } catch {}
  }
  return []
}

export function saveBotMessages(botId: string, threadId: string, messages: ChatMessage[]) {
  const meaningful = messages.filter((message) => message.id !== "welcome")
  if (meaningful.length === 0) {
    const existing = readBotMessages(botId, threadId)
    if (existing.some((message) => message.id !== "welcome")) return
  }
  localStorage.setItem(`genio.bot.messages.${botId}.${threadId}`, JSON.stringify(messages))
}

export function readSavedModel(botId?: string): string | null {
  if (botId) {
    const perBot = localStorage.getItem(`genio.bot.model.${botId}`)?.trim()
    if (perBot) return perBot
  }
  return localStorage.getItem("genio.bot.selected_model")?.trim() || null
}

export function saveSavedModel(model: string, botId?: string) {
  localStorage.setItem("genio.bot.selected_model", model)
  if (botId) {
    localStorage.setItem(`genio.bot.model.${botId}`, model)
  }
}

export function readInputHistory(botId: string): string[] {
  const stored = localStorage.getItem(`genio.bot.input_history.${botId}`)
  if (stored) {
    try {
      const list = JSON.parse(stored)
      if (Array.isArray(list)) return list.filter((item): item is string => typeof item === "string")
    } catch {}
  }
  return []
}

export function saveInputHistory(botId: string, history: string[]): void {
  try {
    localStorage.setItem(`genio.bot.input_history.${botId}`, JSON.stringify(history.slice(-50)))
  } catch {}
}

export function clearBotLocalCache(botId: string) {
  const prefixes = [
    `genio.bot.threads.${botId}`,
    `genio.bot.messages.${botId}.`,
    `genio.bot.model.${botId}`,
    `genio.bot.input_history.${botId}`,
  ]
  for (const key of Object.keys(localStorage)) {
    if (prefixes.some((prefix) => key === prefix || key.startsWith(prefix))) localStorage.removeItem(key)
  }
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith(`genio.bot.thread_id.${botId}.`)) sessionStorage.removeItem(key)
  }
}

export function readMessageFeedbacks(): Record<string, "positive" | "negative"> {
  const stored = localStorage.getItem("genio.bot.message_feedbacks")
  if (stored) {
    try {
      const parsed = JSON.parse(stored)
      if (parsed && typeof parsed === "object") return parsed
    } catch {}
  }
  return {}
}

export function saveMessageFeedbacks(feedbacks: Record<string, "positive" | "negative">): void {
  try {
    localStorage.setItem("genio.bot.message_feedbacks", JSON.stringify(feedbacks))
  } catch {}
}

export function readUnreadBotIds(): string[] {
  const stored = localStorage.getItem("genio.bot.unread_bot_ids")
  if (stored) {
    try {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === "string")
    } catch {}
  }
  return []
}

export function saveUnreadBotIds(ids: string[]): void {
  try {
    localStorage.setItem("genio.bot.unread_bot_ids", JSON.stringify(ids))
  } catch {}
}
