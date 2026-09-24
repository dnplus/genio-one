import { browserObserver } from "./browser-telemetry"
import type { BotInstance, BotSharePolicy, RuntimeTier } from "../bots-storage"
import type { BotMemory, BotMemoryKind } from "../../shared/bot-memory"
import type { BotSidebarSummary } from "../../shared/bot-roster"
import type { RuntimePolicySnapshot } from "../../server/runtime-policy-contract"

export type { RuntimePolicyDecision, RuntimePolicySnapshot } from "../../server/runtime-policy-contract"

export function getBotMemory(token: string, botId: string, includeForgotten = false) {
  return request<BotMemory[]>(token, `/api/bots/${encodeURIComponent(botId)}/memory?includeForgotten=${includeForgotten}`, { cache: "no-store" })
}

export function saveBotMemory(token: string, botId: string, input: { key: string; content: string; kind: BotMemoryKind; expectedRevision?: number; sourceMessageIds?: string[] }) {
  return request<BotMemory>(token, `/api/bots/${encodeURIComponent(botId)}/memory`, { method: "POST", body: JSON.stringify(input) })
}

export function forgetBotMemory(token: string, botId: string, memory: BotMemory, forgotten: boolean) {
  return request<BotMemory>(token, `/api/bots/${encodeURIComponent(botId)}/memory/${encodeURIComponent(memory.id)}`, { method: "PATCH", body: JSON.stringify({ forgotten, expectedRevision: memory.revision }) })
}

