/** Slice D: Bot Designer draft → private BotProfile. No routines / plugins. */

export type BotWakeMode = "chat" | "routine" | "both"
export type BotModelRoute = "codex-subscription" | "genio-gateway"

export interface BotDesignerDraft {
  name: string
  /** One job — stored as BotProfile.title */
  oneJob: string
  antiJobs: string
  voice: string
  wake: BotWakeMode
  modelRoute?: BotModelRoute
  avatar?: unknown
}

export type NormalizedBotDesignerDraft = Omit<BotDesignerDraft, "modelRoute"> & { modelRoute: BotModelRoute }

export interface BotDesignerProfileFields {
  oneJob: string
  antiJobs: string
  voice: string
  wake: BotWakeMode
}

const WAKE_LABELS: Record<BotWakeMode, string> = {
  chat: "只在聊天中工作；沒事保持安靜",
  routine: "由 routine 喚醒；沒事保持安靜（本 slice 不啟用 routine）",
  both: "聊天或 routine 皆可喚醒；沒事保持安靜（本 slice 不啟用 routine）",
}

export function isBotWakeMode(value: unknown): value is BotWakeMode {
  return value === "chat" || value === "routine" || value === "both"
}

function normalizeModelRoute(value: unknown): BotModelRoute {
  if (value === undefined || value === "codex-subscription") return "codex-subscription"
  if (value === "genio-gateway") return "genio-gateway"
  throw new Error("DESIGNER_MODEL_ROUTE_INVALID")
}

export function wakeLabel(wake: BotWakeMode): string {
  return WAKE_LABELS[wake]
}

/** Compose durable description from the four designer concepts. */
export function composeDesignerDescription(fields: BotDesignerProfileFields): string {
  return [
    "## One job",
    fields.oneJob.trim(),
    "",
    "## Anti-jobs",
    fields.antiJobs.trim(),
    "",
    "## Voice",
    fields.voice.trim(),
    "",
    "## Wake",
    wakeLabel(fields.wake),
  ].join("\n")
}

function section(body: string, heading: string): string {
  const re = new RegExp(`##\\s*${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i")
  const match = body.match(re)
  return match?.[1]?.trim() ?? ""
}

export function parseDesignerDescription(description: string): BotDesignerProfileFields | null {
  const oneJob = section(description, "One job")
  const antiJobs = section(description, "Anti-jobs")
  const voice = section(description, "Voice")
  const wakeRaw = section(description, "Wake")
  if (!oneJob || !antiJobs || !voice || !wakeRaw) return null
  let wake: BotWakeMode = "chat"
  if (wakeRaw.includes("routine") && wakeRaw.includes("聊天")) wake = "both"
  else if (wakeRaw.includes("routine")) wake = "routine"
  else wake = "chat"
  return { oneJob, antiJobs, voice, wake }
}

export function normalizeDesignerDraft(input: BotDesignerDraft): NormalizedBotDesignerDraft {
  const name = input.name.trim()
  const oneJob = input.oneJob.trim()
  const antiJobs = input.antiJobs.trim()
  const voice = input.voice.trim()
  const wake = isBotWakeMode(input.wake) ? input.wake : "chat"
  const modelRoute = normalizeModelRoute(input.modelRoute)
  if (!name) throw new Error("DESIGNER_NAME_REQUIRED")
  if (!oneJob) throw new Error("DESIGNER_ONE_JOB_REQUIRED")
  if (!antiJobs) throw new Error("DESIGNER_ANTI_JOBS_REQUIRED")
  if (!voice) throw new Error("DESIGNER_VOICE_REQUIRED")
  return { name, oneJob, antiJobs, voice, wake, modelRoute, avatar: input.avatar }
}

export function designerCreatePayload(draft: BotDesignerDraft) {
  const normalized = normalizeDesignerDraft(draft)
  const fields: BotDesignerProfileFields = {
    oneJob: normalized.oneJob,
    antiJobs: normalized.antiJobs,
    voice: normalized.voice,
    wake: normalized.wake,
  }
  return {
    name: normalized.name,
    title: normalized.oneJob,
    description: composeDesignerDescription(fields),
    antiJobs: normalized.antiJobs,
    voice: normalized.voice,
    wake: normalized.wake,
    avatar: normalized.avatar,
    /** Designer must not secretly install skills/plugins */
    skills: [] as string[],
    defaultRuntimeTier: "none" as const,
    modelRoute: normalized.modelRoute,
  }
}

export function assertDesignerReadBack(
  draft: BotDesignerDraft,
  live: {
    name: string
    title: string
    description: string
    antiJobs?: string | null
    voice?: string | null
    wake?: string | null
    modelRoute?: string | null
    visibility?: string | null
  },
) {
  const expected = designerCreatePayload(draft)
  if (live.name !== expected.name) throw new Error(`read-back name mismatch: ${live.name}`)
  if (live.title !== expected.title) throw new Error(`read-back title/oneJob mismatch: ${live.title}`)
  if (live.description !== expected.description) throw new Error("read-back description mismatch")
  if ((live.antiJobs ?? "") !== expected.antiJobs) throw new Error(`read-back antiJobs mismatch: ${live.antiJobs}`)
  if ((live.voice ?? "") !== expected.voice) throw new Error(`read-back voice mismatch: ${live.voice}`)
  if ((live.wake ?? "") !== expected.wake) throw new Error(`read-back wake mismatch: ${live.wake}`)
  if ((live.modelRoute ?? "") !== expected.modelRoute) throw new Error(`read-back model route mismatch: ${live.modelRoute}`)
  if (live.visibility != null && live.visibility !== "PRIVATE") {
    throw new Error(`read-back visibility must be PRIVATE: ${live.visibility}`)
  }
}
