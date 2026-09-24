import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { BotQuestions } from "./bot-questions"
import { BotContinuations } from "./bot-continuations"
import { BotMemoryStore } from "./bot-memory"
import { Database } from "bun:sqlite"

import { loadBotPackages, materializeBotPackage, packageCatalog, validateBotPackageManifest, verifyBotPackageArtifact, type ResolvedBotPackage } from "./bot-package-store"
import type { GenioPrincipal } from "./runtime-broker"
import { BotArtifactStore } from "./bot-artifact-store"
import { BotInvocationStore, type BotInvocationRequest } from "./bot-invocation-store"
import { BotHandoffStore, type CreateHandoffInput } from "./bot-handoff"
import { BotGroupStore, type CreateGroupInput } from "./bot-groups"
import { BotTimelineStore } from "./bot-timeline"
import { InteractionHistory } from "./interaction-history"
import { BotOwnedSkills } from "./bot-owned-skills"
import type { BotSidebarSummary } from "../shared/bot-roster"
import type { Turn } from "./generated/v2/Turn"

export { type ArtifactRef, BotArtifactStore } from "./bot-artifact-store"
export { type BotInvocationRequest, type BotInvocationState, BotInvocationStore } from "./bot-invocation-store"
export {
  type BotHandoffAck,
  type BotHandoffEvent,
  type CreateHandoffInput,
  type HandoffKind,
  type HandoffVisibility,
  BotHandoffStore,
  HandoffFanOutError,
  handoffBubbleText,
  projectHandoffMessages,
  resolveHandoffTargets,
  resolveHandoffVisibility,
} from "./bot-handoff"
export { type BotGroupRecord, type CreateGroupInput, BotGroupStore, GroupMemberCountError } from "./bot-groups"

export type RuntimeTier = "none" | "headless" | "desktop"

export interface BotSharePolicy {
  visibility: "PRIVATE" | "SELECTED" | "TEAM" | "ORG"
  discoverable: boolean
  invocable: boolean
  approval: "ALWAYS_ASK" | "POLICY_AUTO_APPROVE"
  audienceIds: string[]
}

export interface BotBinding {
  id: string
  botId: string
  resourceId: string
  capabilityId: string
  version: string
  artifactDigest: string | null
  state: "INSTALLED" | "PENDING" | "DENIED" | "FAILED"
  kind: "SKILL" | "PLUGIN" | "MCP" | "CONNECTION"
  /** Projection refs — not a second auth store */
  skillId: string | null
  approvalPolicyRef: string | null
  reason: string | null
}

export interface BotRecord {
  id: string
  botId: string
  tenantId: string
  ownerSubjectId: string
  agentSubjectId: string
  ownerOrganizationId: string | null
  useCaseId: string | null
  teamWorkspaceId: string | null
  name: string
  role: string
  title: string
  description: string
  antiJobs: string
  voice: string
  wake: "chat" | "routine" | "both" | ""
  avatar: unknown
  workspacePath: string
  skills: string[]
  allowedTools?: string[]
  modelRoute: "codex-subscription" | "genio-gateway"
  defaultRuntimeTier: RuntimeTier
  sharePolicy: BotSharePolicy
  sourceResourceId: string | null
  sourceVersion: string | null
  sourceDigest: string | null
  createdAt: number
  updatedAt: number
  revision: number
  archived: boolean
  bindings: BotBinding[]
}

export interface PendingBotDeletion {
  tenantId: string
  ownerSubjectId: string
  botId: string
  createdAt: number
  updatedAt: number
}


/** Slice A/D: durable product profile. Not the same as bindings/session/runtime. */
export interface BotProfile {
  botId: string
  name: string
  /** title / one job — short job label, not a free-form dump */
  title: string
  description: string
  /** Slice D designer fields (optional on legacy bots) */
  antiJobs: string
  voice: string
  wake: "chat" | "routine" | "both" | ""
  visibility: "PRIVATE" | "SELECTED" | "TEAM" | "ORG"
  avatar: unknown
  modelRoute: "codex-subscription" | "genio-gateway"
  tenantId: string
  ownerSubjectId: string
  ownerOrganizationId: string | null
  useCaseId: string | null
  teamWorkspaceId: string | null
  createdAt: number
  updatedAt: number
  revision: number
}

export function toBotProfile(bot: BotRecord): BotProfile {
  return {
    botId: bot.botId || bot.id,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    antiJobs: bot.antiJobs,
    voice: bot.voice,
    wake: bot.wake,
    visibility: bot.sharePolicy.visibility,
    avatar: bot.avatar,
    modelRoute: bot.modelRoute,
    tenantId: bot.tenantId,
    ownerSubjectId: bot.ownerSubjectId,
    ownerOrganizationId: bot.ownerOrganizationId,
    useCaseId: bot.useCaseId,
    teamWorkspaceId: bot.teamWorkspaceId,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    revision: bot.revision,
  }
}

/** Slice B: bot → app-server thread / memory pointer + unread/working projection. */
export type BotWorkState = "idle" | "working" | "stopped"

export interface BotSession {
  botId: string
  appServerThreadId: string | null
  codexHomeNamespace: string
  activeRuntimeTier: RuntimeTier
  memoryPointer: string | null
  unread: boolean
  workState: BotWorkState
  updatedAt: number
  lastEventAt: number
}

export interface RuntimeHistoryImport {
  botId: string
  threadId: string
  turnIds: string[]
}

export interface BotRosterEntry {
  bot: BotRecord
  session: BotSession
  summary: BotSidebarSummary
}

export type BotSessionEventType = "turn_started" | "turn_completed" | "turn_stopped" | "turn_idle" | "viewed"

function isWorkState(value: unknown): value is BotWorkState {
  return value === "idle" || value === "working" || value === "stopped"
}

export function defaultBotSession(botId: string, now = Date.now()): BotSession {
  return {
    botId,
    appServerThreadId: null,
    codexHomeNamespace: `bot/${botId}`,
    activeRuntimeTier: "none",
    memoryPointer: null,
    unread: false,
    workState: "idle",
    updatedAt: now,
    lastEventAt: now,
  }
}

export interface BotPackageManifest {
  packageType: "BOT"
  resourceId: string
  version: string
  profile: {
    title: string
    description: string
    avatar: unknown
  }
  skills: Array<{ id: string; path: string; digest?: string }>
  plugins: Array<{ name: string; marketplace?: string; marketplacePath?: string; digest?: string }>
  resourceBindings: Array<{ resourceId: string; capabilityId: string }>
  defaultRuntimeTier: RuntimeTier
  modelRoute?: "codex-subscription" | "genio-gateway"
  manifestDigest: string
  artifactDigest: string
  source?: { kind: "GITHUB" | "FIXTURE" | "UPLOAD"; ref: string; path?: string }
  accessStatus?: "ENTITLED" | "AUTO_GRANT" | "REQUEST" | "NEEDS_CONNECTION" | "DENIED"
  connectionStatus?: "CONNECTED" | "AVAILABLE" | "NEEDS_CONNECTION"
}

export interface CreateBotInput {
  name: string
  role?: string
  title?: string
  description?: string
  antiJobs?: string
  voice?: string
  wake?: "chat" | "routine" | "both" | ""
  avatar?: unknown
  skills?: string[]
  allowedTools?: string[]
  modelRoute?: "codex-subscription" | "genio-gateway"
  defaultRuntimeTier?: RuntimeTier
  sourceResourceId?: string | null
  sourceVersion?: string | null
  sourceDigest?: string | null
  bindings?: Array<Partial<BotBinding> & Pick<BotBinding, "resourceId" | "capabilityId">>
  agentSubjectId?: string
  ownerOrganizationId?: string | null
  useCaseId?: string | null
  selfCreateRequestId?: string | null
  teamWorkspaceId?: string | null
}

export interface UpdateBotInput {
  expectedRevision?: number
  name?: string
  role?: string
  title?: string
  description?: string
  antiJobs?: string
  voice?: string
  wake?: "chat" | "routine" | "both" | ""
  avatar?: unknown
  skills?: string[]
  allowedTools?: string[]
  modelRoute?: "codex-subscription" | "genio-gateway"
  defaultRuntimeTier?: RuntimeTier
  sharePolicy?: Partial<BotSharePolicy>
  bindings?: Array<Partial<BotBinding> & Pick<BotBinding, "resourceId" | "capabilityId">>
  teamWorkspaceId?: string | null
}

export interface BotSelfProfileRevision {
  revision: number
  updatedAt: number
}