export interface BotPackageManifest {
  packageType: "BOT"
  resourceId: string
  version: string
  profile: { title: string; description: string; avatar: unknown }
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

export interface CeDemoTaskDto {
  id: "documents" | "spec-and-diagram" | "interviews"
  title: string
  modelRoute: "codex-subscription" | "genio-gateway"
  resourceId: string
  manifest: BotPackageManifest
  useCaseId?: string
}

export interface BotInvocationRequest {
  requestId: string
  tenantId: string
  callerSubjectId: string
  callerBotId: string
  targetOwnerSubjectId: string
  targetBotId: string
  targetAgentSubjectId: string
  task: string
  selectedContextRefs: string[]
  requestedCapabilityIds: string[]
  actionDigest: string
  state: "PENDING" | "APPROVED" | "DENIED" | "RUNNING" | "COMPLETED" | "FAILED" | "EXPIRED"
  decisionReason: string | null
  expiresAt: number
  createdAt: number
  decidedAt: number | null
  resultSummary: string | null
  artifactRefs: string[]
}

export interface ArtifactRef {
  artifactId: string
  tenantId: string
  botId: string
  sourceTier: Exclude<RuntimeTier, "none"> | "isolate"
  sourceEnvironmentId: string
  path: string
  digest: string
  contentType: string
  size: number
  storageProvider: "e2b-self-hosted" | "cloudflare-hands"
  sourceWorkspaceId: string | null
  sourceRevision: number | null
  storageRef: string | null
  createdAt: number
}

export type BotWorkState = "idle" | "working" | "stopped"

export interface BotSessionDto {
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

export interface BotRosterEntryDto {
  bot: BotInstance
  session: BotSessionDto
  summary: BotSidebarSummary
}

export type BotSessionEventType = "viewed"

async function request<T>(token: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("accept", "application/json")
  headers.set("authorization", `Bearer ${token}`)
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
  const response = await browserObserver.fetch(path, { ...init, headers })
  const text = await response.text()
  let value: unknown = null
  try { value = text ? JSON.parse(text) : null } catch {}
  if (!response.ok) {
    const error = value && typeof value === "object" && typeof (value as { error?: unknown }).error === "string"
      ? (value as { error: string }).error
      : `BOT_API_${response.status}`
    throw new Error(error)
  }
  return value as T
}

export interface BotProfileDto {
  botId: string
  revision: number
  name: string
  title: string
  description: string
  antiJobs: string
  voice: string
  wake: "chat" | "routine" | "both" | ""
  visibility: "PRIVATE" | "SELECTED" | "TEAM" | "ORG"
  avatar: unknown
  modelRoute: "codex-subscription" | "genio-gateway"
  tenantId: string
  ownerSubjectId: string
  createdAt: number
  updatedAt: number
}

export async function listBots(token: string) {
  return request<BotInstance[]>(token, "/api/bots")
}

export async function getBotProfile(token: string, botId: string) {
  return request<BotProfileDto>(token, `/api/bots/${encodeURIComponent(botId)}`)
}

export async function createBot(token: string, input: {
  name: string
  title: string
  description: string
  antiJobs?: string
  voice?: string
  wake?: "chat" | "routine" | "both" | ""
  avatar: unknown
  skills?: string[]
  allowedTools?: string[]
  modelRoute?: "codex-subscription" | "genio-gateway"
  defaultRuntimeTier?: RuntimeTier
  /** @deprecated prefer description */
  role?: string
}) {
  return request<BotInstance>(token, "/api/bots", { method: "POST", body: JSON.stringify(input) })
}

export async function updateBot(token: string, botId: string, input: {
  expectedRevision?: number
  name?: string
  title?: string
  description?: string
  antiJobs?: string
  voice?: string
  wake?: "chat" | "routine" | "both" | ""
  /** @deprecated prefer description */
  role?: string
  avatar?: unknown
  skills?: string[]
  allowedTools?: string[]
  modelRoute?: "codex-subscription" | "genio-gateway"
  defaultRuntimeTier?: RuntimeTier
  sharePolicy?: Partial<BotSharePolicy>
}) {
  return request<BotInstance>(token, `/api/bots/${encodeURIComponent(botId)}`, { method: "PATCH", body: JSON.stringify(input) })
}

export async function duplicateBot(token: string, botId: string) {
  return request<BotInstance>(token, `/api/bots/${encodeURIComponent(botId)}/duplicate`, { method: "POST" })
}

export async function deleteBot(token: string, botId: string) {
  return request<{ ok: boolean; botId: string }>(token, `/api/bots/${encodeURIComponent(botId)}`, { method: "DELETE" })
}

export async function listBotRoster(token: string) {
  return request<BotRosterEntryDto[]>(token, "/api/bots/roster")
}

export async function getBotSession(token: string, botId: string) {
  return request<BotSessionDto | null>(token, `/api/bots/${encodeURIComponent(botId)}/session`)
}

export async function getBotTimeline(token: string, botId: string) {
  return (await getBotTimelineSnapshot(token, botId)).messages
}

export async function getBotTimelineSnapshot(token: string, botId: string) {
  const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/timeline`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } })
  if (!response.ok) throw new Error("BOT_TIMELINE_UNAVAILABLE")
  return { messages: await response.json() as import("../bots-storage").ChatMessage[], version: response.headers.get("etag") }
}

export async function importLegacyBotHistory(token: string, botId: string, entries: import("../../shared/legacy-history").LegacyHistoryEntry[]) {
  return request<{ imported: number }>(token, `/api/bots/${encodeURIComponent(botId)}/timeline/legacy-import`, { method: "POST", body: JSON.stringify(entries) })
}

export async function getBotExecutionSegments(token: string, botId: string) {
  return request<Array<{ threadId: string; historyStatus: string }>>(token, `/api/bots/${encodeURIComponent(botId)}/execution-segments`)
}

export async function saveBotSession(token: string, botId: string, input: {
  appServerThreadId?: string | null
  activeRuntimeTier?: RuntimeTier
  memoryPointer?: string | null
}) {
  return request<BotSessionDto>(token, `/api/bots/${encodeURIComponent(botId)}/session`, {
    method: "PUT",
    body: JSON.stringify(input),
  })
}

export async function postBotSessionEvent(token: string, botId: string, type: BotSessionEventType, version: string) {
  return request<BotSessionDto>(token, `/api/bots/${encodeURIComponent(botId)}/session/events`, {
    method: "POST",
    body: JSON.stringify({ type, version }),
  })
}

export async function listBotArtifacts(token: string, botId: string) {
  return request<ArtifactRef[]>(token, `/api/bots/${encodeURIComponent(botId)}/artifacts`)
}

export async function registerBotArtifactFromRuntime(token: string, botId: string, input: {
  sourceTier: Exclude<RuntimeTier, "none">
  sourceEnvironmentId: string
  path: string
  contentType?: string
} | {
  sourceTier: "isolate"
  sourceWorkspaceId: string
  path: string
  contentType?: string
}) {
  return request<ArtifactRef>(token, `/api/bots/${encodeURIComponent(botId)}/artifacts/from-runtime`, {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export async function registerBotArtifact(token: string, botId: string, input: Omit<ArtifactRef, "artifactId" | "tenantId" | "botId" | "createdAt">) {
  return request<ArtifactRef>(token, `/api/bots/${encodeURIComponent(botId)}/artifacts`, {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export async function importBotArtifact(token: string, botId: string, artifactId: string, targetTier: Exclude<RuntimeTier, "none">, options: { targetEnvironmentId?: string; targetPath?: string; open?: boolean } = {}) {
  return request<{ artifact: ArtifactRef; targetTier: Exclude<RuntimeTier, "none">; targetPath: string; imported: boolean; opened: boolean }>(token, `/api/bots/${encodeURIComponent(botId)}/artifacts/${encodeURIComponent(artifactId)}/import`, {
    method: "POST",
    body: JSON.stringify({ targetTier, ...options }),
  })
}


export type CatalogAddState = "AUTO_GRANT" | "ENTITLED" | "REQUEST" | "NEEDS_CONNECTION" | "CONNECTED" | "DENIED"

export interface CatalogAddRow {
  builtinService?: string | null
  resourceId: string
  capabilityId: string
  resourceDisplayName: string
  capabilityDisplayName: string
  addState: CatalogAddState
  connectionStatus: "CONNECTED" | "AVAILABLE" | "NEEDS_CONNECTION"
  reason: string
  approvalPolicyRef: string | null
  skillId: string | null
  installBinding: boolean
  pendingBinding: boolean
  usableFromCatalogAlone: false
  binding: import("../bots-storage").BotBinding | null
}

export async function listBotBindings(token: string, botId: string) {
  return request<import("../bots-storage").BotBinding[]>(token, `/api/bots/${encodeURIComponent(botId)}/bindings`)
}

export async function removeBotBindings(token: string, botId: string, resourceId: string) {
  return request<{ botId: string; resourceId: string; removedCount: number }>(
    token,
    `/api/bots/${encodeURIComponent(botId)}/bindings/${encodeURIComponent(resourceId)}`,
    { method: "DELETE" },
  )
}

export async function getBotCatalogAdd(token: string, botId: string) {
  return request<{ botId: string; bindings: import("../bots-storage").BotBinding[]; catalog: CatalogAddRow[] }>(
    token,
    `/api/bots/${encodeURIComponent(botId)}/catalog-add`,
  )
}

export async function getBotRuntimePolicy(token: string, botId: string) {
  return request<RuntimePolicySnapshot>(token, `/api/bots/${encodeURIComponent(botId)}/runtime-policy`)
}

export async function addBotBinding(
  token: string,
  botId: string,
  input: { resourceId: string; capabilityId: string; skillId?: string; approvalPolicyRef?: string; version?: string; kind?: string },
) {
  return request<{
    addState: CatalogAddState
    reason: string
    binding: import("../bots-storage").BotBinding
    note: string
  }>(token, `/api/bots/${encodeURIComponent(botId)}/bindings/add`, {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export async function listBotPackages(token: string) {
  return request<BotPackageManifest[]>(token, "/api/bot-catalog")
}

export async function installBotPackage(token: string, resourceId: string, version?: string, useCaseId?: string) {
  return request<BotInstance>(token, "/api/bots/install", { method: "POST", body: JSON.stringify({ resourceId, version, ...(useCaseId ? { useCaseId } : {}) }) })
}

export async function getCeDemoTask(token: string, taskId: CeDemoTaskDto["id"]) {
  return request<CeDemoTaskDto>(token, `/api/ce-demo/tasks/${encodeURIComponent(taskId)}`)
}

export async function requestBotPackageAccess(token: string, tenantId: string, packageInfo: BotPackageManifest) {
  const requests = []
  for (const binding of packageInfo.resourceBindings) {
    requests.push(await request<unknown>(token, `/v1/tenants/${encodeURIComponent(tenantId)}/access-requests`, {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `bot-package-${packageInfo.resourceId}-${packageInfo.version}-${crypto.randomUUID()}`,
        resource_id: binding.resourceId,
        capability_id: binding.capabilityId,
        justification: `Install enterprise Bot package ${packageInfo.profile.title} v${packageInfo.version}`,
        requested_valid_for_seconds: 3600,
      }),
    }))
  }
  if (requests.length === 0) throw new Error("BOT_ACCESS_REQUEST_NOT_AVAILABLE")
  return requests
}

export async function listInvocations(token: string, role: "caller" | "owner") {
  return request<BotInvocationRequest[]>(token, `/api/bot-invocations?role=${role}`)
}

export async function createInvocation(token: string, input: {
  callerBotId: string
  targetBotId: string
  task: string
  selectedContextRefs: string[]
  requestedCapabilityIds: string[]
}) {
  const canonical = JSON.stringify({
    callerBotId: input.callerBotId,
    targetBotId: input.targetBotId,
    task: input.task,
    selectedContextRefs: input.selectedContextRefs,
    requestedCapabilityIds: input.requestedCapabilityIds,
  })
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  const actionDigest = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return request<BotInvocationRequest>(token, "/api/bot-invocations", { method: "POST", body: JSON.stringify({
    ...input,
    actionDigest,
  }) })
}

export async function decideInvocation(token: string, requestId: string, decision: "APPROVE" | "DENY", reason = "") {
  return request<BotInvocationRequest>(token, `/api/bot-invocations/${encodeURIComponent(requestId)}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision, reason }),
  })
}

