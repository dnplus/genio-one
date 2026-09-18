import { randomUUID } from "node:crypto"
import type { Database } from "bun:sqlite"

import type { GenioPrincipal } from "./runtime-broker"
import type { BotRecord, BotSharePolicy } from "./bot-registry"

export type BotInvocationState = "PENDING" | "APPROVED" | "DENIED" | "RUNNING" | "COMPLETED" | "FAILED" | "EXPIRED"

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
  state: BotInvocationState
  decisionReason: string | null
  expiresAt: number
  createdAt: number
  decidedAt: number | null
  resultSummary: string | null
  artifactRefs: string[]
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

export class BotInvocationStore {
  constructor(
    private readonly db: Database,
    private readonly getOwnedBot: (botId: string, principal: GenioPrincipal) => BotRecord | null,
    private readonly getBot: (botId: string, principal: GenioPrincipal) => BotRecord | null,
  ) {}

  createInvocation(principal: GenioPrincipal, input: {
    callerBotId: string
    targetBotId: string
    task: string
    selectedContextRefs?: string[]
    requestedCapabilityIds?: string[]
    actionDigest: string
    expiresAt?: number
  }): BotInvocationRequest {
    const caller = this.getOwnedBot(input.callerBotId, principal)
    const target = this.getBot(input.targetBotId, principal)
    if (!caller || !target) throw new Error("BOT_NOT_FOUND")
    if (!target.sharePolicy.invocable || !target.sharePolicy.discoverable) throw new Error("BOT_NOT_SHARED")
    if (target.sharePolicy.visibility === "SELECTED" && !target.sharePolicy.audienceIds.includes(principal.subject_id) && target.ownerSubjectId !== principal.subject_id) {
      throw new Error("BOT_AUDIENCE_DENIED")
    }
    const requestedCapabilities = [...new Set((input.requestedCapabilityIds ?? []).map((value) => value.trim()).filter(Boolean))]
    const boundCapabilities = new Set(target.bindings.filter((binding) => binding.state === "INSTALLED").map((binding) => binding.capabilityId))
    if (requestedCapabilities.some((capabilityId) => !boundCapabilities.has(capabilityId))) throw new Error("BOT_CAPABILITY_NOT_BOUND")
    const selectedContextRefs = [...new Set((input.selectedContextRefs ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 8)
    if (selectedContextRefs.some((value) => value.length > 256)) throw new Error("BOT_CONTEXT_REF_INVALID")
    const task = input.task.trim()
    if (!task) throw new Error("BOT_TASK_REQUIRED")
    const actionDigest = input.actionDigest.trim()
    if (!actionDigest) throw new Error("BOT_ACTION_DIGEST_REQUIRED")
    const now = Date.now()
    const expiresAt = Math.min(input.expiresAt ?? now + 15 * 60 * 1000, now + 15 * 60 * 1000)
    const requestId = `bot-invocation-${randomUUID()}`
    const state: BotInvocationState = target.ownerSubjectId === principal.subject_id && target.sharePolicy.approval === "POLICY_AUTO_APPROVE" ? "APPROVED" : "PENDING"
    this.db.query(`insert into bot_invocations (
      request_id, tenant_id, caller_subject_id, caller_bot_id, target_owner_subject_id,
      target_bot_id, target_agent_subject_id, task, selected_context_json,
      requested_capabilities_json, action_digest, state, decision_reason, expires_at,
      created_at, decided_at, result_summary, artifact_refs_json
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      requestId,
      principal.tenant_id,
      principal.subject_id,
      input.callerBotId,
      target.ownerSubjectId,
      target.id,
      target.agentSubjectId,
      task.slice(0, 4096),
      JSON.stringify(selectedContextRefs),
      JSON.stringify(requestedCapabilities),
      actionDigest,
      state,
      null,
      expiresAt,
      now,
      state === "APPROVED" ? now : null,
      null,
      JSON.stringify([]),
    )
    return this.getInvocation(requestId, principal)!
  }

  listInvocations(principal: GenioPrincipal, role: "caller" | "owner" = "caller"): BotInvocationRequest[] {
    const column = role === "owner" ? "target_owner_subject_id" : "caller_subject_id"
    const rows = this.db.query(`select * from bot_invocations where tenant_id = ? and ${column} = ? order by created_at desc`).all(principal.tenant_id, principal.subject_id) as Record<string, unknown>[]
    return rows.map((row) => this.mapInvocation(row))
  }

  expirePendingInvocations(): BotInvocationRequest[] {
    const rows = this.db.query("update bot_invocations set state = 'EXPIRED' where state = 'PENDING' and expires_at <= ? returning *").all(Date.now()) as Record<string, unknown>[]
    return rows.map((row) => this.mapInvocation(row))
  }

  runningInvocations(): BotInvocationRequest[] {
    const rows = this.db.query("select * from bot_invocations where state = 'RUNNING' order by created_at").all() as Record<string, unknown>[]
    return rows.map((row) => this.mapInvocation(row))
  }

  approvedInvocations(): BotInvocationRequest[] {
    const rows = this.db.query("select * from bot_invocations where state = 'APPROVED' order by created_at").all() as Record<string, unknown>[]
    return rows.map((row) => this.mapInvocation(row))
  }

  decideInvocation(principal: GenioPrincipal, requestId: string, decision: "APPROVE" | "DENY", reason = ""): BotInvocationRequest {
    const current = this.db.query("select * from bot_invocations where request_id = ? and tenant_id = ?").get(requestId, principal.tenant_id) as Record<string, unknown> | null
    if (!current) throw new Error("BOT_INVOCATION_NOT_FOUND")
    if (String(current.target_owner_subject_id) !== principal.subject_id) throw new Error("BOT_INVOCATION_OWNER_REQUIRED")
    if (String(current.state) === "PENDING" && Number(current.expires_at) <= Date.now()) {
      this.db.query("update bot_invocations set state = 'EXPIRED' where request_id = ? and state = 'PENDING'").run(requestId)
      return this.getInvocation(requestId, principal)!
    }
    if (String(current.state) !== "PENDING") return this.mapInvocation(current)
    const target = this.db.query("select share_policy_json, archived from bots where id = ? and tenant_id = ?").get(String(current.target_bot_id), principal.tenant_id) as { share_policy_json?: unknown; archived?: unknown } | null
    const share = normalizeSharePolicy(parseJson(target?.share_policy_json, DEFAULT_SHARE_POLICY))
    if (!target || Number(target.archived) === 1 || !share.discoverable || !share.invocable) {
      this.db.query("update bot_invocations set state = 'DENIED', decision_reason = ?, decided_at = ? where request_id = ? and state = 'PENDING'").run("BOT_SHARE_REVOKED", Date.now(), requestId)
      return this.getInvocation(requestId, principal)!
    }
    const next = decision === "APPROVE" ? "APPROVED" : "DENIED"
    this.db.query("update bot_invocations set state = ?, decision_reason = ?, decided_at = ? where request_id = ?").run(next, reason || null, Date.now(), requestId)
    return this.getInvocation(requestId, principal)!
  }

  beginInvocation(requestId: string): Record<string, unknown> | null {
    this.db.query("update bot_invocations set state = 'EXPIRED' where request_id = ? and state = 'APPROVED' and expires_at <= ?").run(requestId, Date.now())
    const current = this.db.query("select * from bot_invocations where request_id = ?").get(requestId) as Record<string, unknown> | null
    if (!current) return null
    const target = this.db.query("select share_policy_json, archived from bots where id = ? and tenant_id = ?").get(String(current.target_bot_id), String(current.tenant_id)) as { share_policy_json?: unknown; archived?: unknown } | null
    const share = normalizeSharePolicy(parseJson(target?.share_policy_json, DEFAULT_SHARE_POLICY))
    const sameOwner = String(current.caller_subject_id) === String(current.target_owner_subject_id)
    if (!target || Number(target.archived) === 1 || (!sameOwner && (!share.discoverable || !share.invocable))) {
      this.db.query("update bot_invocations set state = 'DENIED', decision_reason = ? where request_id = ? and state = 'APPROVED'").run("BOT_SHARE_REVOKED", requestId)
      return this.db.query("select * from bot_invocations where request_id = ?").get(requestId) as Record<string, unknown> | null
    }
    if (current.state !== "APPROVED") return null
    const transition = this.db.query("update bot_invocations set state = 'RUNNING' where request_id = ? and state = 'APPROVED'").run(requestId)
    if (transition.changes !== 1) return null
    return this.db.query("select * from bot_invocations where request_id = ?").get(requestId) as Record<string, unknown> | null
  }

  getInvocationForService(requestId: string): BotInvocationRequest | null {
    const row = this.db.query("select * from bot_invocations where request_id = ?").get(requestId) as Record<string, unknown> | null
    return row ? this.mapInvocation(row) : null
  }

  completeInvocation(requestId: string, resultSummary: string, artifactRefs: string[] = []) {
    this.db.query("update bot_invocations set state = 'COMPLETED', result_summary = ?, artifact_refs_json = ? where request_id = ? and state = 'RUNNING'").run(resultSummary, JSON.stringify(artifactRefs), requestId)
  }

  failInvocation(requestId: string, reason: string, summary: string) {
    this.db.query("update bot_invocations set state = 'FAILED', decision_reason = ?, result_summary = ? where request_id = ? and state in ('APPROVED', 'RUNNING')").run(reason, summary, requestId)
  }

  denyInvocationForService(requestId: string, reason: string) {
    this.db.query("update bot_invocations set state = 'DENIED', decision_reason = ?, result_summary = null where request_id = ? and state = 'RUNNING'").run(reason, requestId)
  }

  getInvocation(requestId: string, principal: GenioPrincipal): BotInvocationRequest | null {
    const row = this.db.query("select * from bot_invocations where request_id = ? and tenant_id = ? and (caller_subject_id = ? or target_owner_subject_id = ?)").get(requestId, principal.tenant_id, principal.subject_id, principal.subject_id) as Record<string, unknown> | null
    return row ? this.mapInvocation(row) : null
  }

  mapInvocation(row: Record<string, unknown>): BotInvocationRequest {
    return {
      requestId: String(row.request_id),
      tenantId: String(row.tenant_id),
      callerSubjectId: String(row.caller_subject_id),
      callerBotId: String(row.caller_bot_id),
      targetOwnerSubjectId: String(row.target_owner_subject_id),
      targetBotId: String(row.target_bot_id),
      targetAgentSubjectId: String(row.target_agent_subject_id),
      task: String(row.task),
      selectedContextRefs: stringArray(parseJson(row.selected_context_json, [])),
      requestedCapabilityIds: stringArray(parseJson(row.requested_capabilities_json, [])),
      actionDigest: String(row.action_digest),
      state: row.state as BotInvocationState,
      decisionReason: typeof row.decision_reason === "string" ? row.decision_reason : null,
      expiresAt: Number(row.expires_at),
      createdAt: Number(row.created_at),
      decidedAt: row.decided_at === null || row.decided_at === undefined ? null : Number(row.decided_at),
      resultSummary: typeof row.result_summary === "string" ? row.result_summary : null,
      artifactRefs: stringArray(parseJson(row.artifact_refs_json, [])),
    }
  }
}
