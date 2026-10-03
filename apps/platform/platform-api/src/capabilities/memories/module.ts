import { createHash, createHmac, hkdfSync } from "node:crypto"

import { PlatformApiError } from "../errors"
import type { Principal } from "../tenancy-auth/contract"
import type {
  MemoryScope,
  MemoryTargetContextResult,
  MemoryTargetRetrieve,
  MemoryTargetSelector,
  PersonalMemoryAgentGrant,
  PersonalMemoryAgentList,
  PersonalMemoryCommand,
  PersonalMemoryDelete,
  PersonalMemoryEnableAgent,
  PersonalMemoryList,
  PersonalMemoryRetrieve,
  SharedMemory,
  SharedMemoryAssertionOrigin,
  SharedMemoryCorrectionProposal,
  SharedMemoryCorrectionProposalCommand,
  SharedMemoryCorrectionProposalList,
  SharedMemoryCorrectionProposalReviewAction,
  SharedMemoryCorrectionProposalReviewResult,
  SharedMemoryContext,
  SharedMemoryContextResult,
  SharedMemoryDeletion,
  SharedMemoryKind,
  SharedMemoryScope,
  SharedMemorySource,
  SharedMemoryWriteResult,
} from "./contract"
import type {
  SharedMemoryScopePermission,
  SharedMemoryScopeSelector,
} from "./shared-scope-access"

export interface SharedMemoryScopeTarget {
  scope: SharedMemoryScope
  ownerSubjectId: string | null
  teamId: string | null
  organizationId: string | null
}

export interface SharedMemoryPagePosition {
  updatedAt: number
  memoryId: string
}

export interface PersonalMemoryAgentPagePosition {
  enabledAt: number
  agentId: string
}

export interface SharedMemoryCorrectionProposalPagePosition {
  createdAt: number
  proposalId: string
}

export interface SharedMemoryWriteInput {
  target: SharedMemoryScopeTarget
  tenantId: string
  memoryId: string | null
  expectedRevision: number
  idempotencyKeyDigest: string
  requestDigest: string
  key: string
  kind: SharedMemoryKind
  context: SharedMemoryContext
  content: string
  assertionOrigin: SharedMemoryAssertionOrigin
  source: SharedMemorySource
}

export interface SharedMemoryDeleteInput {
  target: SharedMemoryScopeTarget
  tenantId: string
  memoryId: string
  expectedRevision: number
  idempotencyKeyDigest: string
  requestDigest: string
  actorSubjectId: string
  clientId: string
  agentId: string | null
  agentGrantId: string | null
  assertionOrigin: SharedMemoryAssertionOrigin
}

export interface SharedMemoryListInput {
  target: SharedMemoryScopeTarget
  tenantId: string
  limit: number
  position: SharedMemoryPagePosition | null
  contexts: readonly SharedMemoryContext[] | null
  query: string | null
  keys?: readonly string[] | null
}

export interface SharedMemoryCorrectionProposalCreateInput {
  tenantId: string
  target: SharedMemoryScopeTarget
  memoryId: string
  baseRevision: number
  proposedKind: SharedMemoryKind
  proposedContent: string
  idempotencyKeyDigest: string
  requestDigest: string
  source: SharedMemorySource
}

export interface SharedMemoryCorrectionProposalListInput {
  tenantId: string
  target: SharedMemoryScopeTarget
  memoryId: string
  limit: number
  position: SharedMemoryCorrectionProposalPagePosition | null
  status: SharedMemoryCorrectionProposal["status"] | null
}

export interface SharedMemoryCorrectionProposalReviewInput {
  tenantId: string
  target: SharedMemoryScopeTarget
  memoryId: string
  proposalId: string
  reviewerSubjectId: string
  reviewerClientId: string
  action: SharedMemoryCorrectionProposalReviewAction
}

export interface AuthorizedSharedMemoryScope {
  target: SharedMemoryScopeTarget
  canManage: boolean
}

export interface SharedMemoryScopeAuthorizationInput {
  actor: Principal
  selector: SharedMemoryScopeSelector
  permission: SharedMemoryScopePermission
}

export interface AuthorizedSharedMemoryRepository {
  remember(input: SharedMemoryWriteInput): Promise<SharedMemory>
  get(input: {
    tenantId: string
    target: SharedMemoryScopeTarget
    memoryId: string
  }): Promise<SharedMemory | null>
  list(input: SharedMemoryListInput): Promise<SharedMemory[]>
  delete(input: SharedMemoryDeleteInput): Promise<SharedMemoryDeletion>
  createCorrectionProposal(input: SharedMemoryCorrectionProposalCreateInput): Promise<SharedMemoryCorrectionProposal>
  listCorrectionProposals(input: SharedMemoryCorrectionProposalListInput): Promise<SharedMemoryCorrectionProposal[]>
  reviewCorrectionProposal(input: SharedMemoryCorrectionProposalReviewInput): Promise<SharedMemoryCorrectionProposalReviewResult>
  listMemoryScopes(input: { actor: Principal }): Promise<MemoryScope[]>
}

export interface ActivePersonalMemoryAgentRepository extends AuthorizedSharedMemoryRepository {
  withAuthorizedSharedScope<T>(
    input: SharedMemoryScopeAuthorizationInput,
    operation: (
      scope: AuthorizedSharedMemoryScope,
      repository: AuthorizedSharedMemoryRepository,
    ) => Promise<T>,
  ): Promise<T>
}

export interface SharedMemoryRepository extends AuthorizedSharedMemoryRepository {
  enablePersonalAgent(input: {
    tenantId: string
    ownerSubjectId: string
    agentId: string
  }): Promise<PersonalMemoryAgentGrant>
  getPersonalAgent(input: {
    tenantId: string
    ownerSubjectId: string
    agentId: string
  }): Promise<PersonalMemoryAgentGrant | null>
  listPersonalAgents(input: {
    tenantId: string
    ownerSubjectId: string
    limit: number
    position: PersonalMemoryAgentPagePosition | null
  }): Promise<PersonalMemoryAgentGrant[]>
  revokePersonalAgent(input: {
    tenantId: string
    ownerSubjectId: string
    agentId: string
  }): Promise<PersonalMemoryAgentGrant>
  activePersonalAgent(input: {
    tenantId: string
    ownerSubjectId: string
    agentId: string
  }): Promise<PersonalMemoryAgentGrant | null>
  withActivePersonalAgent<T>(
    input: {
      tenantId: string
      ownerSubjectId: string
      agentId: string
    },
    operation: (
      grant: PersonalMemoryAgentGrant,
      repository: ActivePersonalMemoryAgentRepository,
    ) => Promise<T>,
  ): Promise<T>
  withAuthorizedSharedScope<T>(
    input: SharedMemoryScopeAuthorizationInput,
    operation: (
      scope: AuthorizedSharedMemoryScope,
      repository: AuthorizedSharedMemoryRepository,
    ) => Promise<T>,
  ): Promise<T>
}

export interface VerifiedPersonalMemoryGrantor {
  actor: Principal
  management_authorized: true
  person_subject: true
}

