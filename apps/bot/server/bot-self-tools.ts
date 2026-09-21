import { ensureAgentSubject } from "./agent-subject"
import { botToolText, type BotToolDefinition, type BotToolExecution, type BotToolResponse } from "./bot-tool-contract"
import { resolveBotUsageContext } from "./usage-context"

const profileProperties = {
  expectedRevision: { type: "integer", minimum: 1 },
  name: { type: "string", minLength: 1, maxLength: 120 },
  title: { type: "string", minLength: 1, maxLength: 160 },
  description: { type: "string", minLength: 1, maxLength: 4000 },
  antiJobs: { type: "string", maxLength: 2000 },
  voice: { type: "string", maxLength: 2000 },
  restoreRevision: { type: "integer", minimum: 1 },
}

export const selfToolDefinitions: BotToolDefinition[] = [
  {
    name: "read_self",
    description: "Read this Bot's owner-bound editable profile and its saved revisions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "update_self",
    description: "Update this Bot's name, title, description, anti-jobs, or voice using the revision returned by read_self. restoreRevision creates a new revision from a previous saved profile.",
    inputSchema: { type: "object", properties: profileProperties, required: ["expectedRevision"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "create_bot",
    description: "Create a new private Bot for the same owner and tenant. The request is durable and idempotent by clientRequestId; it does not copy schedules, skills, secrets, identity, or history.",
    inputSchema: {
      type: "object",
      properties: {
        clientRequestId: { type: "string", minLength: 1, maxLength: 128 },
        name: { type: "string", minLength: 1, maxLength: 120 },
        title: { type: "string", minLength: 1, maxLength: 160 },
        description: { type: "string", minLength: 1, maxLength: 4000 },
        antiJobs: { type: "string", maxLength: 2000 },
        voice: { type: "string", maxLength: 2000 },
        useCaseId: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["clientRequestId", "name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_owned_skills",
    description: "List this Bot's private owned Skills and their current revisions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_owned_skill",
    description: "Read one private owned Skill and its immutable revision history. A deleted result exposes its tombstone revision so the owner can recreate it with write_owned_skill.",
    inputSchema: { type: "object", properties: { skillName: { type: "string", minLength: 1, maxLength: 64 } }, required: ["skillName"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_owned_skill",
    description: "Create or revise one private owned Skill. Files must contain SKILL.md and may contain files under scripts/ or references/.",
    inputSchema: {
      type: "object",
      properties: {
        skillName: { type: "string", minLength: 1, maxLength: 64 },
        expectedRevision: { type: "integer", minimum: 0 },
        files: { type: "object", minProperties: 1, maxProperties: 32, additionalProperties: { type: "string", maxLength: 65536 } },
      },
      required: ["skillName", "expectedRevision", "files"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "revert_owned_skill",
    description: "Create a new current revision by restoring a prior private owned Skill revision.",
    inputSchema: {
      type: "object",
      properties: { skillName: { type: "string", minLength: 1, maxLength: 64 }, revision: { type: "integer", minimum: 1 }, expectedRevision: { type: "integer", minimum: 1 } },
      required: ["skillName", "revision", "expectedRevision"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "delete_owned_skill",
    description: "Tombstone one private owned Skill using its current revision. Recreating it requires the tombstone revision and creates a later revision.",
    inputSchema: {
      type: "object",
      properties: { skillName: { type: "string", minLength: 1, maxLength: 64 }, expectedRevision: { type: "integer", minimum: 1 } },
      required: ["skillName", "expectedRevision"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
]

function record(value: unknown, code = "BOT_TOOL_ARGUMENTS_INVALID") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code)
  return value as Record<string, unknown>
}

function only(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("BOT_TOOL_ARGUMENTS_INVALID")
}

function text(value: unknown, field: string, maximum: number, required = false) {
  if (value === undefined && !required) return undefined
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`BOT_${field.toUpperCase()}_INVALID`)
  return value.trim()
}

function revision(value: unknown, field: string, minimum = 1) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`BOT_${field.toUpperCase()}_INVALID`)
  return Number(value)
}

function pending(value: unknown) {
  return { ...record(value), pendingApply: true, applyState: "PENDING_RUNTIME_REFRESH" }
}

function errorResponse(error: unknown): BotToolResponse {
  return { content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : "BOT_TOOL_FAILED" }) }], isError: true }
}

function publicBot(bot: { id: string; name: string; title: string; description: string; antiJobs: string; voice: string; revision: number }) {
  return { id: bot.id, name: bot.name, title: bot.title, description: bot.description, antiJobs: bot.antiJobs, voice: bot.voice, revision: bot.revision }
}

async function createBot(args: Record<string, unknown>, execution: BotToolExecution) {
  only(args, ["clientRequestId", "name", "title", "description", "antiJobs", "voice", "useCaseId"])
  const clientRequestId = text(args.clientRequestId, "client_request_id", 128, true)!
  const name = text(args.name, "name", 120, true)!
  const title = text(args.title, "title", 160)
  const description = text(args.description, "description", 4000)
  const antiJobs = args.antiJobs === undefined ? undefined : typeof args.antiJobs === "string" && args.antiJobs.length <= 2000 ? args.antiJobs.trim() : (() => { throw new Error("BOT_ANTI_JOBS_INVALID") })()
  const voice = args.voice === undefined ? undefined : typeof args.voice === "string" && args.voice.length <= 2000 ? args.voice.trim() : (() => { throw new Error("BOT_VOICE_INVALID") })()
  const useCaseId = text(args.useCaseId, "use_case_id", 128)
  const source = execution.context.botRegistry.getOwned(execution.botId, execution.principal)
  if (!source) throw new Error("BOT_NOT_FOUND")
  if (source.useCaseId && useCaseId && useCaseId !== source.useCaseId) throw new Error("BOT_USE_CASE_CONTEXT_CONFLICT")
  const usageContext = await resolveBotUsageContext({ principal: execution.principal, accessToken: execution.accessToken, useCaseId: source.useCaseId ?? useCaseId })
  if (source.modelRoute === "genio-gateway" && !usageContext && Array.isArray(execution.principal.organization_ids) && execution.principal.organization_ids.length > 0) throw new Error("USE_CASE_REQUIRED")
  const begun = execution.context.botRegistry.beginSelfBotCreate(execution.principal, clientRequestId, {
    sourceBotId: source.id,
    name,
    title: title ?? null,
    description: description ?? null,
    antiJobs: antiJobs ?? null,
    voice: voice ?? null,
    modelRoute: source.modelRoute,
    ownerOrganizationId: usageContext?.consumerOrganizationId ?? null,
    useCaseId: usageContext?.useCaseId ?? null,
  })
  if (begun.bot) return pending({ bot: publicBot(begun.bot), created: false })
  if (begun.state === "DELETED") return { created: false, deleted: true, applyState: "DELETED" }
  const agent = await ensureAgentSubject({ principal: execution.principal, accessToken: execution.accessToken, displayName: name, clientRequestId })
  const completed = execution.context.botRegistry.completeSelfBotCreate(execution.principal, clientRequestId, {
    name,
    title,
    description,
    antiJobs,
    voice,
    skills: [],
    modelRoute: source.modelRoute,
    defaultRuntimeTier: "none",
    agentSubjectId: agent.subjectId,
    ownerOrganizationId: usageContext?.consumerOrganizationId ?? null,
    useCaseId: usageContext?.useCaseId ?? null,
  })
  return pending({ bot: publicBot(completed.bot), created: completed.created })
}

export async function executeSelfTool(name: string, args: unknown, execution: BotToolExecution): Promise<BotToolResponse> {
  try {
    const input = record(args)
    const registry = execution.context.botRegistry
    if (name === "read_self") {
      only(input, [])
      return botToolText(registry.readSelf(execution.botId, execution.principal))
    }
    if (name === "update_self") {
      only(input, ["expectedRevision", "name", "title", "description", "antiJobs", "voice", "restoreRevision"])
      const expectedRevision = revision(input.expectedRevision, "expected_revision")
      const restoreRevision = input.restoreRevision === undefined ? undefined : revision(input.restoreRevision, "restore_revision")
      if (restoreRevision === undefined && !["name", "title", "description", "antiJobs", "voice"].some((key) => input[key] !== undefined)) throw new Error("BOT_PROFILE_UPDATE_EMPTY")
      const result = registry.updateSelf(execution.botId, execution.principal, {
        expectedRevision,
        name: text(input.name, "name", 120),
        title: text(input.title, "title", 160),
        description: text(input.description, "description", 4000),
        antiJobs: input.antiJobs === undefined ? undefined : typeof input.antiJobs === "string" && input.antiJobs.length <= 2000 ? input.antiJobs.trim() : (() => { throw new Error("BOT_ANTI_JOBS_INVALID") })(),
        voice: input.voice === undefined ? undefined : typeof input.voice === "string" && input.voice.length <= 2000 ? input.voice.trim() : (() => { throw new Error("BOT_VOICE_INVALID") })(),
        restoreRevision,
      })
      return botToolText(pending(result))
    }
    if (name === "create_bot") return botToolText(await createBot(input, execution))
    if (name === "list_owned_skills") {
      only(input, [])
      return botToolText({ skills: registry.ownedSkills.list(execution.principal, execution.botId) })
    }
    if (name === "read_owned_skill") {
      only(input, ["skillName"])
      const skill = registry.ownedSkills.read(execution.principal, execution.botId, input.skillName)
      return botToolText({ skill, revisions: registry.ownedSkills.revisions(execution.principal, execution.botId, input.skillName) })
    }
    if (name === "write_owned_skill") {
      only(input, ["skillName", "expectedRevision", "files"])
      const skill = registry.ownedSkills.write(execution.principal, execution.botId, { skillName: input.skillName, expectedRevision: input.expectedRevision, files: input.files })
      return botToolText(pending({ skill }))
    }
    if (name === "revert_owned_skill") {
      only(input, ["skillName", "revision", "expectedRevision"])
      const skill = registry.ownedSkills.revert(execution.principal, execution.botId, { skillName: input.skillName, revision: input.revision, expectedRevision: input.expectedRevision })
      return botToolText(pending({ skill }))
    }
    if (name === "delete_owned_skill") {
      only(input, ["skillName", "expectedRevision"])
      return botToolText(pending(registry.ownedSkills.delete(execution.principal, execution.botId, { skillName: input.skillName, expectedRevision: input.expectedRevision })))
    }
    throw new Error("BOT_TOOL_NOT_FOUND")
  } catch (error) {
    return errorResponse(error)
  }
}
