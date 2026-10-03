import * as crypto from "node:crypto"
import type { GenioPrincipal } from "./runtime-broker"
import { verifyGenioOneAccessToken } from "./auth"
import { platformOrigin } from "./platform-origin"

export type PlatformMemoryKind = "preference" | "fact" | "decision"
export type PlatformMemoryContextKind = "GLOBAL" | "PROJECT" | "CONTEXT"

export interface PlatformMemoryContext {
  kind: PlatformMemoryContextKind
  contextId: string | null
}

export interface PlatformPersonalMemory {
  id: string
  key: string
  kind: PlatformMemoryKind
  content: string
  revision: number
  context: PlatformMemoryContext
  assertionOrigin: "USER_EXPLICIT" | "AGENT_INFERRED"
  source: {
    actorSubjectId: string
    clientId: string
    agentId: string | null
    agentGrantId: string | null
    referenceId: string | null
  }
  updatedAt: number
}

export interface PlatformPersonalMemoryDeletion {
  id: string
  revision: number
}

export class PlatformMemoryUnavailableError extends Error {
  constructor() { super("PERSONAL_MEMORY_UNAVAILABLE") }
}

export class PlatformMemoryOperationError extends Error {
  constructor(code: string) { super(code) }
}

export const GLOBAL_MEMORY_CONTEXT: PlatformMemoryContext = { kind: "GLOBAL", contextId: null }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 ? value : null
}

function optionalIdentifier(value: unknown): string | null {
  return value === null ? null : identifier(value)
}

function integer(value: unknown, minimum = 0): number | null {
  return Number.isSafeInteger(value) && Number(value) >= minimum ? Number(value) : null
}

function samePrincipal(left: Pick<GenioPrincipal, "tenant_id" | "subject_id" | "acting_client_id">, right: Pick<GenioPrincipal, "tenant_id" | "subject_id" | "acting_client_id">) {
  return left.tenant_id === right.tenant_id && left.subject_id === right.subject_id && left.acting_client_id === right.acting_client_id
}

function platformContext(value: unknown): PlatformMemoryContext | null {
  const context = record(value)
  const kind = context?.kind
  const contextId = optionalIdentifier(context?.context_id)
  if (!context || !["GLOBAL", "PROJECT", "CONTEXT"].includes(String(kind))) return null
  if ((kind === "GLOBAL") !== (contextId === null)) return null
  return { kind: kind as PlatformMemoryContextKind, contextId }
}

function memory(value: unknown, principal: Pick<GenioPrincipal, "tenant_id" | "subject_id">): PlatformPersonalMemory | null {
  const candidate = record(value)
  const source = record(candidate?.source)
  const id = identifier(candidate?.memory_id)
  const key = identifier(candidate?.key)
  const kind = candidate?.kind
  const content = typeof candidate?.content === "string" && candidate.content.length > 0 && candidate.content.length <= 12_000 ? candidate.content : null
  const context = platformContext(candidate?.context)
  const actorSubjectId = identifier(source?.actor_subject_id)
  const clientId = identifier(source?.client_id)
  const agentId = optionalIdentifier(source?.agent_id)
  const agentGrantId = optionalIdentifier(source?.agent_grant_id)
  const referenceId = optionalIdentifier(source?.reference_id)
  const revision = integer(candidate?.revision, 1)
  const updatedAt = integer(candidate?.updated_at)
  if (
    !candidate ||
    id === null ||
    key === null ||
    !["preference", "fact", "decision"].includes(String(kind)) ||
    content === null ||
    context === null ||
    candidate.tenant_id !== principal.tenant_id ||
    candidate.scope !== "PERSONAL" ||
    candidate.owner_subject_id !== principal.subject_id ||
    !["USER_EXPLICIT", "AGENT_INFERRED"].includes(String(candidate.assertion_origin)) ||
    actorSubjectId === null ||
    actorSubjectId !== principal.subject_id ||
    clientId === null ||
    agentId === null && source?.agent_id !== null ||
    agentGrantId === null && source?.agent_grant_id !== null ||
    referenceId === null && source?.reference_id !== null ||
    revision === null ||
    updatedAt === null
  ) return null
  return {
    id,
    key,
    kind: kind as PlatformMemoryKind,
    content,
    revision,
    context,
    assertionOrigin: candidate.assertion_origin as PlatformPersonalMemory["assertionOrigin"],
    source: { actorSubjectId, clientId, agentId, agentGrantId, referenceId },
    updatedAt,
  }
}

function errorCode(value: unknown) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{2,127}$/.test(value) ? value : "PERSONAL_MEMORY_OPERATION_FAILED"
}

async function assertOwnerBoundToken(principal: GenioPrincipal, accessToken: string) {
  const token = accessToken.trim()
  if (!token) throw new PlatformMemoryUnavailableError()
  let tokenPrincipal: GenioPrincipal
  try {
    tokenPrincipal = await verifyGenioOneAccessToken(token, AbortSignal.timeout(3_000))
  } catch {
    throw new PlatformMemoryUnavailableError()
  }
  if (!samePrincipal(tokenPrincipal, principal)) throw new PlatformMemoryUnavailableError()
  return token
}