export interface SharedMemoryDirectory {
  enablePersonalAgent(
    actor: Principal,
    grantor: VerifiedPersonalMemoryGrantor,
    input: PersonalMemoryEnableAgent,
  ): Promise<PersonalMemoryAgentGrant>
  listPersonalAgents(
    actor: Principal,
    input?: PersonalMemoryAgentList,
  ): Promise<{ agents: PersonalMemoryAgentGrant[]; next_cursor: string | null }>
  getPersonalAgent(actor: Principal, agentId: string): Promise<PersonalMemoryAgentGrant | null>
  revokePersonalAgent(
    actor: Principal,
    grantor: VerifiedPersonalMemoryGrantor,
    input: { agent_id: string },
  ): Promise<PersonalMemoryAgentGrant>
  rememberPersonal(actor: Principal, input: PersonalMemoryCommand): Promise<SharedMemory>
  rememberPersonalAsAgent(
    actor: Principal,
    input: PersonalMemoryCommand,
  ): Promise<SharedMemory>
  getPersonal(actor: Principal, memoryId: string): Promise<SharedMemory>
  getPersonalAsAgent(actor: Principal, memoryId: string): Promise<SharedMemory>
  listPersonal(
    actor: Principal,
    input?: PersonalMemoryList,
  ): Promise<{ memories: SharedMemory[]; next_cursor: string | null }>
  listPersonalAsAgent(
    actor: Principal,
    input?: PersonalMemoryList,
  ): Promise<{ memories: SharedMemory[]; next_cursor: string | null }>
  retrievePersonal(
    actor: Principal,
    input: PersonalMemoryRetrieve,
  ): Promise<SharedMemoryContextResult>
  retrievePersonalAsAgent(
    actor: Principal,
    input: PersonalMemoryRetrieve,
  ): Promise<SharedMemoryContextResult>
  deletePersonal(actor: Principal, input: PersonalMemoryDelete): Promise<SharedMemoryDeletion>
  deletePersonalAsAgent(actor: Principal, input: PersonalMemoryDelete): Promise<SharedMemoryDeletion>
  listMemoryScopes(actor: Principal): Promise<MemoryScope[]>
  listMemoryScopesAsAgent(actor: Principal): Promise<MemoryScope[]>
  listShared(
    actor: Principal,
    scope: SharedMemoryScopeSelector,
    input?: PersonalMemoryList,
  ): Promise<{ memories: SharedMemory[]; next_cursor: string | null }>
  listSharedAsAgent(
    actor: Principal,
    scope: SharedMemoryScopeSelector,
    input?: PersonalMemoryList,
  ): Promise<{ memories: SharedMemory[]; next_cursor: string | null }>
  getShared(actor: Principal, scope: SharedMemoryScopeSelector, memoryId: string): Promise<SharedMemory>
  getSharedAsAgent(actor: Principal, scope: SharedMemoryScopeSelector, memoryId: string): Promise<SharedMemory>
  rememberShared(
    actor: Principal,
    scope: SharedMemoryScopeSelector,
    input: PersonalMemoryCommand,
  ): Promise<SharedMemory>
  rememberSharedAsAgent(
    actor: Principal,
    scope: SharedMemoryScopeSelector,
    input: PersonalMemoryCommand,
  ): Promise<SharedMemoryWriteResult>
  deleteShared(
    actor: Principal,
    scope: SharedMemoryScopeSelector,
    input: PersonalMemoryDelete,
  ): Promise<SharedMemoryDeletion>
  deleteSharedAsAgent(
    actor: Principal,
    scope: SharedMemoryScopeSelector,
    input: PersonalMemoryDelete,
  ): Promise<SharedMemoryDeletion>
  createSharedCorrectionProposal(
    actor: Principal,
    scope: SharedMemoryScopeSelector,
    memoryId: string,
    input: SharedMemoryCorrectionProposalCommand,
  ): Promise<SharedMemoryCorrectionProposal>
  listSharedCorrectionProposals(
    actor: Principal,
    scope: SharedMemoryScopeSelector,
    memoryId: string,
    input?: SharedMemoryCorrectionProposalList,
  ): Promise<{ proposals: SharedMemoryCorrectionProposal[]; next_cursor: string | null }>
  reviewSharedCorrectionProposal(
    actor: Principal,
    scope: SharedMemoryScopeSelector,
    memoryId: string,
    proposalId: string,
    input: { action: SharedMemoryCorrectionProposalReviewAction },
  ): Promise<SharedMemoryCorrectionProposalReviewResult>
  retrieveMemoryTargets(
    actor: Principal,
    input: MemoryTargetRetrieve,
  ): Promise<MemoryTargetContextResult>
  retrieveMemoryTargetsAsAgent(
    actor: Principal,
    input: MemoryTargetRetrieve,
  ): Promise<MemoryTargetContextResult>
}

function requireText(value: unknown, code: string, maxLength = 256): string {
  if (typeof value !== "string") throw new PlatformApiError(code, 422)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) throw new PlatformApiError(code, 422)
  return normalized
}

function optionalText(value: unknown, code: string, maxLength = 256): string | null {
  if (value === undefined || value === null) return null
  return requireText(value, code, maxLength)
}

function requireInteger(value: unknown, code: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new PlatformApiError(code, 422)
  }
  return value as number
}

function assertPrincipal(actor: Principal): Principal {
  requireText(actor.tenant_id, "MEMORY_PRINCIPAL_INVALID")
  requireText(actor.subject_id, "MEMORY_PRINCIPAL_INVALID")
  requireText(actor.client_id, "MEMORY_PRINCIPAL_INVALID")
  return actor
}

function assertGrantor(actor: Principal, grantor: VerifiedPersonalMemoryGrantor): void {
  if (
    grantor.management_authorized !== true ||
    grantor.person_subject !== true ||
    grantor.actor.tenant_id !== actor.tenant_id ||
    grantor.actor.subject_id !== actor.subject_id ||
    grantor.actor.client_id !== actor.client_id
  ) {
    throw new PlatformApiError("MEMORY_AGENT_GRANTOR_REQUIRED", 403)
  }
}

function normalizeKind(value: unknown): SharedMemoryKind {
  if (value === "preference" || value === "fact" || value === "decision") return value
  throw new PlatformApiError("MEMORY_KIND_INVALID", 422)
}

function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new PlatformApiError("MEMORY_IDEMPOTENCY_KEY_INVALID", 422)
  }
  return value
}

function sharedMemoryDigestKeys(secret: Uint8Array): { request: Uint8Array } {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) {
    throw new Error("Shared memory digest secret must be 32 bytes")
  }
  const salt = Buffer.from("genio-one-shared-memory-digest-v1")
  const derive = (info: string) => Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(secret),
    salt,
    Buffer.from(info),
    32,
  ))
  return { request: derive("memory/request/v1") }
}

function idempotencyKeyDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function normalizeSharedMemoryContext(value: unknown): SharedMemoryContext {
  if (value === undefined || value === null) return { kind: "GLOBAL", context_id: null }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformApiError("MEMORY_CONTEXT_INVALID", 422)
  }
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (kind !== "GLOBAL" && kind !== "PROJECT" && kind !== "CONTEXT") {
    throw new PlatformApiError("MEMORY_CONTEXT_INVALID", 422)
  }
  const contextId = optionalText(record.context_id, "MEMORY_CONTEXT_INVALID")
  if ((kind === "GLOBAL" && contextId !== null) || (kind !== "GLOBAL" && contextId === null)) {
    throw new PlatformApiError("MEMORY_CONTEXT_INVALID", 422)
  }
  return { kind, context_id: contextId }
}

export function normalizeSharedMemoryTarget(target: SharedMemoryScopeTarget): SharedMemoryScopeTarget {
  const ownerSubjectId = target.ownerSubjectId === null ? null : requireText(target.ownerSubjectId, "MEMORY_SCOPE_INVALID")
  const teamId = target.teamId === null ? null : requireText(target.teamId, "MEMORY_SCOPE_INVALID")
  const organizationId = target.organizationId === null ? null : requireText(target.organizationId, "MEMORY_SCOPE_INVALID")
  if (target.scope === "PERSONAL" && ownerSubjectId && !teamId && !organizationId) {
    return { scope: target.scope, ownerSubjectId, teamId: null, organizationId: null }
  }
  if (target.scope === "TEAM" && !ownerSubjectId && teamId && organizationId) {
    return { scope: target.scope, ownerSubjectId: null, teamId, organizationId }
  }
  if (target.scope === "ORGANIZATION" && !ownerSubjectId && !teamId && organizationId) {
    return { scope: target.scope, ownerSubjectId: null, teamId: null, organizationId }
  }
  throw new PlatformApiError("MEMORY_SCOPE_INVALID", 422)
}

export function sharedMemoryTargetKey(target: SharedMemoryScopeTarget): string {
  const normalized = normalizeSharedMemoryTarget(target)
  return JSON.stringify([
    normalized.scope,
    normalized.ownerSubjectId,
    normalized.teamId,
    normalized.organizationId,
  ])
}

