import type { BotSchedule, BotScheduleRun } from "./bot-schedules"
import { botToolText, type BotToolDefinition, type BotToolExecution, type BotToolResponse } from "./bot-tool-contract"

const scheduleSchema = {
  oneOf: [
    { type: "object", properties: { kind: { const: "once" }, at: { type: "string", maxLength: 64 } }, required: ["kind", "at"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "recurring" }, frequency: { enum: ["daily", "weekly"] }, time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }, timezone: { type: "string", maxLength: 128 }, weekdays: { type: "array", minItems: 1, maxItems: 7, uniqueItems: true, items: { enum: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] } } }, required: ["kind", "frequency", "time", "timezone"], additionalProperties: false },
  ],
}

export const scheduleToolDefinitions: BotToolDefinition[] = [
  { name: "list_schedules", description: "List this Bot's durable schedules and recent scheduled runs. Schedule actions remain scoped to this Bot and its owner.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "create_schedule", description: "Create one durable one-time or recurring schedule. clientRequestId makes retrying the same creation idempotent. The server starts the Bot only after it can re-check current authority.", inputSchema: { type: "object", properties: { clientRequestId: { type: "string", minLength: 1, maxLength: 128 }, prompt: { type: "string", minLength: 1, maxLength: 8000 }, schedule: scheduleSchema }, required: ["clientRequestId", "prompt", "schedule"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "update_schedule", description: "Edit a schedule, or set enabled false to pause and true to resume it. Read the schedule first and include its expectedRevision.", inputSchema: { type: "object", properties: { scheduleId: { type: "string", minLength: 1, maxLength: 128 }, expectedRevision: { type: "integer", minimum: 1 }, prompt: { type: "string", minLength: 1, maxLength: 8000 }, schedule: scheduleSchema, enabled: { type: "boolean" } }, required: ["scheduleId", "expectedRevision"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "delete_schedule", description: "Permanently delete one future schedule. Existing run records remain available for audit. Read it first and include expectedRevision.", inputSchema: { type: "object", properties: { scheduleId: { type: "string", minLength: 1, maxLength: 128 }, expectedRevision: { type: "integer", minimum: 1 } }, required: ["scheduleId", "expectedRevision"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: "list_schedule_runs", description: "Read durable execution records for this Bot, optionally narrowed to one schedule.", inputSchema: { type: "object", properties: { scheduleId: { type: "string", minLength: 1, maxLength: 128 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
]

function argsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BOT_SCHEDULE_ARGUMENTS_INVALID")
  return value as Record<string, unknown>
}

function exact(args: Record<string, unknown>, allowed: string[], required: string[] = []) {
  if (Object.keys(args).some((key) => !allowed.includes(key)) || required.some((key) => !(key in args))) throw new Error("BOT_SCHEDULE_ARGUMENTS_INVALID")
}

function id(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new Error("BOT_SCHEDULE_ARGUMENTS_INVALID")
  return value.trim()
}

function revision(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("BOT_SCHEDULE_ARGUMENTS_INVALID")
  return value as number
}

function scheduleView(schedule: BotSchedule) {
  const { tenantId: _tenantId, ownerSubjectId: _ownerSubjectId, actingClientId: _actingClientId, ...visible } = schedule
  return visible
}

function runView(run: BotScheduleRun) {
  const { tenantId: _tenantId, ownerSubjectId: _ownerSubjectId, actingClientId: _actingClientId, botId: _botId, ...visible } = run
  return visible
}

function schedules(execution: BotToolExecution) {
  const context = execution.context
  if (!context.botSchedules) throw new Error("BOT_SCHEDULES_UNAVAILABLE")
  if (!context.botRegistry.getOwned(execution.botId, execution.principal)) throw new Error("BOT_NOT_FOUND")
  return context.botSchedules
}

export async function executeScheduleTool(name: string, value: unknown, execution: BotToolExecution): Promise<BotToolResponse> {
  const args = argsObject(value)
  const store = schedules(execution)
  if (name === "list_schedules") {
    exact(args, [])
    return botToolText({ schedules: store.list(execution.principal, execution.botId).map(scheduleView), runs: store.listRuns(execution.principal, execution.botId, undefined, 20).map(runView) })
  }
  if (name === "create_schedule") {
    exact(args, ["clientRequestId", "prompt", "schedule"], ["clientRequestId", "prompt", "schedule"])
    const created = store.create(execution.principal, execution.botId, args)
    return botToolText(created.schedule
      ? { schedule: scheduleView(created.schedule), created: created.created }
      : { schedule: null, scheduleId: created.scheduleId, created: false, deleted: true })
  }
  if (name === "update_schedule") {
    exact(args, ["scheduleId", "expectedRevision", "prompt", "schedule", "enabled"], ["scheduleId", "expectedRevision"])
    const { scheduleId, ...update } = args
    const updated = store.update(execution.principal, execution.botId, id(scheduleId), { ...update, expectedRevision: revision(args.expectedRevision) })
    return botToolText({ schedule: scheduleView(updated) })
  }
  if (name === "delete_schedule") {
    exact(args, ["scheduleId", "expectedRevision"], ["scheduleId", "expectedRevision"])
    return botToolText(store.delete(execution.principal, execution.botId, id(args.scheduleId), revision(args.expectedRevision)))
  }
  if (name === "list_schedule_runs") {
    exact(args, ["scheduleId", "limit"])
    const scheduleId = args.scheduleId === undefined ? undefined : id(args.scheduleId)
    const limit = args.limit === undefined ? 50 : Number.isSafeInteger(args.limit) && (args.limit as number) >= 1 && (args.limit as number) <= 100 ? args.limit as number : (() => { throw new Error("BOT_SCHEDULE_ARGUMENTS_INVALID") })()
    return botToolText({ runs: store.listRuns(execution.principal, execution.botId, scheduleId, limit).map(runView) })
  }
  throw new Error("BOT_SCHEDULE_TOOL_NOT_FOUND")
}
