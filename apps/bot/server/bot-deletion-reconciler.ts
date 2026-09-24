import { createHash } from "node:crypto"
import type { BotRegistry } from "./bot-registry"
import type { BotSchedules } from "./bot-schedules"
import { platformOrigin } from "./platform-origin"
import type { GenioPrincipal, RuntimeBroker } from "./runtime-broker"

export class PlatformDistillationCancellationError extends Error {
  constructor(readonly code: string, readonly statusCode: 401 | 403 | 503) {
    super(code)
  }
}

export async function cancelPlatformDistillation(accessToken: string, tenantId: string, botId: string) {
  let response: Response
  try {
    response = await fetch(new URL(
      `/v1/tenants/${encodeURIComponent(tenantId)}/distillation-markers/bots/${encodeURIComponent(botId)}`,
      platformOrigin(),
    ), {
      method: "DELETE",
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(2_000),
    })
  } catch {
    throw new PlatformDistillationCancellationError("DISTILLATION_CANCELLATION_UNAVAILABLE", 503)
  }
  if (response.status === 200) {
    const body = await response.json().catch(() => null)
    if (
      body &&
      typeof body === "object" &&
      (body as Record<string, unknown>).bot_id === botId &&
      Number.isSafeInteger((body as Record<string, unknown>).cancelled_count) &&
      Number((body as Record<string, unknown>).cancelled_count) >= 0
    ) return
    throw new PlatformDistillationCancellationError("DISTILLATION_CANCELLATION_UNAVAILABLE", 503)
  }
  if (response.status === 401) throw new PlatformDistillationCancellationError("DISTILLATION_CANCELLATION_UNAUTHORIZED", 401)
  if (response.status === 403) throw new PlatformDistillationCancellationError("DISTILLATION_CANCELLATION_FORBIDDEN", 403)
  throw new PlatformDistillationCancellationError("DISTILLATION_CANCELLATION_UNAVAILABLE", 503)
}

export function finalizePendingBotDeletion(botRegistry: BotRegistry, botSchedules: BotSchedules, principal: GenioPrincipal, botId: string) {
  return botRegistry.db.transaction(() => {
    const finalized = botRegistry.finalizePendingDeletion(botId, principal)
    if (finalized) botSchedules.cancelBot(principal, botId)
    return finalized
  })()
}

function tokenFingerprint(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

export class BotDeletionReconciler {
  private reconciling = false
  private readonly rejectedTokens = new Map<string, string>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly batches = new Map<string, { pending: Set<string>; latestGeneration: number; definitive: boolean; ambiguous: boolean }>()

  constructor(
    private readonly botRegistry: BotRegistry,
    private readonly botSchedules: BotSchedules,
    private readonly runtimeBroker: RuntimeBroker,
  ) {}

  async reconcile() {
    if (this.reconciling || this.runtimeBroker.isClosing()) return
    this.reconciling = true
    try {
      for (const pending of this.botRegistry.pendingDeletions()) {
        const owners = this.runtimeBroker.activeSessionPrincipals().filter((principal) => principal.tenant_id === pending.tenantId && principal.subject_id === pending.ownerSubjectId)
        const attempts: Promise<void>[] = []
        for (const owner of owners) {
          const session = this.runtimeBroker.findByPrincipal(owner)
          const accessToken = session?.accessToken?.trim()
          if (!session?.initialized || !accessToken) continue
          const key = this.tokenKey(pending.tenantId, pending.ownerSubjectId, pending.botId, accessToken)
          if (this.rejectedTokens.has(key)) continue
          attempts.push(this.attempt(session.principal, pending.botId, accessToken))
        }
        await Promise.allSettled(attempts)
      }
    } finally {
      this.reconciling = false
    }
  }

  attempt(principal: GenioPrincipal, botId: string, accessToken: string) {
    const tokenKey = this.tokenKey(principal.tenant_id, principal.subject_id, botId, accessToken)
    const running = this.inFlight.get(tokenKey)
    if (running) return running
    const generation = this.botRegistry.claimPendingDeletionAttempt(botId, principal)
    if (generation === null) return Promise.resolve()
    const botKey = this.botKey(principal.tenant_id, principal.subject_id, botId)
    const batch = this.batches.get(botKey) ?? { pending: new Set<string>(), latestGeneration: generation, definitive: false, ambiguous: false }
    batch.pending.add(tokenKey)
    batch.latestGeneration = Math.max(batch.latestGeneration, generation)
    this.batches.set(botKey, batch)
    let resolveAttempt!: () => void
    let rejectAttempt!: (error: unknown) => void
    const pending = new Promise<void>((resolve, reject) => { resolveAttempt = resolve; rejectAttempt = reject })
    this.inFlight.set(tokenKey, pending)
    void (async () => {
      try {
        await cancelPlatformDistillation(accessToken, principal.tenant_id, botId)
        finalizePendingBotDeletion(this.botRegistry, this.botSchedules, principal, botId)
        resolveAttempt()
      } catch (error) {
        if (error instanceof PlatformDistillationCancellationError) {
          if (error.statusCode === 401 || error.statusCode === 403) {
            try {
              this.botRegistry.settlePendingDeletionAttempt(botId, principal)
              batch.definitive = true
              this.rejectedTokens.set(tokenKey, "rejected")
              rejectAttempt(error)
            } catch {
              batch.ambiguous = true
              rejectAttempt(new PlatformDistillationCancellationError("DISTILLATION_CANCELLATION_UNAVAILABLE", 503))
            }
          } else {
            batch.ambiguous = true
            rejectAttempt(error)
          }
        } else {
          batch.ambiguous = true
          rejectAttempt(new PlatformDistillationCancellationError("DISTILLATION_CANCELLATION_UNAVAILABLE", 503))
        }
      } finally {
        batch.pending.delete(tokenKey)
        if (batch.pending.size === 0) {
          if (batch.definitive && !batch.ambiguous) this.botRegistry.rollbackPendingDeletion(botId, principal, batch.latestGeneration)
          this.batches.delete(botKey)
        }
        if (this.inFlight.get(tokenKey) === pending) this.inFlight.delete(tokenKey)
      }
    })()
    return pending
  }

  private botKey(tenantId: string, subjectId: string, botId: string) {
    return `${tenantId}\u0000${subjectId}\u0000${botId}`
  }

  private tokenKey(tenantId: string, subjectId: string, botId: string, accessToken: string) {
    return `${tenantId}\u0000${subjectId}\u0000${botId}\u0000${tokenFingerprint(accessToken)}`
  }
}