function personalTarget(actor: Principal): SharedMemoryScopeTarget {
  return {
    scope: "PERSONAL",
    ownerSubjectId: requireText(actor.subject_id, "MEMORY_PRINCIPAL_INVALID"),
    teamId: null,
    organizationId: null,
  }
}

function normalizeCommand(value: PersonalMemoryCommand): {
  memoryId: string | null
  expectedRevision: number
  idempotencyKey: string
  key: string
  kind: SharedMemoryKind
  context: SharedMemoryContext
  content: string
  sourceReferenceId: string | null
} {
  const memoryId = value.memory_id === undefined ? null : requireText(value.memory_id, "MEMORY_ID_INVALID")
  const expectedRevision = requireInteger(value.expected_revision, "MEMORY_EXPECTED_REVISION_INVALID", 0)
  if ((memoryId === null && expectedRevision !== 0) || (memoryId !== null && expectedRevision < 1)) {
    throw new PlatformApiError("MEMORY_EXPECTED_REVISION_INVALID", 422)
  }
  if (typeof value.content !== "string" || !value.content.trim() || value.content.length > 12_000) {
    throw new PlatformApiError("MEMORY_CONTENT_INVALID", 422)
  }
  return {
    memoryId,
    expectedRevision,
    idempotencyKey: normalizeIdempotencyKey(value.idempotency_key),
    key: requireText(value.key, "MEMORY_KEY_INVALID"),
    kind: normalizeKind(value.kind),
    context: normalizeSharedMemoryContext(value.context),
    content: value.content,
    sourceReferenceId: optionalText(value.source_reference_id, "MEMORY_SOURCE_REFERENCE_INVALID"),
  }
}

function commandDigest(key: Uint8Array, input: {
  operation: "REMEMBER" | "DELETE" | "PROPOSE"
  idempotencyKey: string
  target: SharedMemoryScopeTarget
  memoryId: string | null
  expectedRevision: number
  key?: string
  kind?: SharedMemoryKind
  context?: SharedMemoryContext
  content?: string
  assertionOrigin?: SharedMemoryAssertionOrigin
  sourceReferenceId?: string | null
  source: SharedMemorySource
}): string {
  return createHmac("sha256", key)
    .update(input.idempotencyKey)
    .update("\u0000")
    .update(JSON.stringify([
      input.operation,
      sharedMemoryTargetKey(input.target),
      input.memoryId,
      input.expectedRevision,
      input.key ?? null,
      input.kind ?? null,
      input.context ?? null,
      input.content ?? null,
      input.assertionOrigin ?? null,
      input.sourceReferenceId ?? null,
      input.source.actor_subject_id,
      input.source.client_id,
      input.source.agent_id,
      input.source.agent_grant_id,
    ]))
    .digest("hex")
}

function encodeCursor(position: SharedMemoryPagePosition): string {
  return Buffer.from(JSON.stringify([position.updatedAt, position.memoryId])).toString("base64url")
}

function decodeCursor(cursor: unknown): SharedMemoryPagePosition | null {
  if (cursor === undefined || cursor === null) return null
  const raw = requireText(cursor, "MEMORY_CURSOR_INVALID", 512)
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (!Array.isArray(decoded) || decoded.length !== 2) throw new Error("invalid")
    const [updatedAt, memoryId] = decoded
    return {
      updatedAt: requireInteger(updatedAt, "MEMORY_CURSOR_INVALID", 0),
      memoryId: requireText(memoryId, "MEMORY_CURSOR_INVALID"),
    }
  } catch (error) {
    if (error instanceof PlatformApiError) throw error
    throw new PlatformApiError("MEMORY_CURSOR_INVALID", 422)
  }
}

function encodeAgentCursor(position: PersonalMemoryAgentPagePosition): string {
  return Buffer.from(JSON.stringify([position.enabledAt, position.agentId])).toString("base64url")
}

function decodeAgentCursor(cursor: unknown): PersonalMemoryAgentPagePosition | null {
  if (cursor === undefined || cursor === null) return null
  const raw = requireText(cursor, "MEMORY_AGENT_CURSOR_INVALID", 512)
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (!Array.isArray(decoded) || decoded.length !== 2) throw new Error("invalid")
    const [enabledAt, agentId] = decoded
    return {
      enabledAt: requireInteger(enabledAt, "MEMORY_AGENT_CURSOR_INVALID", 0),
      agentId: requireText(agentId, "MEMORY_AGENT_CURSOR_INVALID"),
    }
  } catch (error) {
    if (error instanceof PlatformApiError) throw error
    throw new PlatformApiError("MEMORY_AGENT_CURSOR_INVALID", 422)
  }
}

function pageLimit(value: unknown): number {
  if (value === undefined || value === null) return 20
  const limit = requireInteger(value, "MEMORY_LIST_LIMIT_INVALID", 1)
  if (limit > 100) throw new PlatformApiError("MEMORY_LIST_LIMIT_INVALID", 422)
  return limit
}

function agentPageLimit(value: unknown): number {
  if (value === undefined || value === null) return 100
  const limit = requireInteger(value, "MEMORY_AGENT_LIST_LIMIT_INVALID", 1)
  if (limit > 100) throw new PlatformApiError("MEMORY_AGENT_LIST_LIMIT_INVALID", 422)
  return limit
}

function retrievalLimit(value: unknown): number {
  if (value === undefined || value === null) return 10
  const limit = requireInteger(value, "MEMORY_RETRIEVE_LIMIT_INVALID", 1)
  if (limit > 20) throw new PlatformApiError("MEMORY_RETRIEVE_LIMIT_INVALID", 422)
  return limit
}

function contextLimit(value: unknown): number {
  if (value === undefined || value === null) return 4_000
  const limit = requireInteger(value, "MEMORY_CONTEXT_LIMIT_INVALID", 1)
  if (limit > 16_000) throw new PlatformApiError("MEMORY_CONTEXT_LIMIT_INVALID", 422)
  return limit
}

function proposalPageLimit(value: unknown): number {
  if (value === undefined || value === null) return 20
  const limit = requireInteger(value, "MEMORY_PROPOSAL_LIST_LIMIT_INVALID", 1)
  if (limit > 100) throw new PlatformApiError("MEMORY_PROPOSAL_LIST_LIMIT_INVALID", 422)
  return limit
}

function query(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return requireText(value, "MEMORY_QUERY_INVALID", 512)
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformApiError(code, 422)
  }
  return value as Record<string, unknown>
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function normalizeSharedScopeSelector(value: unknown): SharedMemoryScopeSelector {
  const selector = record(value, "MEMORY_SCOPE_SELECTOR_INVALID")
  if (selector.scope === "TEAM" && hasOnlyKeys(selector, ["scope", "workspace_id"])) {
    return {
      scope: "TEAM",
      workspace_id: requireText(selector.workspace_id, "MEMORY_SCOPE_WORKSPACE_ID_INVALID"),
    }
  }
  if (selector.scope === "ORGANIZATION" && hasOnlyKeys(selector, ["scope", "organization_id"])) {
    return {
      scope: "ORGANIZATION",
      organization_id: requireText(selector.organization_id, "MEMORY_SCOPE_ORGANIZATION_ID_INVALID"),
    }
  }
  throw new PlatformApiError("MEMORY_SCOPE_SELECTOR_INVALID", 422)
}

function normalizeMemoryTargetSelector(value: unknown): MemoryTargetSelector {
  const target = record(value, "MEMORY_RETRIEVE_TARGET_INVALID")
  if (target.scope === "PERSONAL" && hasOnlyKeys(target, ["scope"])) {
    return { scope: "PERSONAL" }
  }
  try {
    return normalizeSharedScopeSelector(target)
  } catch (error) {
    if (error instanceof PlatformApiError) {
      throw new PlatformApiError("MEMORY_RETRIEVE_TARGET_INVALID", 422)
    }
    throw error
  }
}