export type BotHandoffEventDto = import("../../server/bot-handoff").BotHandoffEvent

export interface BotHandoffAckDto {
  handoffId: string
  invocationId: string
  state: "ACKED" | "QUEUED" | "PENDING_APPROVAL"
  kind: "task" | "fyi"
  visibility: "visible" | "silent"
  fromBotId: string
  toBotId: string
  fact: string
  summary: string
  async: true
  processed: false
  events: BotHandoffEventDto[]
  createdAt: number
}

export async function createBotHandoff(token: string, input: {
  clientRequestId?: string
  originalMessage?: string
  fromBotId: string
  toBotId?: string
  toBotIds?: string[]
  fanOutExplicit?: boolean
  fact: string
  kind?: "task" | "fyi"
  visibility?: "visible" | "silent"
}) {
  return request<BotHandoffAckDto | { acks: BotHandoffAckDto[]; async: true; processed: false }>(
    token,
    "/api/bot-handoffs",
    { method: "POST", body: JSON.stringify(input) },
  )
}

export async function processBotHandoff(token: string, handoffId: string) {
  return request<{
    handoffId: string
    processed: boolean
    state: string
    events: BotHandoffEventDto[]
    reply?: string
  }>(
    token,
    `/api/bot-handoffs/${encodeURIComponent(handoffId)}/process`,
    { method: "POST", body: "{}" },
  )
}

