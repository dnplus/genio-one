import { browserObserver } from "./browser-telemetry"

export interface BotSchedule {
  id: string
  botId: string
  prompt: string
  schedule: OnceSchedule | RecurringSchedule
  enabled: boolean
  revision: number
  nextRunAt: number | string | null
  createdAt: number | string
  updatedAt: number | string
}

export interface OnceSchedule {
  kind: "once"
  at: string
}

export interface RecurringSchedule {
  kind: "recurring"
  frequency: "daily" | "weekly"
  time: string
  timezone: string
  weekdays?: Array<"MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU">
}

export interface BotScheduleRun {
  id: string
  scheduleId: string
  slotAt: number | string
  clientUserMessageId: string | null
  state: string
  attempts: number
  threadId: string | null
  turnId: string | null
  error: string | null
  createdAt: number | string
  updatedAt: number | string
}

export interface OwnedSkillFile {
  path: string
  content: string
}

export interface OwnedSkill {
  skillName: string
  revision: number
  deleted?: boolean
  files: OwnedSkillFile[]
  createdAt?: number
  updatedAt?: number
}

export interface OwnedSkillRevision {
  revision: number
  updatedAt: number
  deleted: boolean
}

export class BotDefaultToolError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>
  isError?: boolean
  code?: string
  error?: string
}

function defaultToolPath(botId: string, toolName: string) {
  return `/api/bots/${encodeURIComponent(botId)}/default-tools/${encodeURIComponent(toolName)}`
}

function errorCode(value: unknown, fallback: string) {
  if (!value || typeof value !== "object") return fallback
  const record = value as Record<string, unknown>
  const text = Array.isArray(record.content)
    ? record.content.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "text") as Record<string, unknown> | undefined
    : undefined
  const textValue = typeof text?.text === "string" ? text.text : ""
  let nested: unknown = null
  try { nested = textValue ? JSON.parse(textValue) : null } catch {}
  const nestedRecord = nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : null
  return typeof record.code === "string"
    ? record.code
    : typeof record.error === "string"
      ? record.error
      : typeof nestedRecord?.code === "string"
        ? nestedRecord.code
        : typeof nestedRecord?.error === "string"
          ? nestedRecord.error
      : typeof text?.text === "string"
        ? text.text
      : fallback
}

async function callDefaultTool<T>(token: string, botId: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await browserObserver.fetch(defaultToolPath(botId, toolName), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
    signal,
  })
  const body = await response.json().catch(() => null) as McpToolResult | null
  if (!response.ok) throw new BotDefaultToolError(response.status === 401 ? "BOT_AUTH_REQUIRED" : errorCode(body, `BOT_DEFAULT_TOOL_${response.status}`))
  if (!body || body.isError) throw new BotDefaultToolError(errorCode(body, "BOT_DEFAULT_TOOL_FAILED"))
  const text = body.content?.find((entry) => entry.type === "text")?.text
  if (!text) throw new BotDefaultToolError("BOT_DEFAULT_TOOL_RESPONSE_INVALID")
  try {
    return JSON.parse(text) as T
  } catch {
    throw new BotDefaultToolError("BOT_DEFAULT_TOOL_RESPONSE_INVALID")
  }
}

export function listSchedules(token: string, botId: string, signal?: AbortSignal) {
  return callDefaultTool<{ schedules: BotSchedule[]; runs: BotScheduleRun[] }>(token, botId, "list_schedules", {}, signal)
}

export function createSchedule(token: string, botId: string, input: {
  clientRequestId: string
  prompt: string
  schedule: OnceSchedule | RecurringSchedule
}) {
  return callDefaultTool<{ schedule: BotSchedule | null; scheduleId?: string; created: boolean; deleted?: boolean }>(token, botId, "create_schedule", input)
}

export function updateSchedule(token: string, botId: string, input: {
  scheduleId: string
  expectedRevision: number
  prompt?: string
  schedule?: OnceSchedule | RecurringSchedule
  enabled?: boolean
}) {
  return callDefaultTool<{ schedule: BotSchedule }>(token, botId, "update_schedule", input)
}

export function deleteSchedule(token: string, botId: string, input: { scheduleId: string; expectedRevision: number }) {
  return callDefaultTool<{ scheduleId: string; deleted: boolean }>(token, botId, "delete_schedule", input)
}

export function listScheduleRuns(token: string, botId: string, input: { scheduleId?: string; limit?: number } = {}) {
  return callDefaultTool<{ runs: BotScheduleRun[] }>(token, botId, "list_schedule_runs", input)
}

export function listOwnedSkills(token: string, botId: string, signal?: AbortSignal) {
  return callDefaultTool<{ skills: Array<Pick<OwnedSkill, "skillName" | "revision"> & { updatedAt: number }> }>(token, botId, "list_owned_skills", {}, signal)
}

export function readOwnedSkill(token: string, botId: string, skillName: string, signal?: AbortSignal) {
  return callDefaultTool<{ skill: OwnedSkill; revisions?: OwnedSkillRevision[] }>(token, botId, "read_owned_skill", { skillName }, signal)
}

export function writeOwnedSkill(token: string, botId: string, input: { skillName: string; expectedRevision: number; files: Record<string, string> }) {
  return callDefaultTool<{ skill: OwnedSkill; pendingApply: boolean; applyState: string }>(token, botId, "write_owned_skill", input)
}

export function revertOwnedSkill(token: string, botId: string, input: { skillName: string; revision: number; expectedRevision: number }) {
  return callDefaultTool<{ skill: OwnedSkill; pendingApply: boolean; applyState: string }>(token, botId, "revert_owned_skill", input)
}