function memoryTargetSelectorKey(target: MemoryTargetSelector): string {
  if (target.scope === "PERSONAL") return "PERSONAL"
  if (target.scope === "TEAM") return JSON.stringify([target.scope, target.workspace_id])
  return JSON.stringify([target.scope, target.organization_id])
}

function normalizeMemoryTargetSelectors(value: unknown): MemoryTargetSelector[] {
  if (value === undefined || value === null) return [{ scope: "PERSONAL" }]
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new PlatformApiError("MEMORY_RETRIEVE_TARGETS_INVALID", 422)
  }
  const targets = value.map(normalizeMemoryTargetSelector)
  if (new Set(targets.map(memoryTargetSelectorKey)).size !== targets.length) {
    throw new PlatformApiError("MEMORY_RETRIEVE_TARGETS_INVALID", 422)
  }
  return targets
}

function normalizeProposalCommand(value: SharedMemoryCorrectionProposalCommand): {
  expectedRevision: number
  idempotencyKey: string
  content: string
  sourceReferenceId: string | null
} {
  if (typeof value.content !== "string" || !value.content.trim() || value.content.length > 12_000) {
    throw new PlatformApiError("MEMORY_CONTENT_INVALID", 422)
  }
  return {
    expectedRevision: requireInteger(value.expected_revision, "MEMORY_EXPECTED_REVISION_INVALID", 1),
    idempotencyKey: normalizeIdempotencyKey(value.idempotency_key),
    content: value.content,
    sourceReferenceId: optionalText(value.source_reference_id, "MEMORY_SOURCE_REFERENCE_INVALID"),
  }
}

function normalizeProposalStatus(value: unknown): SharedMemoryCorrectionProposal["status"] | null {
  if (value === undefined || value === null) return null
  if (value === "PENDING" || value === "ACCEPTED" || value === "REJECTED" || value === "STALE") return value
  throw new PlatformApiError("MEMORY_PROPOSAL_STATUS_INVALID", 422)
}

function normalizeProposalReviewAction(value: unknown): SharedMemoryCorrectionProposalReviewAction {
  if (value === "ACCEPT" || value === "REJECT") return value
  throw new PlatformApiError("MEMORY_PROPOSAL_REVIEW_ACTION_INVALID", 422)
}

function encodeProposalCursor(position: SharedMemoryCorrectionProposalPagePosition): string {
  return Buffer.from(JSON.stringify([position.createdAt, position.proposalId])).toString("base64url")
}

function decodeProposalCursor(cursor: unknown): SharedMemoryCorrectionProposalPagePosition | null {
  if (cursor === undefined || cursor === null) return null
  const raw = requireText(cursor, "MEMORY_PROPOSAL_CURSOR_INVALID", 512)
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (!Array.isArray(decoded) || decoded.length !== 2) throw new Error("invalid")
    const [createdAt, proposalId] = decoded
    return {
      createdAt: requireInteger(createdAt, "MEMORY_PROPOSAL_CURSOR_INVALID", 0),
      proposalId: requireText(proposalId, "MEMORY_PROPOSAL_CURSOR_INVALID"),
    }
  } catch (error) {
    if (error instanceof PlatformApiError) throw error
    throw new PlatformApiError("MEMORY_PROPOSAL_CURSOR_INVALID", 422)
  }
}

function directSource(actor: Principal, referenceId: string | null): SharedMemorySource {
  return {
    actor_subject_id: actor.subject_id,
    client_id: actor.client_id,
    agent_id: null,
    agent_grant_id: null,
    reference_id: referenceId,
  }
}

function sameContext(left: SharedMemoryContext, right: SharedMemoryContext): boolean {
  return left.kind === right.kind && left.context_id === right.context_id
}

export interface SharedMemoryRetrievalEntry {
  memory: SharedMemory
  conflict: boolean
}

export interface SharedMemoryRetrievalUnit {
  entries: readonly SharedMemoryRetrievalEntry[]
}

interface InternalSharedMemoryRetrievalUnit extends SharedMemoryRetrievalUnit {
  updatedAt: number
  memoryId: string
}

function contextLine(input: {
  memory: SharedMemory
  conflict: boolean
  content: string
  contentTruncated: boolean
  includeScopeIdentity: boolean
}): string {
  return JSON.stringify({
    memory_id: input.memory.memory_id,
    ...(input.includeScopeIdentity ? {
      scope: input.memory.scope,
      owner_subject_id: input.memory.owner_subject_id,
      team_id: input.memory.team_id,
      organization_id: input.memory.organization_id,
    } : {}),
    key: input.memory.key,
    kind: input.memory.kind,
    context: input.memory.context,
    source: input.memory.source,
    assertion_origin: input.memory.assertion_origin,
    confirmed: input.memory.confirmation !== null,
    conflict: input.conflict,
    content: input.content,
    content_truncated: input.contentTruncated,
  })
}

function boundedContextLine(memory: SharedMemory, conflict: boolean, maximum: number, includeScopeIdentity: boolean): {
  content: string
  contentTruncated: boolean
  line: string
} | null {
  const full = contextLine({ memory, conflict, content: memory.content, contentTruncated: false, includeScopeIdentity })
  if (full.length <= maximum) {
    return { content: memory.content, contentTruncated: false, line: full }
  }
  const empty = contextLine({ memory, conflict, content: "", contentTruncated: true, includeScopeIdentity })
  if (empty.length > maximum) return null
  let lower = 1
  let upper = memory.content.length
  let selected = ""
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2)
    const content = memory.content.slice(0, middle)
    const line = contextLine({ memory, conflict, content, contentTruncated: true, includeScopeIdentity })
    if (line.length <= maximum) {
      selected = content
      lower = middle + 1
    } else {
      upper = middle - 1
    }
  }
  if (!selected) {
    return { content: "", contentTruncated: true, line: empty }
  }
  return {
    content: selected,
    contentTruncated: true,
    line: contextLine({ memory, conflict, content: selected, contentTruncated: true, includeScopeIdentity }),
  }
}

function minimumContextLineLength(entry: SharedMemoryRetrievalEntry, includeScopeIdentity: boolean): number {
  return contextLine({
    memory: entry.memory,
    conflict: entry.conflict,
    content: "",
    contentTruncated: true,
    includeScopeIdentity,
  }).length
}

function orderConflictEntries(values: readonly SharedMemory[]): SharedMemory[] {
  const sameScope = new Set(values.map((memory) => JSON.stringify([
    memory.scope,
    memory.owner_subject_id,
    memory.team_id,
    memory.organization_id,
  ]))).size === 1
  return [...values].sort((left, right) => {
    if (sameScope) {
      const confirmation = Number(
        right.assertion_origin === "USER_EXPLICIT" || right.confirmation !== null,
      ) - Number(
        left.assertion_origin === "USER_EXPLICIT" || left.confirmation !== null,
      )
      if (confirmation !== 0) return confirmation
    }
    return right.updated_at - left.updated_at || left.memory_id.localeCompare(right.memory_id)
  })
}

function hasInferredKindConflict(values: readonly SharedMemory[]): boolean {
  const byContext = new Map<string, SharedMemory[]>()
  for (const memory of values) {
    const key = JSON.stringify([memory.context.kind, memory.context.context_id])
    const entries = byContext.get(key) ?? []
    entries.push(memory)
    byContext.set(key, entries)
  }
  return [...byContext.values()].some((entries) => (
    entries.some((memory) => memory.assertion_origin === "AGENT_INFERRED") &&
    new Set(entries.map((memory) => memory.kind)).size > 1
  ))
}