function selfProfileSnapshot(bot: BotRecord) {
  return {
    name: bot.name,
    title: bot.title,
    description: bot.description,
    antiJobs: bot.antiJobs,
    voice: bot.voice,
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

const DEFAULT_SHARE_POLICY: BotSharePolicy = {
  visibility: "PRIVATE",
  discoverable: false,
  invocable: false,
  approval: "ALWAYS_ASK",
  audienceIds: [],
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function normalizeAvatar(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { shape: "cercle", color: "turquoise", expression: "neutre" }
  const record = value as Record<string, unknown>
  return typeof record.shape === "string" && typeof record.color === "string" && typeof record.expression === "string"
    ? { ...record }
    : { shape: "cercle", color: "turquoise", expression: "neutre" }
}

function normalizeSharePolicy(value: unknown): BotSharePolicy {
  const parsed = value && typeof value === "object" ? value as Partial<BotSharePolicy> : {}
  return {
    visibility: parsed.visibility === "SELECTED" || parsed.visibility === "TEAM" || parsed.visibility === "ORG" ? parsed.visibility : "PRIVATE",
    discoverable: parsed.discoverable === true,
    invocable: parsed.invocable === true,
    approval: parsed.approval === "POLICY_AUTO_APPROVE" ? parsed.approval : "ALWAYS_ASK",
    audienceIds: stringArray(parsed.audienceIds),
  }
}

function isRuntimeTier(value: unknown): value is RuntimeTier {
  return value === "none" || value === "headless" || value === "desktop"
}

export function normalizeTeamWorkspaceId(value: string | null): string | null {
  if (value !== null && (value.length > 256 || value.trim() !== value || !value)) throw new Error("TEAM_WORKSPACE_INVALID")
  return value
}

function isVisibleTo(bot: BotRecord, principal: GenioPrincipal) {
  if (bot.tenantId !== principal.tenant_id || bot.archived) return false
  if (bot.ownerSubjectId === principal.subject_id) return true
  const share = bot.sharePolicy
  if (!share.discoverable || !share.invocable) return false
  if (share.visibility === "ORG" || share.visibility === "TEAM") return true
  return share.visibility === "SELECTED" && share.audienceIds.includes(principal.subject_id)
}

export class BotRegistry {
  readonly db: Database
  private readonly packages: ResolvedBotPackage[]
  readonly artifacts: BotArtifactStore
  readonly invocations: BotInvocationStore
  readonly handoffs: BotHandoffStore
  readonly groups: BotGroupStore
  readonly timeline: BotTimelineStore
  readonly interactionHistory: InteractionHistory
  readonly questions: BotQuestions
  readonly continuations: BotContinuations
  readonly memory: BotMemoryStore
  readonly ownedSkills: BotOwnedSkills
  private readonly historyImportObservers = new Set<(event: RuntimeHistoryImport) => void>()

  constructor(
    databasePath = process.env.GENIO_BOT_REGISTRY_DB?.trim() || resolve(import.meta.dir, "../.local/bot-registry.sqlite"),
    artifactStoreRoot = process.env.GENIO_BOT_ARTIFACT_STORE?.trim() || resolve(import.meta.dir, "../.local/artifacts"),
  ) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new Database(databasePath)
    this.questions = new BotQuestions(this.db)
    this.continuations = new BotContinuations(this.db, (id) => this.handoffs.kindForInvocation(id) === "fyi")
    this.memory = new BotMemoryStore(this.db, (botId, ids) => {
      const messages = new Set(this.timeline.read(botId, []).map((message) => message.id))
      return ids.every((id) => messages.has(id))
    })
    this.interactionHistory = new InteractionHistory(this.db)
    this.timeline = new BotTimelineStore(this.db, (botId, clientId) => this.continuations.inputLabel(botId, clientId), (botId, clientId) => this.continuations.inputHandoff(botId, clientId), (botId, clientId) => {
      if (!clientId.startsWith("question-answer:")) return null
      const question = this.questions.list(botId).find((question) => `question-answer:${question.id}:${question.clientAnswerId}` === clientId)
      return question?.answer ? { id: question.id, answer: question.answer } : null
    })
    this.db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;")
    this.packages = loadBotPackages()
    this.ownedSkills = new BotOwnedSkills(this.db, (botId, principal) => Boolean(this.getOwned(botId, principal)))
    this.artifacts = new BotArtifactStore(this.db, resolve(artifactStoreRoot), (botId, principal) => this.getOwned(botId, principal))
    this.invocations = new BotInvocationStore(this.db, (botId, principal) => this.getOwned(botId, principal), (botId, principal) => this.get(botId, principal))
    this.handoffs = new BotHandoffStore(
      this.db,
      (botId, principal) => this.getOwned(botId, principal),
      (botId, principal) => this.get(botId, principal),
      (principal, input) => this.invocations.createInvocation(principal, input),
      (botId) => { this.applySessionEvent(botId, "turn_completed") },
    )
    this.groups = new BotGroupStore(
      this.db,
      (botId, principal) => this.getOwned(botId, principal),
    )
    this.db.exec(`
      create table if not exists bots (
        id text primary key,
        tenant_id text not null,
        owner_subject_id text not null,
        agent_subject_id text not null,
        owner_organization_id text,
        use_case_id text,
        name text not null,
        role text not null,
        title text not null,
        description text not null,
        avatar_json text not null,
        workspace_path text not null,
        skills_json text not null,
        allowed_tools_json text,
        model_route text not null,
        default_runtime_tier text not null,
        share_policy_json text not null,
        source_resource_id text,
        source_version text,
        source_digest text,
        created_at integer not null,
        updated_at integer not null,
        profile_revision integer not null default 1,
        self_create_request_id text,
        archived integer not null default 0
      );
      create table if not exists bot_bindings (
        id text primary key,
        bot_id text not null,
        resource_id text not null,
        capability_id text not null,
        version text not null,
        artifact_digest text,
        state text not null,
        kind text not null,
        unique(bot_id, resource_id, capability_id)
      );
      create table if not exists bot_sessions (
        bot_id text primary key,
        app_server_thread_id text,
        codex_home_namespace text not null,
        active_runtime_tier text not null,
        updated_at integer not null,
        unread integer not null default 0,
        work_state text not null default 'idle',
        memory_pointer text,
        last_event_at integer not null default 0
      );
      create table if not exists bot_session_threads (
        bot_id text not null,
        thread_id text not null,
        first_seen_at integer not null,
        primary key (bot_id, thread_id)
      );
      insert or ignore into bot_session_threads (bot_id, thread_id, first_seen_at)
        select bot_id, app_server_thread_id, updated_at from bot_sessions
        where app_server_thread_id is not null;
      create table if not exists bot_invocations (
        request_id text primary key,
        tenant_id text not null,
        caller_subject_id text not null,
        caller_bot_id text not null,
        target_owner_subject_id text not null,
        target_bot_id text not null,
        target_agent_subject_id text not null,
        task text not null,
        selected_context_json text not null,
        requested_capabilities_json text not null,
        action_digest text not null,
        state text not null,
        decision_reason text,
        expires_at integer not null,
        created_at integer not null,
        decided_at integer,
        result_summary text,
        artifact_refs_json text not null
      );
      create table if not exists bot_artifacts (
        artifact_id text primary key,
        tenant_id text not null,
        bot_id text not null,
        source_tier text not null,
        source_environment_id text not null,
        path text not null,
        digest text not null,
        content_type text not null,
        size integer not null,
        storage_provider text not null default 'e2b-self-hosted',
        source_workspace_id text,
        source_revision integer,
        storage_ref text,
        created_at integer not null
      )
      ;
      create table if not exists bot_profile_revisions (
        bot_id text not null,
        revision integer not null,
        profile_json text not null,
        created_at integer not null,
        primary key (bot_id, revision)
      );
      create table if not exists bot_evidence_source_tombstones (
        bot_id text primary key,
        tenant_id text not null,
        owner_subject_id text not null,
        deleted_at integer not null
      );
      create table if not exists bot_self_create_requests (
        tenant_id text not null,
        owner_subject_id text not null,
        client_request_id text not null,
        payload_json text,
        bot_id text,
        state text not null,
        created_at integer not null,
        updated_at integer not null,
        primary key (tenant_id, owner_subject_id, client_request_id)
      );
      create table if not exists bot_pending_deletions (
        tenant_id text not null,
        owner_subject_id text not null,
        bot_id text not null,
        created_at integer not null,
        updated_at integer not null,
        attempt_generation integer not null default 0,
        unresolved_attempts integer not null default 0,
        primary key (tenant_id, owner_subject_id, bot_id)
      );
    `)
    this.ensureSessionSchema()
    this.ensureBindingSchema()
    this.ensureDesignerSchema()
    this.ensureSelfManagementSchema()
    this.ensureTeamWorkspaceSchema()
    this.ensurePendingDeletionSchema()
    this.ensureArtifactSchema()
  }

  private ensureArtifactSchema() {
    const columns = this.db.query("pragma table_info(bot_artifacts)").all() as Array<{ name: string }>
    const names = new Set(columns.map((column) => column.name))
    if (!names.has("storage_provider")) this.db.exec("alter table bot_artifacts add column storage_provider text not null default 'e2b-self-hosted'")
    if (!names.has("source_workspace_id")) this.db.exec("alter table bot_artifacts add column source_workspace_id text")
    if (!names.has("source_revision")) this.db.exec("alter table bot_artifacts add column source_revision integer")
    if (!names.has("storage_ref")) this.db.exec("alter table bot_artifacts add column storage_ref text")
  }

  private ensureTeamWorkspaceSchema() {
    const columns = this.db.query("pragma table_info(bots)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "team_workspace_id")) {
      this.db.exec("alter table bots add column team_workspace_id text")
    }
  }

  /** Additive columns for older bot_sessions rows (SQLite). */
  private ensureSessionSchema() {
    const threadColumns = this.db.query("pragma table_info(bot_session_threads)").all() as Array<{ name: string }>
    if (!threadColumns.some((column) => column.name === "history_status")) this.db.exec("alter table bot_session_threads add column history_status text not null default 'pending'")
    const cols = this.db.query("pragma table_info(bot_sessions)").all() as Array<{ name: string }>
    const names = new Set(cols.map((col) => col.name))
    if (!names.has("unread")) this.db.exec("alter table bot_sessions add column unread integer not null default 0")
    if (!names.has("work_state")) this.db.exec("alter table bot_sessions add column work_state text not null default 'idle'")
    if (!names.has("memory_pointer")) this.db.exec("alter table bot_sessions add column memory_pointer text")
    if (!names.has("last_event_at")) this.db.exec("alter table bot_sessions add column last_event_at integer not null default 0")
  }

  /** Slice D: one job lives in title; anti-jobs / voice / wake are durable profile fields. */
  private ensureDesignerSchema() {
    const cols = this.db.query("pragma table_info(bots)").all() as Array<{ name: string }>
    const names = new Set(cols.map((col) => col.name))
    if (!names.has("owner_organization_id")) this.db.exec("alter table bots add column owner_organization_id text")
    if (!names.has("use_case_id")) this.db.exec("alter table bots add column use_case_id text")
    if (!names.has("anti_jobs")) this.db.exec("alter table bots add column anti_jobs text not null default ''")
    if (!names.has("voice")) this.db.exec("alter table bots add column voice text not null default ''")
    if (!names.has("wake")) this.db.exec("alter table bots add column wake text not null default ''")
  }

  private ensureSelfManagementSchema() {
    const cols = this.db.query("pragma table_info(bots)").all() as Array<{ name: string }>
    const names = new Set(cols.map((col) => col.name))
    if (!names.has("profile_revision")) this.db.exec("alter table bots add column profile_revision integer not null default 1")
    if (!names.has("self_create_request_id")) this.db.exec("alter table bots add column self_create_request_id text")
    const requestColumns = this.db.query("pragma table_info(bot_self_create_requests)").all() as Array<{ name: string }>
    if (!requestColumns.some((column) => column.name === "payload_json")) this.db.exec("alter table bot_self_create_requests add column payload_json text")
    this.db.exec("create unique index if not exists bots_self_create_request_unique on bots (tenant_id, owner_subject_id, self_create_request_id) where self_create_request_id is not null")
  }

  private ensurePendingDeletionSchema() {
    const columns = this.db.query("pragma table_info(bot_pending_deletions)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "attempt_generation")) this.db.exec("alter table bot_pending_deletions add column attempt_generation integer not null default 0")
    if (!columns.some((column) => column.name === "unresolved_attempts")) this.db.exec("alter table bot_pending_deletions add column unresolved_attempts integer not null default 0")
  }

  /** Additive columns for BotBinding projection (skill / approval / reason). */
  private ensureBindingSchema() {
    const cols = this.db.query("pragma table_info(bot_bindings)").all() as Array<{ name: string }>
    const names = new Set(cols.map((col) => col.name))
    if (!names.has("skill_id")) this.db.exec("alter table bot_bindings add column skill_id text")
    if (!names.has("approval_policy_ref")) this.db.exec("alter table bot_bindings add column approval_policy_ref text")
    if (!names.has("reason")) this.db.exec("alter table bot_bindings add column reason text")
  }

  close() {
    this.db.close()
  }

  list(principal: GenioPrincipal): BotRecord[] {
    const rows = this.db.query("select * from bots where tenant_id = ? order by created_at asc").all(principal.tenant_id) as Record<string, unknown>[]
    if (rows.length === 0) return []
    const botIds = rows.map((r) => String(r.id))
    const placeholders = botIds.map(() => "?").join(",")
    const allBindings = this.db.query(
      `select * from bot_bindings where bot_id in (${placeholders}) order by resource_id, capability_id`,
    ).all(...botIds) as Record<string, unknown>[]

    const bindingsByBotId = new Map<string, BotBinding[]>()
    for (const b of allBindings) {
      const botId = String(b.bot_id)
      const list = bindingsByBotId.get(botId) ?? []
      list.push({
        id: String(b.id),
        botId,
        resourceId: String(b.resource_id),
        capabilityId: String(b.capability_id),
        version: String(b.version),
        artifactDigest: typeof b.artifact_digest === "string" ? b.artifact_digest : null,
        state: b.state as BotBinding["state"],
        kind: b.kind as BotBinding["kind"],
        skillId: typeof b.skill_id === "string" ? b.skill_id : null,
        approvalPolicyRef: typeof b.approval_policy_ref === "string" ? b.approval_policy_ref : null,
        reason: typeof b.reason === "string" ? b.reason : null,
      })
      bindingsByBotId.set(botId, list)
    }

    return rows
      .map((row) => this.mapBot(row, bindingsByBotId.get(String(row.id)) ?? []))
      .filter((bot) => isVisibleTo(bot, principal))
  }

  ownedBotIds(principal: Pick<GenioPrincipal, "tenant_id" | "subject_id">): string[] {
    return (this.db.query(`select id from bots
      where tenant_id = ? and owner_subject_id = ? and archived = 0
      order by created_at asc`).all(principal.tenant_id, principal.subject_id) as Array<{ id: string }>)
      .map((row) => row.id)
  }

  get(botId: string, principal: GenioPrincipal): BotRecord | null {
    const row = this.db.query("select * from bots where id = ? and tenant_id = ?").get(botId, principal.tenant_id) as Record<string, unknown> | null
    if (!row) return null
    const bot = this.mapBot(row)
    return isVisibleTo(bot, principal) ? bot : null
  }

  getOwned(botId: string, principal: GenioPrincipal): BotRecord | null {
    const row = this.db.query("select * from bots where id = ? and tenant_id = ? and owner_subject_id = ? and archived = 0").get(botId, principal.tenant_id, principal.subject_id) as Record<string, unknown> | null
    return row ? this.mapBot(row) : null
  }

  findEvidenceSource(tenantId: string, ownerSubjectId: string, botId: string): { botId: string } | null {
    const live = this.db.query("select id from bots where id = ? and tenant_id = ? and owner_subject_id = ?").get(botId, tenantId, ownerSubjectId) as { id: string } | null
    if (live) return { botId: live.id }
    const tombstone = this.db.query("select bot_id as botId from bot_evidence_source_tombstones where bot_id = ? and tenant_id = ? and owner_subject_id = ?").get(botId, tenantId, ownerSubjectId) as { botId: string } | null
    return tombstone ?? null
  }

  beginPendingDeletion(botId: string, principal: GenioPrincipal) {
    return this.db.transaction(() => {
      const bot = this.db.query("select archived from bots where id = ? and tenant_id = ? and owner_subject_id = ?").get(botId, principal.tenant_id, principal.subject_id) as { archived: number } | null
      if (!bot) return null
      const pending = this.db.query("select 1 from bot_pending_deletions where tenant_id = ? and owner_subject_id = ? and bot_id = ?").get(principal.tenant_id, principal.subject_id, botId)
      if (Number(bot.archived) === 1 && !pending) return null
      const now = Date.now()
      if (pending) {
        this.db.query("update bot_pending_deletions set updated_at = ? where tenant_id = ? and owner_subject_id = ? and bot_id = ?").run(now, principal.tenant_id, principal.subject_id, botId)
      } else {
        this.db.query("insert into bot_pending_deletions (tenant_id, owner_subject_id, bot_id, created_at, updated_at) values (?, ?, ?, ?, ?)").run(principal.tenant_id, principal.subject_id, botId, now, now)
      }
      if (Number(bot.archived) !== 1) this.db.query("update bots set archived = 1, updated_at = ? where id = ? and tenant_id = ? and owner_subject_id = ?").run(now, botId, principal.tenant_id, principal.subject_id)
      return { created: !pending }
    })()
  }

  claimPendingDeletionAttempt(botId: string, principal: GenioPrincipal) {
    return this.db.transaction(() => {
      const updated = this.db.query("update bot_pending_deletions set attempt_generation = attempt_generation + 1, unresolved_attempts = unresolved_attempts + 1, updated_at = ? where tenant_id = ? and owner_subject_id = ? and bot_id = ? returning attempt_generation").get(Date.now(), principal.tenant_id, principal.subject_id, botId) as { attempt_generation?: number } | null
      return updated?.attempt_generation ?? null
    })()
  }

  settlePendingDeletionAttempt(botId: string, principal: GenioPrincipal) {
    return this.db.transaction(() => {
      const updated = this.db.query("update bot_pending_deletions set unresolved_attempts = unresolved_attempts - 1, updated_at = ? where tenant_id = ? and owner_subject_id = ? and bot_id = ? and unresolved_attempts > 0 returning unresolved_attempts").get(Date.now(), principal.tenant_id, principal.subject_id, botId) as { unresolved_attempts?: number } | null
      return updated?.unresolved_attempts ?? null
    })()
  }

  rollbackPendingDeletion(botId: string, principal: GenioPrincipal, generation: number) {
    return this.db.transaction(() => {
      const removed = this.db.query("delete from bot_pending_deletions where tenant_id = ? and owner_subject_id = ? and bot_id = ? and attempt_generation = ? and unresolved_attempts = 0").run(principal.tenant_id, principal.subject_id, botId, generation)
      if (removed.changes !== 1) return false
      this.db.query("update bots set archived = 0, updated_at = ? where id = ? and tenant_id = ? and owner_subject_id = ?").run(Date.now(), botId, principal.tenant_id, principal.subject_id)
      return true
    })()
  }

  pendingDeletions(): PendingBotDeletion[] {
    return (this.db.query("select tenant_id, owner_subject_id, bot_id, created_at, updated_at from bot_pending_deletions order by created_at, bot_id").all() as Array<Record<string, unknown>>).map((row) => ({
      tenantId: String(row.tenant_id),
      ownerSubjectId: String(row.owner_subject_id),
      botId: String(row.bot_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }))
  }

  getProfile(botId: string, principal: GenioPrincipal): BotProfile | null {
    const bot = this.get(botId, principal)
    return bot ? toBotProfile(bot) : null
  }

  setUsageContext(botId: string, principal: GenioPrincipal, input: { ownerOrganizationId: string; useCaseId: string }): BotRecord {
    const current = this.getOwned(botId, principal)
    if (!current) throw new Error("BOT_NOT_FOUND")
    if (current.ownerOrganizationId || current.useCaseId) {
      if (current.ownerOrganizationId !== input.ownerOrganizationId || current.useCaseId !== input.useCaseId) throw new Error("BOT_USAGE_CONTEXT_CONFLICT")
      return current
    }
    this.db.query("update bots set owner_organization_id = ?, use_case_id = ?, updated_at = ?, profile_revision = profile_revision + 1 where id = ? and tenant_id = ? and owner_subject_id = ?").run(
      input.ownerOrganizationId,
      input.useCaseId,
      Date.now(),
      botId,
      principal.tenant_id,
      principal.subject_id,
    )
    const updated = this.getOwned(botId, principal)!
    this.writeProfileRevision(updated)
    return updated
  }

  create(principal: GenioPrincipal, input: CreateBotInput): BotRecord {
    const now = Date.now()
    const id = `bot-${randomUUID().slice(0, 12)}`
    // title/description are the profile SoT; role is a legacy mirror of description only
    const description = (input.description ?? input.role ?? "企業營運夥伴").trim() || "企業營運夥伴"
    const title = (input.title ?? description).trim() || description
    const role = description
    const antiJobs = (input.antiJobs ?? "").trim()
    const voice = (input.voice ?? "").trim()
    const wake = input.wake === "chat" || input.wake === "routine" || input.wake === "both" ? input.wake : ""
    const tier = input.defaultRuntimeTier && isRuntimeTier(input.defaultRuntimeTier) ? input.defaultRuntimeTier : "none"
    const teamWorkspaceId = normalizeTeamWorkspaceId(input.teamWorkspaceId ?? null)
    const runTransaction = this.db.transaction(() => {
      this.db.query(`insert into bots (
        id, tenant_id, owner_subject_id, agent_subject_id, owner_organization_id, use_case_id, name, role, title, description,
        avatar_json, workspace_path, skills_json, allowed_tools_json, model_route,
        default_runtime_tier, share_policy_json, source_resource_id, source_version,
        source_digest, created_at, updated_at, profile_revision, self_create_request_id, archived, anti_jobs, voice, wake, team_workspace_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?, ?)`).run(
        id,
        principal.tenant_id,
        principal.subject_id,
        input.agentSubjectId?.trim() || `agent-${randomUUID()}`,
        input.ownerOrganizationId?.trim() || null,
        input.useCaseId?.trim() || null,
        input.name.trim() || "Genio Bot",
        role,
        title,
        description,
        JSON.stringify(normalizeAvatar(input.avatar)),
        `/workspaces/${id}`,
        JSON.stringify(input.skills ?? []),
        input.allowedTools ? JSON.stringify(input.allowedTools) : null,
        input.modelRoute ?? "codex-subscription",
        tier,
        JSON.stringify(DEFAULT_SHARE_POLICY),
        input.sourceResourceId ?? null,
        input.sourceVersion ?? null,
        input.sourceDigest ?? null,
        now,
        now,
        input.selfCreateRequestId?.trim() || null,
        antiJobs,
        voice,
        wake,
        teamWorkspaceId,
      )
      this.replaceBindings(id, input.bindings ?? [])
      const created = this.getOwned(id, principal)!
      this.writeProfileRevision(created)
      return created
    })
    return runTransaction()
  }

  update(botId: string, principal: GenioPrincipal, input: UpdateBotInput): BotRecord {
    const current = this.getOwned(botId, principal)
    if (!current) throw new Error("BOT_NOT_FOUND")
    const nextShare: BotSharePolicy = {
      ...current.sharePolicy,
      ...(input.sharePolicy ?? {}),
      audienceIds: input.sharePolicy?.audienceIds ?? current.sharePolicy.audienceIds,
    }
    const now = Date.now()
    const nextWake = input.wake === "chat" || input.wake === "routine" || input.wake === "both" || input.wake === ""
      ? input.wake
      : current.wake
    const expectedRevision = input.expectedRevision
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new Error("BOT_PROFILE_REVISION_INVALID")
    const teamWorkspaceId = normalizeTeamWorkspaceId(input.teamWorkspaceId === undefined ? current.teamWorkspaceId : input.teamWorkspaceId)
    const runTransaction = this.db.transaction(() => {
      this.writeProfileRevision(current)
      const result = this.db.query(`update bots set name = ?, role = ?, title = ?, description = ?, avatar_json = ?,
        skills_json = ?, allowed_tools_json = ?, model_route = ?, default_runtime_tier = ?, share_policy_json = ?,
        anti_jobs = ?, voice = ?, wake = ?, team_workspace_id = ?, updated_at = ?, profile_revision = profile_revision + 1
        where id = ? and tenant_id = ? and owner_subject_id = ? and profile_revision = ?`).run(
        input.name?.trim() || current.name,
        (input.description?.trim() || input.role?.trim() || current.description),
        input.title?.trim() || current.title,
        (input.description?.trim() || input.role?.trim() || current.description),
        JSON.stringify(normalizeAvatar(input.avatar ?? current.avatar)),
        JSON.stringify(input.skills ?? current.skills),
        input.allowedTools === undefined ? (current.allowedTools ? JSON.stringify(current.allowedTools) : null) : JSON.stringify(input.allowedTools),
        input.modelRoute ?? current.modelRoute,
        input.defaultRuntimeTier && isRuntimeTier(input.defaultRuntimeTier) ? input.defaultRuntimeTier : current.defaultRuntimeTier,
        JSON.stringify(normalizeSharePolicy(nextShare)),
        input.antiJobs !== undefined ? input.antiJobs.trim() : current.antiJobs,
        input.voice !== undefined ? input.voice.trim() : current.voice,
        nextWake,
        teamWorkspaceId,
        now,
        botId,
        principal.tenant_id,
        principal.subject_id,
        expectedRevision ?? current.revision,
      )
      if (result.changes !== 1) throw new Error("BOT_PROFILE_REVISION_CONFLICT")
      if (input.bindings) this.replaceBindings(botId, input.bindings)
      const updated = this.getOwned(botId, principal)!
      this.writeProfileRevision(updated)
      return updated
    })
    return runTransaction()
  }

  readSelf(botId: string, principal: GenioPrincipal) {
    const bot = this.getOwned(botId, principal)
    if (!bot) throw new Error("BOT_NOT_FOUND")
    let history = this.db.query("select revision, created_at from bot_profile_revisions where bot_id = ? order by revision desc limit 20").all(botId) as Array<{ revision: number; created_at: number }>
    if (history.length === 0) {
      this.writeProfileRevision(bot)
      history = this.db.query("select revision, created_at from bot_profile_revisions where bot_id = ? order by revision desc limit 20").all(botId) as Array<{ revision: number; created_at: number }>
    }
    return {
      bot: { id: bot.id, ...toBotProfile(bot), antiJobs: bot.antiJobs, voice: bot.voice },
      history: history.map((row) => ({ revision: Number(row.revision), updatedAt: Number(row.created_at) })),
    }
  }

  updateSelf(botId: string, principal: GenioPrincipal, input: {
    expectedRevision: number
    name?: string
    title?: string
    description?: string
    antiJobs?: string
    voice?: string
    restoreRevision?: number
  }) {
    const current = this.getOwned(botId, principal)
    if (!current) throw new Error("BOT_NOT_FOUND")
    if (current.revision !== input.expectedRevision) throw new Error("BOT_PROFILE_REVISION_CONFLICT")
    let next = input
    if (input.restoreRevision !== undefined) {
      const row = this.db.query("select profile_json from bot_profile_revisions where bot_id = ? and revision = ?").get(botId, input.restoreRevision) as { profile_json?: string } | null
      if (!row?.profile_json) throw new Error("BOT_PROFILE_REVISION_NOT_FOUND")
      const profile = parseJson<Record<string, unknown>>(row.profile_json, {})
      next = {
        expectedRevision: input.expectedRevision,
        name: typeof profile.name === "string" ? profile.name : current.name,
        title: typeof profile.title === "string" ? profile.title : current.title,
        description: typeof profile.description === "string" ? profile.description : current.description,
        antiJobs: typeof profile.antiJobs === "string" ? profile.antiJobs : current.antiJobs,
        voice: typeof profile.voice === "string" ? profile.voice : current.voice,
      }
    }
    const updated = this.update(botId, principal, { ...next, expectedRevision: input.expectedRevision })
    return { bot: { id: updated.id, ...toBotProfile(updated), antiJobs: updated.antiJobs, voice: updated.voice }, revision: updated.revision }
  }

  beginSelfBotCreate(principal: GenioPrincipal, clientRequestId: string, payload: unknown) {
    const payloadJson = canonicalJson(payload)
    const current = this.db.query("select bot_id, state, payload_json from bot_self_create_requests where tenant_id = ? and owner_subject_id = ? and client_request_id = ?").get(principal.tenant_id, principal.subject_id, clientRequestId) as { bot_id: string | null; state: string; payload_json: string | null } | null
    if (current && current.payload_json !== payloadJson) throw new Error("BOT_CREATE_REQUEST_CONFLICT")
    if (current?.bot_id) {
      const row = this.db.query("select archived from bots where id = ? and tenant_id = ? and owner_subject_id = ?").get(current.bot_id, principal.tenant_id, principal.subject_id) as { archived?: number } | null
      if (row && Number(row.archived) !== 1) {
        const bot = this.getOwned(current.bot_id, principal)
        if (bot) return { state: "COMPLETED" as const, bot }
      }
      this.db.query("update bot_self_create_requests set state = 'DELETED', updated_at = ? where tenant_id = ? and owner_subject_id = ? and client_request_id = ?").run(Date.now(), principal.tenant_id, principal.subject_id, clientRequestId)
      return { state: "DELETED" as const, bot: null }
    }
    if (current) {
      if (current.state !== "PENDING") return { state: "DELETED" as const, bot: null }
      const recovered = this.db.query("select id from bots where tenant_id = ? and owner_subject_id = ? and self_create_request_id = ?").get(principal.tenant_id, principal.subject_id, clientRequestId) as { id?: string } | null
      if (recovered?.id) {
        this.db.query("update bot_self_create_requests set bot_id = ?, state = 'COMPLETED', updated_at = ? where tenant_id = ? and owner_subject_id = ? and client_request_id = ? and payload_json = ?").run(recovered.id, Date.now(), principal.tenant_id, principal.subject_id, clientRequestId, payloadJson)
        return { state: "COMPLETED" as const, bot: this.getOwned(recovered.id, principal)! }
      }
      return { state: "PENDING" as const, bot: null }
    }
    const now = Date.now()
    this.db.query("insert into bot_self_create_requests (tenant_id, owner_subject_id, client_request_id, payload_json, bot_id, state, created_at, updated_at) values (?, ?, ?, ?, null, 'PENDING', ?, ?)").run(principal.tenant_id, principal.subject_id, clientRequestId, payloadJson, now, now)
    return { state: "PENDING" as const, bot: null }
  }

  completeSelfBotCreate(principal: GenioPrincipal, clientRequestId: string, input: CreateBotInput) {
    return this.db.transaction(() => {
      const request = this.db.query("select bot_id, state from bot_self_create_requests where tenant_id = ? and owner_subject_id = ? and client_request_id = ?").get(principal.tenant_id, principal.subject_id, clientRequestId) as { bot_id: string | null; state: string } | null
      if (!request) throw new Error("BOT_CREATE_REQUEST_NOT_FOUND")
      if (request.state !== "PENDING" && !request.bot_id) throw new Error("BOT_CREATE_REQUEST_TOMBSTONED")
      if (request.bot_id) {
        const bot = this.getOwned(request.bot_id, principal)
        if (bot) return { bot, created: false }
        throw new Error("BOT_CREATE_REQUEST_TOMBSTONED")
      }
      const existing = this.db.query("select id from bots where tenant_id = ? and owner_subject_id = ? and self_create_request_id = ?").get(principal.tenant_id, principal.subject_id, clientRequestId) as { id?: string } | null
      const bot = existing?.id ? this.getOwned(existing.id, principal)! : this.create(principal, { ...input, selfCreateRequestId: clientRequestId })
      this.db.query("update bot_self_create_requests set bot_id = ?, state = 'COMPLETED', updated_at = ? where tenant_id = ? and owner_subject_id = ? and client_request_id = ? and state = 'PENDING'").run(bot.id, Date.now(), principal.tenant_id, principal.subject_id, clientRequestId)
      return { bot, created: !existing?.id }
    })()
  }

  delete(botId: string, principal: GenioPrincipal): boolean {
    const current = this.getOwned(botId, principal)
    if (!current) throw new Error("BOT_NOT_FOUND")
    this.db.transaction(() => this.deleteRecord(botId, principal))()
    return true
  }

  finalizePendingDeletion(botId: string, principal: GenioPrincipal) {
    const pending = this.db.query("select 1 from bot_pending_deletions where tenant_id = ? and owner_subject_id = ? and bot_id = ?").get(principal.tenant_id, principal.subject_id, botId)
    if (!pending) return false
    const bot = this.db.query("select archived from bots where id = ? and tenant_id = ? and owner_subject_id = ?").get(botId, principal.tenant_id, principal.subject_id) as { archived: number } | null
    if (!bot || Number(bot.archived) !== 1) throw new Error("BOT_DELETE_FENCE_MISSING")
    this.deleteRecord(botId, principal)
    this.db.query("delete from bot_pending_deletions where tenant_id = ? and owner_subject_id = ? and bot_id = ?").run(principal.tenant_id, principal.subject_id, botId)
    return true
  }

  private deleteRecord(botId: string, principal: GenioPrincipal) {
    const workspaceTable = this.db.query("select 1 from sqlite_master where type = 'table' and name = 'bot_workspaces'").get()
    if (workspaceTable) this.db.query("update bot_workspaces set active = 0, orphaned_at = ?, updated_at = ? where bot_id = ? and tenant_id = ? and owner_subject_id = ? and orphaned_at is null").run(Date.now(), Date.now(), botId, principal.tenant_id, principal.subject_id)
    this.db.query(`insert into bot_evidence_source_tombstones (bot_id, tenant_id, owner_subject_id, deleted_at)
      values (?, ?, ?, ?) on conflict(bot_id) do update set
        tenant_id = excluded.tenant_id,
        owner_subject_id = excluded.owner_subject_id,
        deleted_at = excluded.deleted_at`).run(botId, principal.tenant_id, principal.subject_id, Date.now())
    this.db.query("update bot_self_create_requests set state = 'DELETED', updated_at = ? where bot_id = ? and tenant_id = ? and owner_subject_id = ?").run(Date.now(), botId, principal.tenant_id, principal.subject_id)
    for (const table of [
      "bot_distillation_inbox",
      "bot_distillation_backfill_progress",
    ]) {
      const exists = this.db.query("select 1 from sqlite_master where type = 'table' and name = ?").get(table)
      if (exists) this.db.query(`delete from ${table} where bot_id = ?`).run(botId)
    }
    this.db.query("delete from bot_bindings where bot_id = ?").run(botId)
    this.db.query("delete from bot_sessions where bot_id = ?").run(botId)
    this.db.query("delete from bot_artifacts where bot_id = ?").run(botId)
    this.db.query("delete from bot_owned_skill_revisions where bot_id = ?").run(botId)
    this.db.query("delete from bot_owned_skills where bot_id = ?").run(botId)
    this.db.query("delete from bot_profile_revisions where bot_id = ?").run(botId)
    this.db.query("delete from bots where id = ? and tenant_id = ? and owner_subject_id = ?").run(botId, principal.tenant_id, principal.subject_id)
  }

  duplicate(botId: string, principal: GenioPrincipal, agentSubjectId?: string): BotRecord {
    const source = this.getOwned(botId, principal)
    if (!source) throw new Error("BOT_NOT_FOUND")
    const preserveUsageContext = source.ownerSubjectId === principal.subject_id &&
      source.tenantId === principal.tenant_id &&
      typeof source.ownerOrganizationId === "string" &&
      typeof source.useCaseId === "string" &&
      Array.isArray(principal.organization_ids) &&
      principal.organization_ids.includes(source.ownerOrganizationId)
    return this.create(principal, {
      name: `${source.name} 副本`,
      role: source.role,
      title: source.title,
      description: source.description,
      antiJobs: source.antiJobs,
      voice: source.voice,
      wake: source.wake,
      avatar: source.avatar,
      skills: source.skills,
      allowedTools: source.allowedTools,
      modelRoute: source.modelRoute,
      defaultRuntimeTier: source.defaultRuntimeTier,
      sourceResourceId: source.sourceResourceId,
      sourceVersion: source.sourceVersion,
      sourceDigest: source.sourceDigest,
      ownerOrganizationId: preserveUsageContext ? source.ownerOrganizationId : null,
      useCaseId: preserveUsageContext ? source.useCaseId : null,
      bindings: source.bindings,
      agentSubjectId,
      teamWorkspaceId: source.teamWorkspaceId,
    })
  }

  listPackages(): BotPackageManifest[] {
    return packageCatalog(this.packages)
  }

  registerPackage(manifest: BotPackageManifest, artifactRoot?: string | null) {
    validateBotPackageManifest(manifest)
    const existing = this.packages.find((candidate) =>
      candidate.manifest.resourceId === manifest.resourceId && candidate.manifest.version === manifest.version)
    if (existing) {
      if (existing.manifest.manifestDigest !== manifest.manifestDigest || existing.manifest.artifactDigest !== manifest.artifactDigest) {
        throw new Error("BOT_PACKAGE_MANIFEST_MISMATCH")
      }
      if (artifactRoot && !existing.artifactRoot) existing.artifactRoot = artifactRoot
      return
    }
    this.packages.push({ manifest: structuredClone(manifest), artifactRoot: artifactRoot ?? null })
  }

  materialize(botId: string, principal: GenioPrincipal) {
    const bot = this.getOwned(botId, principal)
    if (!bot) throw new Error("BOT_NOT_FOUND")
    const resolved = this.packages.find((candidate) =>
      candidate.manifest.resourceId === bot.sourceResourceId &&
      candidate.manifest.version === bot.sourceVersion)
    if (!resolved) return { root: bot.workspacePath, skillRoots: [], plugins: [] }
    return materializeBotPackage(resolved, bot.id)
  }

  findInstalled(principal: GenioPrincipal, resourceId: string, version: string) {
    const row = this.db.query("select id from bots where tenant_id = ? and owner_subject_id = ? and source_resource_id = ? and source_version = ? and archived = 0").get(
      principal.tenant_id,
      principal.subject_id,
      resourceId,
      version,
    ) as { id?: string } | null
    return row?.id ? this.getOwned(row.id, principal) : null
  }

  install(principal: GenioPrincipal, resourceId: string, version?: string, agentSubjectId?: string, usageContext?: { ownerOrganizationId: string; useCaseId: string } | null) {
    const resolved = this.packages.find((candidate) => candidate.manifest.resourceId === resourceId && (!version || candidate.manifest.version === version))
    const manifest = resolved?.manifest
    if (!manifest) throw new Error("BOT_PACKAGE_NOT_FOUND")
    verifyBotPackageArtifact(resolved)
    const existing = this.db.query("select id from bots where tenant_id = ? and owner_subject_id = ? and source_resource_id = ? and source_version = ? and archived = 0").get(principal.tenant_id, principal.subject_id, manifest.resourceId, manifest.version) as { id?: string } | null
    if (existing?.id) {
      materializeBotPackage(resolved, existing.id)
      return this.getOwned(existing.id, principal)!
    }
    const installed = this.create(principal, {
      name: manifest.profile.title,
      title: manifest.profile.title,
      description: manifest.profile.description,
      role: manifest.profile.description,
      avatar: manifest.profile.avatar,
      skills: manifest.skills.map((skill) => skill.id),
      modelRoute: manifest.modelRoute ?? "codex-subscription",
      defaultRuntimeTier: manifest.defaultRuntimeTier,
      sourceResourceId: manifest.resourceId,
      sourceVersion: manifest.version,
      sourceDigest: manifest.artifactDigest,
      agentSubjectId,
      ownerOrganizationId: usageContext?.ownerOrganizationId ?? null,
      useCaseId: usageContext?.useCaseId ?? null,
      bindings: [
        ...manifest.skills.map((skill) => ({ resourceId: manifest.resourceId, capabilityId: `skill.${skill.id}`, version: manifest.version, artifactDigest: manifest.artifactDigest, state: "INSTALLED" as const, kind: "SKILL" as const })),
        ...manifest.plugins.map((plugin) => ({ resourceId: manifest.resourceId, capabilityId: `plugin.${plugin.name}`, version: manifest.version, artifactDigest: manifest.artifactDigest, state: "INSTALLED" as const, kind: "PLUGIN" as const })),
        ...manifest.resourceBindings.map((binding) => ({ resourceId: binding.resourceId, capabilityId: binding.capabilityId, version: manifest.version, artifactDigest: manifest.artifactDigest, state: "INSTALLED" as const, kind: "MCP" as const })),
      ],
    })
    materializeBotPackage(resolved, installed.id)
    return installed
  }

  private mapSession(row: Record<string, unknown> | null, botId: string): BotSession {
    if (!row) return defaultBotSession(botId)
    const updatedAt = Number(row.updated_at) || Date.now()
    return {
      botId: String(row.bot_id || botId),
      appServerThreadId: typeof row.app_server_thread_id === "string" ? row.app_server_thread_id : null,
      codexHomeNamespace: typeof row.codex_home_namespace === "string" ? row.codex_home_namespace : `bot/${botId}`,
      activeRuntimeTier: isRuntimeTier(row.active_runtime_tier) ? row.active_runtime_tier : "none",
      memoryPointer: typeof row.memory_pointer === "string" ? row.memory_pointer : null,
      unread: Number(row.unread) === 1,
      workState: isWorkState(row.work_state) ? row.work_state : "idle",
      updatedAt,
      lastEventAt: Number(row.last_event_at) || updatedAt,
    }
  }

  getSession(botId: string): BotSession | null {
    const row = this.db.query("select * from bot_sessions where bot_id = ?").get(botId) as Record<string, unknown> | null
    return row ? this.mapSession(row, botId) : null
  }

  getSessionThreads(botId: string): Array<{ threadId: string; firstSeenAt: number; historyStatus: string }> {
    const rows = this.db.query("select thread_id, first_seen_at, history_status from bot_session_threads where bot_id = ? order by first_seen_at, rowid").all(botId) as Array<{ thread_id: string; first_seen_at: number; history_status: string }>
    return rows.map((row) => ({ threadId: row.thread_id, firstSeenAt: row.first_seen_at, historyStatus: row.history_status }))
  }

  setThreadHistoryStatus(botId: string, threadId: string, status: "ready" | "unavailable") {
    this.db.query("update bot_session_threads set history_status = ? where bot_id = ? and thread_id = ?").run(status, botId, threadId)
  }

  rememberThread(botId: string, threadId: string) {
    this.db.query("insert or ignore into bot_session_threads (bot_id, thread_id, first_seen_at) values (?, ?, ?)").run(botId, threadId, Date.now())
  }

  ownsThread(principal: GenioPrincipal, botId: string, threadId: string) {
    return Boolean(this.getOwned(botId, principal) && this.db.query("select 1 from bot_session_threads where bot_id = ? and thread_id = ?").get(botId, threadId))
  }

  teamWorkspaceId(botId: string): string | null {
    const row = this.db.query("select team_workspace_id as id from bots where id = ?").get(botId) as { id: string | null } | null
    return row?.id ?? null
  }

  ownedBotForThread(principal: GenioPrincipal, threadId: string): string | null {
    const row = this.db.query(`select b.id as id from bots b join bot_session_threads t on t.bot_id = b.id
      where t.thread_id = ? and b.tenant_id = ? and b.owner_subject_id = ?`).get(threadId, principal.tenant_id, principal.subject_id) as { id: string } | null
    return row?.id ?? null
  }

  recordRuntimeEvent(principal: GenioPrincipal, line: string, runtimeId?: string) {
    let message
    try { message = JSON.parse(line) } catch { return }
    const threadId = message.params?.threadId
    if (typeof threadId !== "string") return
    const botId = this.ownedBotForThread(principal, threadId)
    if (botId) this.db.transaction(() => {
      const turnId = message.params?.turn?.id ?? message.params?.turnId
      const before = typeof turnId === "string" ? this.timeline.turnStatus(botId, threadId, turnId) : null
      if (runtimeId) this.interactionHistory.record(botId, runtimeId, message)
      this.timeline.record(botId, message)
      const items = message.params?.turn?.items ?? (message.method === "item/completed" ? [message.params?.item] : [])
      this.observeQuestions(botId, threadId, turnId, items)
      if (message.method === "turn/started" && before === null) this.applySessionEvent(botId, "turn_started")
      if (message.method === "turn/completed" && (before === null || before === "inProgress")) {
        const silentFyi = this.timeline.readTurn(botId, threadId, turnId).some((item) => item.clientMessageId?.startsWith("handoff-task:") && this.handoffs.isSilentFyi(item.clientMessageId.slice("handoff-task:".length)))
        this.applySessionEvent(botId, message.params?.turn?.status === "completed" ? silentFyi ? "turn_idle" : "turn_completed" : "turn_stopped")
      }
      this.continuations.observe(botId, threadId, message.method, message.params)
    })()
  }

  private observeQuestions(botId: string, threadId: string, turnId: string, items: any[]) {
    for (const item of items) {
      if (item?.type === "agentMessage" && item.delivery === "async" && item.questions?.length) {
        try { this.questions.create(botId, threadId, turnId, item.questions, item.id) }
        catch { console.warn(JSON.stringify({ event: "bot.question.invalid_native_item", bot_id: botId, thread_id: threadId, turn_id: turnId, item_id: item.id })) }
      }
    }
    this.questions.reconcile(botId, threadId, [{ id: turnId, items } as import("./generated/v2/Turn").Turn])
  }

  readTimeline(principal: GenioPrincipal, botId: string, isRuntimeLive: (id: string) => boolean = () => false) {
    if (!this.getOwned(botId, principal)) throw new Error("BOT_NOT_FOUND")
    const questions: import("../shared/bot-timeline").ChatMessage[] = this.questions.list(botId).map((question) => ({
      id: `question:${question.id}`, role: "assistant", messageType: "bot_update", text: question.title, createdAt: question.createdAt, question,
    }))
    return [...questions, ...this.timeline.read(botId, this.handoffs.listEventsForBot(principal, botId, { includeSilent: true })), ...this.interactionHistory.expired(botId, isRuntimeLive)]
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }

  importRuntimeHistory(botId: string, threadId: string, turns: Turn[], revision: number) {
    const changedTurnIds = new Set<string>()
    this.db.transaction(() => {
      if (!this.db.query("select 1 from bots where id = ?").get(botId)) return
      for (const turn of turns) {
        const before = this.timeline.storedTurn(botId, threadId, turn.id)?.revision
        this.timeline.importSnapshot(botId, threadId, turn, revision)
        const after = this.timeline.storedTurn(botId, threadId, turn.id)?.revision
        if (after !== undefined && after !== before) changedTurnIds.add(turn.id)
        this.observeQuestions(botId, threadId, turn.id, turn.items)
      }
      const current = this.getSession(botId)
      if (!current) return
      if (this.timeline.hasRunningTurns(botId)) {
        if (current.workState !== "working") this.applySessionEvent(botId, "turn_started")
      } else if (current.workState === "working") {
        const latest = this.timeline.latestTurnStatus(botId)
        if (latest === "completed") this.applySessionEvent(botId, "turn_completed")
        else if (latest === "failed" || latest === "interrupted") this.applySessionEvent(botId, "turn_stopped")
      }
    })()
    if (changedTurnIds.size === 0) return
    const event = { botId, threadId, turnIds: [...changedTurnIds] }
    for (const observer of this.historyImportObservers) {
      try { observer(event) } catch {
        console.error(JSON.stringify({
          event: "bot.history_import.observer_failed",
          bot_id: event.botId,
          thread_id: event.threadId,
          turn_count: event.turnIds.length,
          error_code: "DISTILLATION_HISTORY_REQUEUE_FAILED",
        }))
      }
    }
  }

  observeHistoryImport(observer: (event: RuntimeHistoryImport) => void) {
    this.historyImportObservers.add(observer)
    return () => { this.historyImportObservers.delete(observer) }
  }

  /** Upsert thread/memory pointer without wiping unread/work projection unless provided. */
  saveSession(input: {
    botId: string
    appServerThreadId?: string | null
    activeRuntimeTier?: RuntimeTier
    memoryPointer?: string | null
    unread?: boolean
    workState?: BotWorkState
  }): BotSession {
    const now = Date.now()
    const current = this.getSession(input.botId) ?? defaultBotSession(input.botId, now)
    const next: BotSession = {
      ...current,
      appServerThreadId: input.appServerThreadId !== undefined ? input.appServerThreadId : current.appServerThreadId,
      activeRuntimeTier: input.activeRuntimeTier ?? current.activeRuntimeTier,
      memoryPointer: input.memoryPointer !== undefined ? input.memoryPointer : current.memoryPointer,
      unread: input.unread !== undefined ? input.unread : current.unread,
      workState: input.workState ?? current.workState,
      updatedAt: now,
      lastEventAt: current.lastEventAt || now,
    }
    return this.db.transaction(() => {
      for (const session of [current, next]) {
        if (session.appServerThreadId) this.db.query("insert or ignore into bot_session_threads (bot_id, thread_id, first_seen_at) values (?, ?, ?)").run(session.botId, session.appServerThreadId, session.updatedAt)
      }
      this.db.query(`insert into bot_sessions (
        bot_id, app_server_thread_id, codex_home_namespace, active_runtime_tier, updated_at,
        unread, work_state, memory_pointer, last_event_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(bot_id) do update set
        app_server_thread_id = excluded.app_server_thread_id,
        active_runtime_tier = excluded.active_runtime_tier,
        updated_at = excluded.updated_at,
        unread = excluded.unread,
        work_state = excluded.work_state,
        memory_pointer = excluded.memory_pointer,
        last_event_at = excluded.last_event_at`).run(
        next.botId,
        next.appServerThreadId,
        next.codexHomeNamespace,
        next.activeRuntimeTier,
        next.updatedAt,
        next.unread ? 1 : 0,
        next.workState,
        next.memoryPointer,
        next.lastEventAt,
      )
      return this.getSession(input.botId)!
    })()
  }

  interruptRuntimeTurn(botId: string, threadId: string, turnId: string) {
    return this.db.transaction(() => {
      if (!this.timeline.interruptTurn(botId, threadId, turnId)) return false
      this.applySessionEvent(botId, "turn_stopped")
      return true
    })()
  }

  applySessionEvent(botId: string, type: BotSessionEventType): BotSession {
    const now = Date.now()
    const current = this.getSession(botId) ?? defaultBotSession(botId, now)
    let unread = current.unread
    let workState = current.workState
    if (type === "turn_started") workState = "working"
    else if (type === "turn_completed") {
      workState = this.timeline.hasRunningTurns(botId) ? "working" : "idle"
      unread = true
    } else if (type === "turn_stopped") {
      workState = this.timeline.hasRunningTurns(botId) ? "working" : "stopped"
      unread = true
    } else if (type === "turn_idle") workState = this.timeline.hasRunningTurns(botId) ? "working" : "idle"
    else if (type === "viewed") unread = false
    this.db.query(`insert into bot_sessions (
      bot_id, app_server_thread_id, codex_home_namespace, active_runtime_tier, updated_at,
      unread, work_state, memory_pointer, last_event_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(bot_id) do update set
      unread = excluded.unread,
      work_state = excluded.work_state,
      updated_at = excluded.updated_at,
      last_event_at = excluded.last_event_at`).run(
      botId,
      current.appServerThreadId,
      current.codexHomeNamespace,
      current.activeRuntimeTier,
      now,
      unread ? 1 : 0,
      workState,
      current.memoryPointer,
      now,
    )
    return this.getSession(botId)!
  }

  /** Roster = BotProfile list + per-bot session projection (unread/working/thread). */
  listRoster(principal: GenioPrincipal): BotRosterEntry[] {
    return this.list(principal).map((bot) => ({
      bot,
      session: this.getSession(bot.id) ?? defaultBotSession(bot.id),
      summary: this.timeline.sidebarSummary(bot.id, this.handoffs.listEventsForBot(principal, bot.id, { includeSilent: true })) ?? { preview: bot.title || bot.name },
    }))
  }

  createInvocation(principal: GenioPrincipal, input: Parameters<BotInvocationStore["createInvocation"]>[1]) {
    return this.invocations.createInvocation(principal, input)
  }

  createHandoff(principal: GenioPrincipal, input: CreateHandoffInput) {
    return this.createHandoffs(principal, input)[0]!
  }

  createHandoffs(principal: GenioPrincipal, input: CreateHandoffInput) {
    return this.db.transaction(() => {
      const requestId = input.clientRequestId
      const existing = requestId && this.db.query("select 1 from bot_handoff_requests where bot_id = ? and request_id = ?").get(input.fromBotId, requestId)
      const result = this.handoffs.createHandoffs(principal, input)
      if (requestId && !existing) this.timeline.saveProductMessage(input.fromBotId, {
        id: `handoff-source:${requestId}`, clientMessageId: requestId,
        role: input.sourceAuthor === "user" ? "user" : "assistant",
        messageType: input.sourceAuthor === "user" ? "user_message" : "bot_exchange",
        text: input.originalMessage ?? input.fact, createdAt: result[0]!.createdAt,
      })
      return result
    })()
  }

  processHandoff(principal: GenioPrincipal, handoffId: string) {
    return this.handoffs.processHandoff(principal, handoffId)
  }

  recordHandoffCallerReply(principal: GenioPrincipal, handoffId: string, reply: string) {
    return this.handoffs.recordCallerReply(principal, handoffId, reply)
  }

  listHandoffEvents(principal: GenioPrincipal, botId: string, opts?: { includeSilent?: boolean }) {
    return this.handoffs.listEventsForBot(principal, botId, opts)
  }

  getHandoff(principal: GenioPrincipal, handoffId: string) {
    return this.handoffs.getHandoff(principal, handoffId)
  }

  createGroup(principal: GenioPrincipal, input: CreateGroupInput) {
    return this.groups.createGroup(principal, input)
  }

  listGroups(principal: GenioPrincipal) {
    return this.groups.listGroups(principal)
  }

  updateGroupMembers(principal: GenioPrincipal, groupId: string, memberBotIds: string[]) {
    return this.groups.updateGroupMembers(principal, groupId, memberBotIds)
  }

  getGroup(principal: GenioPrincipal, groupId: string) {
    return this.groups.getGroup(principal, groupId)
  }


  listInvocations(principal: GenioPrincipal, role: "caller" | "owner" = "caller") {
    this.expirePendingInvocations()
    return this.invocations.listInvocations(principal, role)
  }

  expirePendingInvocations() {
    this.db.transaction(() => {
      for (const result of this.invocations.expirePendingInvocations()) {
        this.handoffs.recordInvocationOutcome(result.requestId, result.state, "交接的核准期限已過。")
        this.continuations.enqueue(result)
      }
    })()
  }

  decideInvocation(principal: GenioPrincipal, requestId: string, decision: "APPROVE" | "DENY", reason = "") {
    return this.db.transaction(() => {
      const result = this.invocations.decideInvocation(principal, requestId, decision, reason)
      if (result.state === "DENIED" || result.state === "EXPIRED") {
        this.handoffs.recordInvocationOutcome(requestId, result.state, result.state === "DENIED" ? "這次交接未獲核准。" : "交接的核准期限已過。")
        this.continuations.enqueue(result)
      }
      return result
    })()
  }

  beginInvocation(requestId: string) {
    return this.db.transaction(() => {
      const started = this.invocations.beginInvocation(requestId)
      const result = this.invocations.getInvocationForService(requestId)
      if (started?.state === "RUNNING") this.handoffs.deliverInvocation(requestId)
      if (result?.state === "DENIED" || result?.state === "EXPIRED") {
        this.handoffs.recordInvocationOutcome(requestId, result.state, "交接授權已失效，工作未啟動。")
        this.continuations.enqueue(result)
      }
      return started
    })()
  }

  getInvocationForService(requestId: string): BotInvocationRequest | null {
    return this.invocations.getInvocationForService(requestId)
  }

  completeInvocation(requestId: string, resultSummary: string, artifactRefs: string[] = []) {
    this.db.transaction(() => {
      this.invocations.completeInvocation(requestId, resultSummary, artifactRefs)
      const result = this.invocations.getInvocationForService(requestId)
      if (result) this.continuations.enqueue(result)
      if (result) this.handoffs.recordInvocationOutcome(requestId, result.state, result.resultSummary ?? result.decisionReason ?? "")
    })()
  }

  failInvocation(requestId: string, reason: string, summary: string) {
    this.db.transaction(() => {
      this.invocations.failInvocation(requestId, reason, summary)
      const result = this.invocations.getInvocationForService(requestId)
      if (result) this.continuations.enqueue(result)
      if (result) this.handoffs.recordInvocationOutcome(requestId, result.state, result.resultSummary ?? result.decisionReason ?? "")
    })()
  }

  denyInvocationForService(requestId: string, reason: string) {
    this.db.transaction(() => {
      this.invocations.denyInvocationForService(requestId, reason)
      const result = this.invocations.getInvocationForService(requestId)
      if (result?.state === "DENIED") {
        this.handoffs.recordInvocationOutcome(requestId, "DENIED", "交接所需的授權或連線已不可用。")
        this.continuations.enqueue(result)
      }
    })()
  }

  artifactStoragePath(artifactId: string) {
    return this.artifacts.artifactStoragePath(artifactId)
  }

  storeArtifactBytes(artifactId: string, bytes: Uint8Array) {
    return this.artifacts.storeArtifactBytes(artifactId, bytes)
  }

  readArtifactBytes(artifactId: string) {
    return this.artifacts.readArtifactBytes(artifactId)
  }

  registerArtifact(principal: GenioPrincipal, input: Parameters<BotArtifactStore["registerArtifact"]>[1]) {
    return this.artifacts.registerArtifact(principal, input)
  }

  listArtifacts(principal: GenioPrincipal, botId: string) {
    return this.artifacts.listArtifacts(principal, botId)
  }

  getArtifact(principal: GenioPrincipal, botId: string, artifactId: string) {
    return this.artifacts.getArtifact(principal, botId, artifactId)
  }

  private replaceBindings(botId: string, bindings: Array<Partial<BotBinding> & Pick<BotBinding, "resourceId" | "capabilityId">>) {
    this.db.query("delete from bot_bindings where bot_id = ?").run(botId)
    for (const binding of bindings) {
      this.db.query(`insert into bot_bindings (id, bot_id, resource_id, capability_id, version, artifact_digest, state, kind, skill_id, approval_policy_ref, reason)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        `binding-${randomUUID()}`,
        botId,
        binding.resourceId,
        binding.capabilityId,
        binding.version ?? "1.0.0",
        binding.artifactDigest ?? null,
        binding.state ?? "INSTALLED",
        binding.kind ?? "MCP",
        binding.skillId ?? null,
        binding.approvalPolicyRef ?? null,
        binding.reason ?? null,
      )
    }
  }

  listBindings(botId: string, principal: GenioPrincipal): BotBinding[] {
    const bot = this.getOwned(botId, principal)
    if (!bot) throw new Error("BOT_NOT_FOUND")
    return bot.bindings
  }

  removeBindingsForResource(botId: string, principal: GenioPrincipal, resourceId: string): number {
    const bot = this.getOwned(botId, principal)
    if (!bot) throw new Error("BOT_NOT_FOUND")
    const removedCount = bot.bindings.filter((binding) => binding.resourceId === resourceId).length
    if (removedCount === 0) return 0
    const runTransaction = this.db.transaction(() => {
      this.db.query("delete from bot_bindings where bot_id = ? and resource_id = ?").run(botId, resourceId)
      this.db.query("update bots set updated_at = ? where id = ?").run(Date.now(), botId)
    })
    runTransaction()
    return removedCount
  }

  /**
   * Upsert one BotBinding projection. Does not grant Gateway/One Policy access.
   */
  upsertBinding(
    botId: string,
    principal: GenioPrincipal,
    input: Partial<BotBinding> & Pick<BotBinding, "resourceId" | "capabilityId">,
  ): BotBinding {
    const bot = this.getOwned(botId, principal)
    if (!bot) throw new Error("BOT_NOT_FOUND")
    const existing = bot.bindings.find(
      (b) => b.resourceId === input.resourceId && b.capabilityId === input.capabilityId,
    )
    const id = existing?.id ?? `binding-${randomUUID()}`
    const version = input.version ?? existing?.version ?? "1.0.0"
    const artifactDigest = input.artifactDigest !== undefined ? input.artifactDigest : (existing?.artifactDigest ?? null)
    const state = input.state ?? existing?.state ?? "INSTALLED"
    const kind = input.kind ?? existing?.kind ?? "MCP"
    const skillId = input.skillId !== undefined ? input.skillId : (existing?.skillId ?? null)
    const approvalPolicyRef = input.approvalPolicyRef !== undefined ? input.approvalPolicyRef : (existing?.approvalPolicyRef ?? null)
    const reason = input.reason !== undefined ? input.reason : (existing?.reason ?? null)
    this.db.query("delete from bot_bindings where bot_id = ? and resource_id = ? and capability_id = ?").run(
      botId, input.resourceId, input.capabilityId,
    )
    this.db.query(`insert into bot_bindings (id, bot_id, resource_id, capability_id, version, artifact_digest, state, kind, skill_id, approval_policy_ref, reason)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, botId, input.resourceId, input.capabilityId, version, artifactDigest, state, kind, skillId, approvalPolicyRef, reason,
    )
    this.db.query("update bots set updated_at = ? where id = ?").run(Date.now(), botId)
    const updated = this.getOwned(botId, principal)!
    const binding = updated.bindings.find((b) => b.resourceId === input.resourceId && b.capabilityId === input.capabilityId)
    if (!binding) throw new Error("BOT_BINDING_UPSERT_FAILED")
    return binding
  }

  private mapBot(row: Record<string, unknown>, preloadedBindings?: BotBinding[]): BotRecord {
    const id = String(row.id)
    const bindings = preloadedBindings ?? (this.db.query("select * from bot_bindings where bot_id = ? order by resource_id, capability_id").all(id) as Record<string, unknown>[]).map((binding) => ({
      id: String(binding.id),
      botId: id,
      resourceId: String(binding.resource_id),
      capabilityId: String(binding.capability_id),
      version: String(binding.version),
      artifactDigest: typeof binding.artifact_digest === "string" ? binding.artifact_digest : null,
      state: binding.state as BotBinding["state"],
      kind: binding.kind as BotBinding["kind"],
      skillId: typeof binding.skill_id === "string" ? binding.skill_id : null,
      approvalPolicyRef: typeof binding.approval_policy_ref === "string" ? binding.approval_policy_ref : null,
      reason: typeof binding.reason === "string" ? binding.reason : null,
    }))
    const role = String(row.role ?? row.description ?? "企業營運夥伴")
    return {
      id,
      botId: id,
      tenantId: String(row.tenant_id),
      ownerSubjectId: String(row.owner_subject_id),
      agentSubjectId: String(row.agent_subject_id),
      ownerOrganizationId: typeof row.owner_organization_id === "string" ? row.owner_organization_id : null,
      useCaseId: typeof row.use_case_id === "string" ? row.use_case_id : null,
      teamWorkspaceId: typeof row.team_workspace_id === "string" ? row.team_workspace_id : null,
      name: String(row.name),
      role,
      title: String(row.title ?? role),
      description: String(row.description ?? role),
      antiJobs: typeof row.anti_jobs === "string" ? row.anti_jobs : "",
      voice: typeof row.voice === "string" ? row.voice : "",
      wake: row.wake === "chat" || row.wake === "routine" || row.wake === "both" ? row.wake : "",
      avatar: parseJson(row.avatar_json, null),
      workspacePath: String(row.workspace_path),
      skills: stringArray(parseJson(row.skills_json, [])),
      allowedTools: row.allowed_tools_json ? stringArray(parseJson(row.allowed_tools_json, [])) : undefined,
      modelRoute: row.model_route === "genio-gateway" ? "genio-gateway" : "codex-subscription",
      defaultRuntimeTier: isRuntimeTier(row.default_runtime_tier) ? row.default_runtime_tier : "none",
      sharePolicy: normalizeSharePolicy(parseJson(row.share_policy_json, DEFAULT_SHARE_POLICY)),
      sourceResourceId: typeof row.source_resource_id === "string" ? row.source_resource_id : null,
      sourceVersion: typeof row.source_version === "string" ? row.source_version : null,
      sourceDigest: typeof row.source_digest === "string" ? row.source_digest : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      revision: Number(row.profile_revision) || 1,
      archived: Number(row.archived) === 1,
      bindings,
    }
  }

  private writeProfileRevision(bot: BotRecord) {
    this.db.query(`insert into bot_profile_revisions (bot_id, revision, profile_json, created_at) values (?, ?, ?, ?)
      on conflict(bot_id, revision) do update set profile_json = excluded.profile_json, created_at = excluded.created_at`).run(
      bot.id,
      bot.revision,
      JSON.stringify(selfProfileSnapshot(bot)),
      bot.updatedAt,
    )
  }
}