export async function listBotHandoffEvents(token: string, botId: string, includeSilent = false) {
  const q = includeSilent ? "?includeSilent=1" : ""
  return request<BotHandoffEventDto[]>(token, `/api/bots/${encodeURIComponent(botId)}/handoff-events${q}`)
}

export async function startAccountOAuth(token: string, resourceId: string) {
  return request<{
    status: "CONNECTED" | "NEEDS_CONNECTION" | "FAILED"
    provider: "platform"
    connectionId?: string
    state?: string
    alreadyConnected?: boolean
    addState: "CONNECTED" | "NEEDS_CONNECTION"
    authorizationUrl?: string
    expiresAt?: number
  }>(token, `/api/connections/${encodeURIComponent(resourceId)}/oauth/start`, {
    method: "POST",
    body: "{}",
  })
}

export async function getAccountOAuthStatus(token: string, resourceId: string, connectionId: string) {
  return request<{
    status: "CONNECTED" | "NEEDS_CONNECTION"
    provider: "platform"
    connectionId: string
    addState: "CONNECTED" | "NEEDS_CONNECTION"
  }>(token, `/api/connections/${encodeURIComponent(resourceId)}/oauth/status?connectionId=${encodeURIComponent(connectionId)}`)
}

export interface BotGroupDto {
  groupId: string
  tenantId: string
  ownerSubjectId: string
  name: string
  memberBotIds: string[]
  createdAt: number
  updatedAt: number
}

export async function createBotGroup(token: string, input: { name: string; memberBotIds: string[] }) {
  return request<BotGroupDto>(token, "/api/bot-groups", { method: "POST", body: JSON.stringify(input) })
}

export async function listBotGroups(token: string) {
  return request<BotGroupDto[]>(token, "/api/bot-groups")
}

export async function updateBotGroupMembers(token: string, groupId: string, memberBotIds: string[]) {
  return request<BotGroupDto>(token, `/api/bot-groups/${encodeURIComponent(groupId)}`, {
    method: "PATCH",
    body: JSON.stringify({ memberBotIds }),
  })
}

export async function actOnBotQuestion(token: string, question: import("../../shared/bot-question").BotQuestion, action: "answer" | "dismiss" | "retry", answer?: string, clientAnswerId?: string) {
  return request<import("../../shared/bot-question").BotQuestion>(token, `/api/bots/${encodeURIComponent(question.botId)}/questions/${encodeURIComponent(question.id)}/${action}`, {
    method: "POST", body: JSON.stringify({ questionRevision: question.revision, answer, clientAnswerId }),
  })
}