async function callMemoryMcp(principal: GenioPrincipal, accessToken: string, name: "memory_retrieve" | "memory_get" | "memory_remember" | "memory_forget", args: Record<string, unknown>) {
  const token = await assertOwnerBoundToken(principal, accessToken)
  let response: Response
  try {
    response = await fetch(new URL(`/v1/tenants/${encodeURIComponent(principal.tenant_id)}/memory/mcp`, platformOrigin()), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    throw new PlatformMemoryUnavailableError()
  }
  if (!response.ok) throw new PlatformMemoryUnavailableError()
  const body = await response.json().catch(() => null)
  const result = record(record(body)?.result)
  if (!result) throw new PlatformMemoryUnavailableError()
  if (result.isError === true) {
    const content = Array.isArray(result.content) ? result.content.find((entry) => record(entry)?.type === "text") : null
    const code = errorCode(record(content)?.text)
    if (code === "MEMORY_AGENT_GRANT_INVALID" || code === "AUTHENTICATION_REQUIRED") throw new PlatformMemoryUnavailableError()
    throw new PlatformMemoryOperationError(code)
  }
  if (result.isError !== undefined && result.isError !== false) throw new PlatformMemoryUnavailableError()
  if (result.structuredContent === undefined) throw new PlatformMemoryUnavailableError()
  return result.structuredContent
}

function requestContext(context: PlatformMemoryContext) {
  return { kind: context.kind, context_id: context.contextId }
}

export async function retrievePlatformPersonalMemory(input: {
  principal: GenioPrincipal
  accessToken?: string
  query?: string
  context?: PlatformMemoryContext
  limit?: number
  maxContextChars?: number
}) {
  if (!input.accessToken?.trim()) throw new PlatformMemoryUnavailableError()
  const limit = input.limit ?? 8
  const maxContextChars = input.maxContextChars ?? 3_000
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(maxContextChars) || maxContextChars < 1 || maxContextChars > 16_000) throw new PlatformMemoryOperationError("PERSONAL_MEMORY_INVALID")
  const query = input.query?.trim()
  if (query !== undefined && query.length > 512) throw new PlatformMemoryOperationError("PERSONAL_MEMORY_INVALID")
  const value = await callMemoryMcp(input.principal, input.accessToken, "memory_retrieve", {
    ...(query ? { query } : {}),
    limit,
    max_context_chars: maxContextChars,
    context: requestContext(input.context ?? GLOBAL_MEMORY_CONTEXT),
  })
  const response = record(value)
  const rows = Array.isArray(response?.memories) ? response.memories : null
  const context = typeof response?.context === "string" && response.context.length <= maxContextChars ? response.context : null
  if (!response || !rows || context === null || rows.length > limit) throw new PlatformMemoryUnavailableError()
  const memories = rows.map((entry) => memory(entry, input.principal))
  if (memories.some((entry) => entry === null)) throw new PlatformMemoryUnavailableError()
  return { memories: memories as PlatformPersonalMemory[], context }
}

export async function getPlatformPersonalMemory(input: {
  principal: GenioPrincipal
  accessToken?: string
  memoryId: string
}) {
  if (!input.accessToken?.trim()) throw new PlatformMemoryUnavailableError()
  const memoryId = identifier(input.memoryId)
  if (!memoryId) throw new PlatformMemoryOperationError("PERSONAL_MEMORY_INVALID")
  const value = await callMemoryMcp(input.principal, input.accessToken, "memory_get", { memory_id: memoryId })
  const result = memory(value, input.principal)
  if (!result || result.id !== memoryId) throw new PlatformMemoryUnavailableError()
  return result
}

export async function rememberPlatformPersonalMemory(input: {
  principal: GenioPrincipal
  accessToken?: string
  memoryId?: string
  expectedRevision: number
  key: string
  kind: PlatformMemoryKind
  content: string
  context?: PlatformMemoryContext
  sourceReferenceId?: string
}) {
  if (!input.accessToken?.trim()) throw new PlatformMemoryUnavailableError()
  const value = await callMemoryMcp(input.principal, input.accessToken, "memory_remember", {
    ...(input.memoryId ? { memory_id: input.memoryId } : {}),
    expected_revision: input.expectedRevision,
    idempotency_key: crypto.randomUUID(),
    key: input.key,
    kind: input.kind,
    content: input.content,
    context: requestContext(input.context ?? GLOBAL_MEMORY_CONTEXT),
    ...(input.sourceReferenceId ? { source_reference_id: input.sourceReferenceId } : {}),
  })
  const result = memory(value, input.principal)
  if (!result) throw new PlatformMemoryUnavailableError()
  return result
}

export async function forgetPlatformPersonalMemory(input: {
  principal: GenioPrincipal
  accessToken?: string
  memoryId: string
  expectedRevision: number
}) {
  if (!input.accessToken?.trim()) throw new PlatformMemoryUnavailableError()
  const value = await callMemoryMcp(input.principal, input.accessToken, "memory_forget", {
    memory_id: input.memoryId,
    expected_revision: input.expectedRevision,
    idempotency_key: crypto.randomUUID(),
  })
  const result = record(value)
  const id = identifier(result?.memory_id)
  const revision = integer(result?.deleted_revision, 1)
  if (!result || id === null || revision === null || result.scope !== "PERSONAL" || result.owner_subject_id !== input.principal.subject_id) throw new PlatformMemoryUnavailableError()
  return { id, revision } satisfies PlatformPersonalMemoryDeletion
}