function retrievalUnits(values: readonly SharedMemory[]): InternalSharedMemoryRetrievalUnit[] {
  const unique = new Map<string, SharedMemory>()
  for (const memory of values) unique.set(memory.memory_id, memory)
  const grouped = new Map<string, SharedMemory[]>()
  for (const memory of unique.values()) {
    const entries = grouped.get(memory.key) ?? []
    entries.push(memory)
    grouped.set(memory.key, entries)
  }
  const units: InternalSharedMemoryRetrievalUnit[] = []
  for (const entries of grouped.values()) {
    const conflict = new Set(entries.map((memory) => memory.content)).size > 1 || hasInferredKindConflict(entries)
    if (!conflict) {
      for (const memory of entries) {
        units.push({ entries: [{ memory, conflict: false }], updatedAt: memory.updated_at, memoryId: memory.memory_id })
      }
      continue
    }
    const ordered = orderConflictEntries(entries)
    units.push({
      entries: ordered.map((memory) => ({ memory, conflict: true })),
      updatedAt: Math.max(...ordered.map((memory) => memory.updated_at)),
      memoryId: ordered[0]!.memory_id,
    })
  }
  return units.sort((left, right) => right.updatedAt - left.updatedAt || left.memoryId.localeCompare(right.memoryId))
}

function unitContainsContext(unit: SharedMemoryRetrievalUnit, context: SharedMemoryContext): boolean {
  return unit.entries.some((entry) => sameContext(entry.memory.context, context))
}

export function selectSharedMemoryRetrieval(
  values: readonly SharedMemory[],
  input: {
    limit: number
    requiredContexts?: readonly SharedMemoryContext[]
  },
): SharedMemoryRetrievalUnit[] {
  const ordered = retrievalUnits(values)
  const selected = new Map<InternalSharedMemoryRetrievalUnit, InternalSharedMemoryRetrievalUnit>()
  let count = 0
  const add = (unit: InternalSharedMemoryRetrievalUnit): boolean => {
    if (selected.has(unit)) return false
    const remaining = input.limit - count
    if (remaining <= 0) return false
    if (unit.entries.length <= remaining) {
      selected.set(unit, unit)
      count += unit.entries.length
      return true
    }
    if (unit.entries[0]?.conflict !== true) return false
    selected.set(unit, {
      ...unit,
      entries: unit.entries.slice(0, remaining),
    })
    count += remaining
    return true
  }
  for (const context of input.requiredContexts ?? []) {
    if ([...selected.values()].some((unit) => unitContainsContext(unit, context))) continue
    const candidate = ordered.find((unit) => unitContainsContext(unit, context) && count < input.limit)
    if (candidate) add(candidate)
  }
  for (const unit of ordered) add(unit)
  return ordered.flatMap((unit) => {
    const value = selected.get(unit)
    return value ? [value] : []
  })
}

function appendContextEntry(
  state: { memories: SharedMemoryContextResult["memories"]; context: string },
  entry: SharedMemoryRetrievalEntry,
  maximum: number,
  reserve: number,
  includeScopeIdentity: boolean,
): { contentTruncated: boolean } | null {
  const separator = state.context ? "\n" : ""
  const available = maximum - state.context.length - separator.length - reserve
  if (available < 0) return null
  const bounded = boundedContextLine(entry.memory, entry.conflict, available, includeScopeIdentity)
  if (!bounded) return null
  const { confirmation, ...memory } = entry.memory
  state.memories.push({
    ...memory,
    confirmed: confirmation !== null,
    content: bounded.content,
    content_truncated: bounded.contentTruncated,
    conflict: entry.conflict,
  })
  state.context += separator + bounded.line
  return { contentTruncated: bounded.contentTruncated }
}

function minimumUnitLength(unit: SharedMemoryRetrievalUnit, hasContext: boolean, includeScopeIdentity: boolean): number {
  return unit.entries.reduce((total, entry, index) => (
    total + (hasContext || index > 0 ? 1 : 0) + minimumContextLineLength(entry, includeScopeIdentity)
  ), 0)
}

function contextResult(
  units: readonly SharedMemoryRetrievalUnit[],
  maximum: number,
  includeScopeIdentity = false,
): SharedMemoryContextResult {
  const state: { memories: SharedMemoryContextResult["memories"]; context: string } = {
    memories: [],
    context: "",
  }
  for (const unit of units) {
    const conflict = unit.entries[0]?.conflict === true
    if (conflict) {
      if (state.context.length + minimumUnitLength(unit, Boolean(state.context), includeScopeIdentity) > maximum) continue
      for (let index = 0; index < unit.entries.length; index += 1) {
        const entry = unit.entries[index]!
        const following: SharedMemoryRetrievalUnit = { entries: unit.entries.slice(index + 1) }
        const reserve = minimumUnitLength(following, true, includeScopeIdentity)
        const appended = appendContextEntry(state, entry, maximum, reserve, includeScopeIdentity)
        if (!appended) throw new Error("Shared memory conflict context cannot be encoded")
      }
      continue
    }
    const entry = unit.entries[0]
    if (!entry) continue
    const appended = appendContextEntry(state, entry, maximum, 0, includeScopeIdentity)
    if (!appended || appended.contentTruncated) break
  }
  return state
}

export function createSharedMemoryDirectory(options: {
  repository: SharedMemoryRepository
  digestSecret: Uint8Array
}): SharedMemoryDirectory {
  const digests = sharedMemoryDigestKeys(options.digestSecret)
  async function withActiveAgent<T>(
    actor: Principal,
    referenceId: string | null,
    operation: (source: SharedMemorySource, repository: ActivePersonalMemoryAgentRepository) => Promise<T>,
  ): Promise<T> {
    return options.repository.withActivePersonalAgent({
      tenantId: actor.tenant_id,
      ownerSubjectId: actor.subject_id,
      agentId: actor.client_id,
    }, async (grant, repository) => {
      if (grant.revoked_at !== null || grant.agent_id !== actor.client_id) {
        throw new PlatformApiError("MEMORY_AGENT_GRANT_INVALID", 403)
      }
      return operation({
        actor_subject_id: actor.subject_id,
        client_id: actor.client_id,
        agent_id: grant.agent_id,
        agent_grant_id: grant.grant_id,
        reference_id: referenceId,
      }, repository)
    })
  }

  async function rememberAtTarget(
    actor: Principal,
    input: PersonalMemoryCommand,
    target: SharedMemoryScopeTarget,
    source: SharedMemorySource,
    assertionOrigin: SharedMemoryAssertionOrigin,
    repository: Pick<AuthorizedSharedMemoryRepository, "remember"> = options.repository,
  ): Promise<SharedMemory> {
    const command = normalizeCommand(input)
    return repository.remember({
      tenantId: actor.tenant_id,
      target,
      memoryId: command.memoryId,
      expectedRevision: command.expectedRevision,
      idempotencyKeyDigest: idempotencyKeyDigest(command.idempotencyKey),
      requestDigest: commandDigest(digests.request, {
        operation: "REMEMBER",
        idempotencyKey: command.idempotencyKey,
        target,
        memoryId: command.memoryId,
        expectedRevision: command.expectedRevision,
        key: command.key,
        kind: command.kind,
        context: command.context,
        content: command.content,
        assertionOrigin,
        sourceReferenceId: command.sourceReferenceId,
        source,
      }),
      key: command.key,
      kind: command.kind,
      context: command.context,
      content: command.content,
      assertionOrigin,
      source,
    })
  }

  async function remember(
    actor: Principal,
    input: PersonalMemoryCommand,
    source: SharedMemorySource,
    assertionOrigin: SharedMemoryAssertionOrigin,
    repository: Pick<AuthorizedSharedMemoryRepository, "remember"> = options.repository,
  ): Promise<SharedMemory> {
    return rememberAtTarget(actor, input, personalTarget(actor), source, assertionOrigin, repository)
  }

  function retrievalContexts(value: PersonalMemoryRetrieve["context"]): SharedMemoryContext[] {
    const global = { kind: "GLOBAL" as const, context_id: null }
    if (value === undefined) return [global]
    const selected = normalizeSharedMemoryContext(value)
    if (selected.kind === "GLOBAL") return [global]
    return [global, selected]
  }

  async function retrieve(
    actor: Principal,
    input: PersonalMemoryRetrieve,
    repository: Pick<SharedMemoryRepository, "list"> = options.repository,
  ): Promise<SharedMemoryContextResult> {
    const limit = retrievalLimit(input.limit)
    const contexts = retrievalContexts(input.context)
    const target = personalTarget(actor)
    const candidateSets = await Promise.all(contexts.map((context) => repository.list({
      tenantId: actor.tenant_id,
      target,
      limit: 20,
      position: null,
      contexts: [context],
      query: query(input.query),
      keys: null,
    })))
    const keys = [...new Set(candidateSets.flatMap((values) => values.map((memory) => memory.key)))]
    const companions = keys.length === 0
      ? []
      : await Promise.all(contexts.map((context) => repository.list({
        tenantId: actor.tenant_id,
        target,
        limit: keys.length * 3,
        position: null,
        contexts: [context],
        query: null,
        keys,
      })))
    const values = new Map<string, SharedMemory>()
    for (const memory of [...candidateSets.flat(), ...companions.flat()]) {
      values.set(memory.memory_id, memory)
    }
    return contextResult(
      selectSharedMemoryRetrieval([...values.values()], { limit, requiredContexts: contexts }),
      contextLimit(input.max_context_chars),
    )
  }

  async function forgetAtTarget(
    actor: Principal,
    input: PersonalMemoryDelete,
    target: SharedMemoryScopeTarget,
    source: SharedMemorySource,
    assertionOrigin: SharedMemoryAssertionOrigin,
    repository: Pick<AuthorizedSharedMemoryRepository, "delete"> = options.repository,
  ): Promise<SharedMemoryDeletion> {
    const memoryId = requireText(input.memory_id, "MEMORY_ID_INVALID")
    const expectedRevision = requireInteger(input.expected_revision, "MEMORY_EXPECTED_REVISION_INVALID", 1)
    const key = normalizeIdempotencyKey(input.idempotency_key)
    return repository.delete({
      tenantId: actor.tenant_id,
      target,
      memoryId,
      expectedRevision,
      idempotencyKeyDigest: idempotencyKeyDigest(key),
      requestDigest: commandDigest(digests.request, {
        operation: "DELETE",
        idempotencyKey: key,
        target,
        memoryId,
        expectedRevision,
        assertionOrigin,
        source,
      }),
      actorSubjectId: source.actor_subject_id,
      clientId: source.client_id,
      agentId: source.agent_id,
      agentGrantId: source.agent_grant_id,
      assertionOrigin,
    })
  }

  async function forget(
    actor: Principal,
    input: PersonalMemoryDelete,
    source: SharedMemorySource,
    assertionOrigin: SharedMemoryAssertionOrigin,
    repository: Pick<AuthorizedSharedMemoryRepository, "delete"> = options.repository,
  ): Promise<SharedMemoryDeletion> {
    return forgetAtTarget(actor, input, personalTarget(actor), source, assertionOrigin, repository)
  }

  async function withAuthorizedShared<T>(
    actor: Principal,
    selector: SharedMemoryScopeSelector,
    permission: SharedMemoryScopePermission,
    repository: Pick<SharedMemoryRepository, "withAuthorizedSharedScope">,
    operation: (
      scope: AuthorizedSharedMemoryScope,
      authorizedRepository: AuthorizedSharedMemoryRepository,
    ) => Promise<T>,
  ): Promise<T> {
    return repository.withAuthorizedSharedScope({
      actor,
      selector: normalizeSharedScopeSelector(selector),
      permission,
    }, operation)
  }

  async function listAtTarget(
    actor: Principal,
    target: SharedMemoryScopeTarget,
    input: PersonalMemoryList,
    repository: Pick<AuthorizedSharedMemoryRepository, "list">,
  ): Promise<{ memories: SharedMemory[]; next_cursor: string | null }> {
    const limit = pageLimit(input.limit)
    const values = await repository.list({
      tenantId: actor.tenant_id,
      target,
      limit: limit + 1,
      position: decodeCursor(input.cursor),
      contexts: input.context === undefined ? null : [normalizeSharedMemoryContext(input.context)],
      query: null,
    })
    const memories = values.slice(0, limit)
    const next = values[limit]
    const last = memories.at(-1)
    return {
      memories,
      next_cursor: next && last ? encodeCursor({ updatedAt: last.updated_at, memoryId: last.memory_id }) : null,
    }
  }

  function hasMemoryIdentity(memory: SharedMemory, command: ReturnType<typeof normalizeCommand>): boolean {
    return memory.key === command.key && memory.kind === command.kind && sameContext(memory.context, command.context)
  }

  async function findSharedCommandMemory(
    actor: Principal,
    target: SharedMemoryScopeTarget,
    command: ReturnType<typeof normalizeCommand>,
    repository: Pick<AuthorizedSharedMemoryRepository, "get" | "list">,
  ): Promise<{ exact: SharedMemory | null; candidate: SharedMemory | null }> {
    if (command.memoryId !== null) {
      const memory = await repository.get({
        tenantId: actor.tenant_id,
        target,
        memoryId: command.memoryId,
      })
      if (!memory) throw new PlatformApiError("MEMORY_NOT_FOUND", 404)
      if (!hasMemoryIdentity(memory, command)) {
        throw new PlatformApiError("MEMORY_IDENTITY_IMMUTABLE", 409)
      }
      return { exact: null, candidate: memory }
    }
    const memories = await repository.list({
      tenantId: actor.tenant_id,
      target,
      limit: 100,
      position: null,
      contexts: [command.context],
      query: null,
      keys: [command.key],
    })
    const candidates = memories
      .filter((memory) => hasMemoryIdentity(memory, command))
      .sort((left, right) => (
        right.updated_at - left.updated_at ||
        left.memory_id.localeCompare(right.memory_id)
      ))
    if (candidates.length > 1) {
      throw new PlatformApiError("MEMORY_CORRECTION_TARGET_REQUIRED", 409)
    }
    const exact = candidates.find((memory) => memory.content === command.content) ?? null
    return { exact, candidate: candidates[0] ?? null }
  }

  async function createProposal(
    actor: Principal,
    target: SharedMemoryScopeTarget,
    memory: SharedMemory,
    input: {
      idempotencyKey: string
      content: string
      sourceReferenceId: string | null
      baseRevision?: number
    },
    source: SharedMemorySource,
    repository: Pick<AuthorizedSharedMemoryRepository, "createCorrectionProposal">,
  ): Promise<SharedMemoryCorrectionProposal> {
    const assertionOrigin: SharedMemoryAssertionOrigin = source.agent_id === null ? "USER_EXPLICIT" : "AGENT_INFERRED"
    const baseRevision = input.baseRevision ?? memory.revision
    return repository.createCorrectionProposal({
      tenantId: actor.tenant_id,
      target,
      memoryId: memory.memory_id,
      baseRevision,
      proposedKind: memory.kind,
      proposedContent: input.content,
      idempotencyKeyDigest: idempotencyKeyDigest(input.idempotencyKey),
      requestDigest: commandDigest(digests.request, {
        operation: "PROPOSE",
        idempotencyKey: input.idempotencyKey,
        target,
        memoryId: memory.memory_id,
        expectedRevision: baseRevision,
        kind: memory.kind,
        content: input.content,
        assertionOrigin,
        sourceReferenceId: input.sourceReferenceId,
        source,
      }),
      source,
    })
  }

  function personalMemoryScope(): MemoryScope {
    return {
      target: { scope: "PERSONAL" },
      display_name: "Personal",
      can_read: true,
      can_contribute: true,
      can_manage: true,
    }
  }

  async function listMemoryScopes(
    actor: Principal,
    repository: Pick<AuthorizedSharedMemoryRepository, "listMemoryScopes">,
  ): Promise<MemoryScope[]> {
    const values = await repository.listMemoryScopes({ actor })
    const scopes = new Map<string, MemoryScope>()
    for (const value of values) {
      let target: MemoryTargetSelector
      try {
        target = normalizeMemoryTargetSelector(value.target)
      } catch {
        throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
      }
      if (target.scope === "PERSONAL") continue
      if (
        typeof value.display_name !== "string" || !value.display_name.trim() || value.display_name.length > 256 ||
        value.can_read !== true || typeof value.can_contribute !== "boolean" || typeof value.can_manage !== "boolean" ||
        (value.can_manage && !value.can_contribute)
      ) {
        throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
      }
      scopes.set(memoryTargetSelectorKey(target), {
        target,
        display_name: value.display_name,
        can_read: true,
        can_contribute: value.can_contribute,
        can_manage: value.can_manage,
      })
    }
    return [personalMemoryScope(), ...[...scopes.values()].sort((left, right) => (
      left.display_name.localeCompare(right.display_name) ||
      memoryTargetSelectorKey(left.target).localeCompare(memoryTargetSelectorKey(right.target))
    ))]
  }

  type TargetReaderRepository = Pick<AuthorizedSharedMemoryRepository, "list"> &
    Pick<SharedMemoryRepository, "withAuthorizedSharedScope">
  type TargetReader = (
    target: MemoryTargetSelector,
    input: Omit<SharedMemoryListInput, "tenantId" | "target" | "position">,
  ) => Promise<SharedMemory[]>

  function targetReader(actor: Principal, repository: TargetReaderRepository): TargetReader {
    return async (target, input) => {
      if (target.scope === "PERSONAL") {
        return repository.list({
          tenantId: actor.tenant_id,
          target: personalTarget(actor),
          position: null,
          ...input,
        })
      }
      return withAuthorizedShared(actor, target, "READ", repository, async (scope, authorizedRepository) => (
        authorizedRepository.list({
          tenantId: actor.tenant_id,
          target: scope.target,
          position: null,
          ...input,
        })
      ))
    }
  }

  async function retrieveTargets(
    actor: Principal,
    input: MemoryTargetRetrieve,
    repository: TargetReaderRepository,
  ): Promise<MemoryTargetContextResult> {
    const targets = normalizeMemoryTargetSelectors(input.targets)
    const contexts = retrievalContexts(input.context)
    const read = targetReader(actor, repository)
    const candidateSets: SharedMemory[][] = []
    for (const target of targets) {
      for (const context of contexts) {
        candidateSets.push(await read(target, {
          limit: 20,
          contexts: [context],
          query: query(input.query),
          keys: null,
        }))
      }
    }
    const keys = [...new Set(candidateSets.flatMap((values) => values.map((memory) => memory.key)))]
    const companions: SharedMemory[][] = []
    if (keys.length > 0) {
      for (const target of targets) {
        for (const context of contexts) {
          companions.push(await read(target, {
            limit: keys.length * 3,
            contexts: [context],
            query: null,
            keys,
          }))
        }
      }
    }
    const values = new Map<string, SharedMemory>()
    for (const memory of [...candidateSets.flat(), ...companions.flat()]) {
      values.set(memory.memory_id, memory)
    }
    return {
      ...contextResult(
      selectSharedMemoryRetrieval([...values.values()], {
        limit: retrievalLimit(input.limit),
        requiredContexts: contexts,
      }),
      contextLimit(input.max_context_chars),
      true,
      ),
      precedence: "NONE",
    }
  }

  return {
    async enablePersonalAgent(actor, grantor, input) {
      assertPrincipal(actor)
      assertGrantor(actor, grantor)
      return options.repository.enablePersonalAgent({
        tenantId: actor.tenant_id,
        ownerSubjectId: actor.subject_id,
        agentId: requireText(input.agent_id, "MEMORY_AGENT_ID_INVALID"),
      })
    },
    async listPersonalAgents(actor, input = {}) {
      assertPrincipal(actor)
      const limit = agentPageLimit(input.limit)
      const values = await options.repository.listPersonalAgents({
        tenantId: actor.tenant_id,
        ownerSubjectId: actor.subject_id,
        limit: limit + 1,
        position: decodeAgentCursor(input.cursor),
      })
      const agents = values.slice(0, limit)
      const next = values[limit]
      const last = agents.at(-1)
      return {
        agents,
        next_cursor: next && last ? encodeAgentCursor({ enabledAt: last.enabled_at, agentId: last.agent_id }) : null,
      }
    },
    async getPersonalAgent(actor, agentId) {
      assertPrincipal(actor)
      return options.repository.getPersonalAgent({
        tenantId: actor.tenant_id,
        ownerSubjectId: actor.subject_id,
        agentId: requireText(agentId, "MEMORY_AGENT_ID_INVALID"),
      })
    },
    async revokePersonalAgent(actor, grantor, input) {
      assertPrincipal(actor)
      assertGrantor(actor, grantor)
      return options.repository.revokePersonalAgent({
        tenantId: actor.tenant_id,
        ownerSubjectId: actor.subject_id,
        agentId: requireText(input.agent_id, "MEMORY_AGENT_ID_INVALID"),
      })
    },
    async rememberPersonal(actor, input) {
      assertPrincipal(actor)
      const command = normalizeCommand(input)
      return remember(actor, input, directSource(actor, command.sourceReferenceId), "USER_EXPLICIT")
    },
    async rememberPersonalAsAgent(actor, input) {
      assertPrincipal(actor)
      const command = normalizeCommand(input)
      return withActiveAgent(actor, command.sourceReferenceId, (source, repository) => (
        remember(actor, input, source, "AGENT_INFERRED", repository)
      ))
    },
    async getPersonal(actor, memoryId) {
      assertPrincipal(actor)
      const memory = await options.repository.get({
        tenantId: actor.tenant_id,
        target: personalTarget(actor),
        memoryId: requireText(memoryId, "MEMORY_ID_INVALID"),
      })
      if (!memory) throw new PlatformApiError("MEMORY_NOT_FOUND", 404)
      return memory
    },
    async getPersonalAsAgent(actor, memoryId) {
      assertPrincipal(actor)
      return withActiveAgent(actor, null, async (_source, repository) => {
        const memory = await repository.get({
          tenantId: actor.tenant_id,
          target: personalTarget(actor),
          memoryId: requireText(memoryId, "MEMORY_ID_INVALID"),
        })
        if (!memory) throw new PlatformApiError("MEMORY_NOT_FOUND", 404)
        return memory
      })
    },
    async listPersonal(actor, input = {}) {
      assertPrincipal(actor)
      const target = personalTarget(actor)
      const limit = pageLimit(input.limit)
      const values = await options.repository.list({
        tenantId: actor.tenant_id,
        target,
        limit: limit + 1,
        position: decodeCursor(input.cursor),
        contexts: input.context === undefined ? null : [normalizeSharedMemoryContext(input.context)],
        query: null,
      })
      const memories = values.slice(0, limit)
      const next = values[limit]
      const last = memories.at(-1)
      return {
        memories,
        next_cursor: next && last ? encodeCursor({ updatedAt: last.updated_at, memoryId: last.memory_id }) : null,
      }
    },
    async listPersonalAsAgent(actor, input = {}) {
      assertPrincipal(actor)
      return withActiveAgent(actor, null, async (_source, repository) => {
        const target = personalTarget(actor)
        const limit = pageLimit(input.limit)
        const values = await repository.list({
          tenantId: actor.tenant_id,
          target,
          limit: limit + 1,
          position: decodeCursor(input.cursor),
          contexts: input.context === undefined ? null : [normalizeSharedMemoryContext(input.context)],
          query: null,
        })
        const memories = values.slice(0, limit)
        const next = values[limit]
        const last = memories.at(-1)
        return {
          memories,
          next_cursor: next && last ? encodeCursor({ updatedAt: last.updated_at, memoryId: last.memory_id }) : null,
        }
      })
    },
    async retrievePersonal(actor, input) {
      assertPrincipal(actor)
      return retrieve(actor, input)
    },
    async retrievePersonalAsAgent(actor, input) {
      assertPrincipal(actor)
      return withActiveAgent(actor, null, (_source, repository) => retrieve(actor, input, repository))
    },
    async deletePersonal(actor, input) {
      assertPrincipal(actor)
      return forget(actor, input, directSource(actor, null), "USER_EXPLICIT")
    },
    async deletePersonalAsAgent(actor, input) {
      assertPrincipal(actor)
      return withActiveAgent(actor, null, (source, repository) => (
        forget(actor, input, source, "AGENT_INFERRED", repository)
      ))
    },
    async listMemoryScopes(actor) {
      assertPrincipal(actor)
      return listMemoryScopes(actor, options.repository)
    },
    async listMemoryScopesAsAgent(actor) {
      assertPrincipal(actor)
      return withActiveAgent(actor, null, async (_source, repository) => (
        listMemoryScopes(actor, repository)
      ))
    },
    async listShared(actor, selector, input = {}) {
      assertPrincipal(actor)
      return withAuthorizedShared(actor, selector, "READ", options.repository, (scope, repository) => (
        listAtTarget(actor, scope.target, input, repository)
      ))
    },
    async listSharedAsAgent(actor, selector, input = {}) {
      assertPrincipal(actor)
      return withActiveAgent(actor, null, async (_source, repository) => (
        withAuthorizedShared(actor, selector, "READ", repository, (scope, authorizedRepository) => (
          listAtTarget(actor, scope.target, input, authorizedRepository)
        ))
      ))
    },
    async getShared(actor, selector, memoryId) {
      assertPrincipal(actor)
      const normalizedMemoryId = requireText(memoryId, "MEMORY_ID_INVALID")
      return withAuthorizedShared(actor, selector, "READ", options.repository, async (scope, repository) => {
        const memory = await repository.get({
          tenantId: actor.tenant_id,
          target: scope.target,
          memoryId: normalizedMemoryId,
        })
        if (!memory) throw new PlatformApiError("MEMORY_NOT_FOUND", 404)
        return memory
      })
    },
    async getSharedAsAgent(actor, selector, memoryId) {
      assertPrincipal(actor)
      const normalizedMemoryId = requireText(memoryId, "MEMORY_ID_INVALID")
      return withActiveAgent(actor, null, async (_source, repository) => (
        withAuthorizedShared(actor, selector, "READ", repository, async (scope, authorizedRepository) => {
          const memory = await authorizedRepository.get({
            tenantId: actor.tenant_id,
            target: scope.target,
            memoryId: normalizedMemoryId,
          })
          if (!memory) throw new PlatformApiError("MEMORY_NOT_FOUND", 404)
          return memory
        })
      ))
    },
    async rememberShared(actor, selector, input) {
      assertPrincipal(actor)
      const command = normalizeCommand(input)
      const source = directSource(actor, command.sourceReferenceId)
      return withAuthorizedShared(actor, selector, "CONTRIBUTE", options.repository, (scope, repository) => {
        if (command.memoryId !== null && !scope.canManage) {
          throw new PlatformApiError("SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403)
        }
        return rememberAtTarget(actor, input, scope.target, source, "USER_EXPLICIT", repository)
      })
    },
    async rememberSharedAsAgent(actor, selector, input) {
      assertPrincipal(actor)
      const command = normalizeCommand(input)
      return withActiveAgent(actor, command.sourceReferenceId, async (source, repository) => (
        withAuthorizedShared(actor, selector, "CONTRIBUTE", repository, async (scope, authorizedRepository) => {
          const initial = await findSharedCommandMemory(actor, scope.target, command, authorizedRepository)
          if (command.memoryId !== null || initial.candidate !== null) {
            if (command.memoryId === null && initial.exact !== null) {
              return { result: "MEMORY", memory: initial.exact }
            }
            return {
              result: "PROPOSAL",
              proposal: await createProposal(actor, scope.target, initial.candidate!, {
                ...command,
                ...(command.memoryId === null ? {} : { baseRevision: command.expectedRevision }),
              }, source, authorizedRepository),
            }
          }
          try {
            return {
              result: "MEMORY",
              memory: await rememberAtTarget(actor, input, scope.target, source, "AGENT_INFERRED", authorizedRepository),
            }
          } catch (error) {
            if (!(error instanceof PlatformApiError) || error.code !== "MEMORY_AGENT_INFERENCE_CONFLICT") {
              throw error
            }
            const after = await findSharedCommandMemory(actor, scope.target, command, authorizedRepository)
            if (after.exact !== null) {
              return { result: "MEMORY", memory: after.exact }
            }
            if (!after.candidate) throw error
            return {
              result: "PROPOSAL",
              proposal: await createProposal(actor, scope.target, after.candidate, command, source, authorizedRepository),
            }
          }
        })
      ))
    },
    async deleteShared(actor, selector, input) {
      assertPrincipal(actor)
      return withAuthorizedShared(actor, selector, "MANAGE", options.repository, (scope, repository) => (
        forgetAtTarget(actor, input, scope.target, directSource(actor, null), "USER_EXPLICIT", repository)
      ))
    },
    async deleteSharedAsAgent(actor, selector, input) {
      assertPrincipal(actor)
      return withActiveAgent(actor, null, (source, repository) => (
        withAuthorizedShared(actor, selector, "MANAGE", repository, (scope, authorizedRepository) => (
          forgetAtTarget(actor, input, scope.target, source, "AGENT_INFERRED", authorizedRepository)
        ))
      ))
    },
    async createSharedCorrectionProposal(actor, selector, memoryId, input) {
      assertPrincipal(actor)
      const command = normalizeProposalCommand(input)
      const normalizedMemoryId = requireText(memoryId, "MEMORY_ID_INVALID")
      const source = directSource(actor, command.sourceReferenceId)
      return withAuthorizedShared(actor, selector, "CONTRIBUTE", options.repository, async (scope, repository) => {
        const memory = await repository.get({
          tenantId: actor.tenant_id,
          target: scope.target,
          memoryId: normalizedMemoryId,
        })
        if (!memory) throw new PlatformApiError("MEMORY_NOT_FOUND", 404)
        return createProposal(actor, scope.target, memory, {
          ...command,
          baseRevision: command.expectedRevision,
        }, source, repository)
      })
    },
    async listSharedCorrectionProposals(actor, selector, memoryId, input = {}) {
      assertPrincipal(actor)
      const limit = proposalPageLimit(input.limit)
      const normalizedMemoryId = requireText(memoryId, "MEMORY_ID_INVALID")
      return withAuthorizedShared(actor, selector, "MANAGE", options.repository, async (scope, repository) => {
        const values = await repository.listCorrectionProposals({
          tenantId: actor.tenant_id,
          target: scope.target,
          memoryId: normalizedMemoryId,
          limit: limit + 1,
          position: decodeProposalCursor(input.cursor),
          status: normalizeProposalStatus(input.status),
        })
        const proposals = values.slice(0, limit)
        const next = values[limit]
        const last = proposals.at(-1)
        return {
          proposals,
          next_cursor: next && last ? encodeProposalCursor({
            createdAt: last.created_at,
            proposalId: last.proposal_id,
          }) : null,
        }
      })
    },
    async reviewSharedCorrectionProposal(actor, selector, memoryId, proposalId, input) {
      assertPrincipal(actor)
      const normalizedMemoryId = requireText(memoryId, "MEMORY_ID_INVALID")
      const normalizedProposalId = requireText(proposalId, "MEMORY_CORRECTION_PROPOSAL_ID_INVALID")
      const action = normalizeProposalReviewAction(input.action)
      return withAuthorizedShared(actor, selector, "MANAGE", options.repository, (scope, repository) => (
        repository.reviewCorrectionProposal({
          tenantId: actor.tenant_id,
          target: scope.target,
          memoryId: normalizedMemoryId,
          proposalId: normalizedProposalId,
          reviewerSubjectId: actor.subject_id,
          reviewerClientId: actor.client_id,
          action,
        })
      ))
    },
    async retrieveMemoryTargets(actor, input) {
      assertPrincipal(actor)
      return retrieveTargets(actor, input, options.repository)
    },
    async retrieveMemoryTargetsAsAgent(actor, input) {
      assertPrincipal(actor)
      return withActiveAgent(actor, null, (_source, repository) => retrieveTargets(actor, input, repository))
    },
  }
}
