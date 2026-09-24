import { createHash, randomUUID } from "node:crypto"
import type { HandsProvider, HandsWorkspace } from "@genioone/protocol/hands"
import { handsProviderDomain, handsProviderForDomain, readHandsExecutionPlacement } from "@genioone/protocol/hands-placement"
import { configuredHandsProvider, type BotWorkspaceStore } from "./bot-workspace-store"
import { requireRuntimePolicyDecision, RuntimePolicyDeniedError } from "./runtime-policy"
import type { RuntimePolicyCapabilityId, RuntimePolicyDecision, RuntimePolicyExecutableAction, RuntimePolicyResolver } from "./runtime-policy-contract"
import type { GenioPrincipal } from "./runtime-broker"

export interface HandsPlacementActor {
  principal: GenioPrincipal
  botId: string
  accessToken: string
  sessionId?: string
}

export function handsCorrelationId(requestId: string, botId: string, capabilityId: string, action: string) {
  const hex = createHash("sha256").update(`${requestId}\u0000${botId}\u0000${capabilityId}\u0000${action}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export class HandsPlacementGate {
  constructor(private readonly policy: RuntimePolicyResolver, private readonly workspaces: BotWorkspaceStore) {}

  async providerForNew(actor: HandsPlacementActor): Promise<HandsProvider> {
    const decision = await this.policy.resolve({
      principal: actor.principal,
      botId: actor.botId,
      runtimeId: "codex",
      capabilityId: "remote_hands.use",
      action: "use",
      sessionId: actor.sessionId,
      accessToken: actor.accessToken,
      handsPlacement: { mode: "inspect" },
    })
    if (decision.decision !== "ALLOW") throw new RuntimePolicyDeniedError(decision)
    const domain = readHandsExecutionPlacement(decision.constraints)
    return domain ? handsProviderForDomain(domain) : configuredHandsProvider()
  }

  async run<T>(actor: HandsPlacementActor, provider: HandsProvider, task: () => Promise<T> | T, correlationId: string = randomUUID(), successOutcome: "ALLOW" | "COMPLETED" = "COMPLETED"): Promise<T> {
    let decision: RuntimePolicyDecision | null = null
    let outcome: "ALLOW" | "COMPLETED" | "FAILED" | "DENY" = "FAILED"
    let reasonCode: string | undefined
    try {
      decision = await this.policy.authorize({
        principal: actor.principal,
        botId: actor.botId,
        runtimeId: "codex",
        capabilityId: "remote_hands.use",
        action: "use",
        sessionId: actor.sessionId,
        correlationId,
        accessToken: actor.accessToken,
        handsPlacement: { mode: "enforce", provider },
      })
      requireRuntimePolicyDecision(decision, { mode: "enforce", provider })
      const result = await task()
      outcome = successOutcome
      return result
    } catch (error) {
      outcome = decision?.decision === "DENY" && decision.reason_code !== "POLICY_PLACEMENT_CHANGED" ? "DENY" : "FAILED"
      reasonCode = error instanceof Error ? error.message : "HANDS_PLACEMENT_FAILED"
      throw error
    } finally {
      if (decision) {
        try {
          await this.policy.report({
            principal: actor.principal,
            botId: actor.botId,
            runtimeId: "codex",
            capabilityId: "remote_hands.use",
            action: "use",
            sessionId: actor.sessionId,
            correlationId: decision.correlation_id ?? correlationId,
            accessToken: actor.accessToken,
            outcome,
            reasonCode,
          })
        } catch { throw new Error("HANDS_POLICY_REPORT_UNAVAILABLE") }
        let workspaceId: string | null = null
        try { workspaceId = this.workspaces.active(actor.principal, actor.botId)?.workspaceId ?? null } catch {}
        console.info(JSON.stringify({ event: "hands.placement.reported", tenant_id: actor.principal.tenant_id, bot_id: actor.botId, actor_subject_id: actor.principal.subject_id, actor_client_id: actor.principal.acting_client_id, workspace_id: workspaceId, provider, execution_domain: handsProviderDomain(provider), policy_id: decision.policy_id, policy_revision: decision.policy_revision, correlation_id: decision.correlation_id ?? correlationId, outcome }))
      }
    }
  }

  authorizeUse(actor: HandsPlacementActor, provider: HandsProvider, correlationId: string = randomUUID()) {
    return this.run(actor, provider, () => undefined, correlationId, "ALLOW")
  }

  async authorizeLocalEndpoint(actor: HandsPlacementActor) {
    const correlationId = randomUUID()
    const placement = { mode: "enforce" as const, localEndpoint: true as const }
    const decision = await this.policy.authorize({ principal: actor.principal, botId: actor.botId, runtimeId: "codex", capabilityId: "remote_hands.use", action: "use", sessionId: actor.sessionId, correlationId, accessToken: actor.accessToken, handsPlacement: placement })
    let outcome: "ALLOW" | "DENY" | "FAILED" = "ALLOW"
    let reasonCode: string | undefined
    try { requireRuntimePolicyDecision(decision, placement) }
    catch (error) {
      outcome = decision.decision === "DENY" && decision.reason_code !== "POLICY_PLACEMENT_CHANGED" ? "DENY" : "FAILED"
      reasonCode = error instanceof Error ? error.message : "RUNTIME_POLICY_DENIED"
      throw error
    } finally {
      await this.policy.report({ principal: actor.principal, botId: actor.botId, runtimeId: "codex", capabilityId: "remote_hands.use", action: "use", sessionId: actor.sessionId, correlationId: decision.correlation_id ?? correlationId, accessToken: actor.accessToken, outcome, reasonCode })
    }
  }

  async beginCapability(actor: HandsPlacementActor, capabilityId: RuntimePolicyCapabilityId, action: RuntimePolicyExecutableAction, correlationId: string = randomUUID()) {
    const decision = await this.policy.authorize({ principal: actor.principal, botId: actor.botId, runtimeId: "codex", capabilityId, action, sessionId: actor.sessionId, correlationId, accessToken: actor.accessToken })
    try { requireRuntimePolicyDecision(decision) }
    catch (error) {
      const reasonCode = error instanceof Error ? error.message : "HANDS_CAPABILITY_DENIED"
      await this.policy.report({ principal: actor.principal, botId: actor.botId, runtimeId: "codex", capabilityId, action, sessionId: actor.sessionId, correlationId: decision.correlation_id ?? correlationId, accessToken: actor.accessToken, outcome: decision.decision === "DENY" ? "DENY" : "FAILED", reasonCode })
      throw error
    }
    let reportPromise: Promise<void> | null = null
    return async (outcome: "COMPLETED" | "FAILED", reasonCode?: string) => {
      reportPromise ??= this.policy.report({ principal: actor.principal, botId: actor.botId, runtimeId: "codex", capabilityId, action, sessionId: actor.sessionId, correlationId: decision.correlation_id ?? correlationId, accessToken: actor.accessToken, outcome, reasonCode })
      await reportPromise
    }
  }

  async runCapability<T>(actor: HandsPlacementActor, capabilityId: RuntimePolicyCapabilityId, action: RuntimePolicyExecutableAction, task: () => Promise<T> | T, correlationId: string = randomUUID(), successOutcome: "ALLOW" | "COMPLETED" = "COMPLETED"): Promise<T> {
    let decision: RuntimePolicyDecision | null = null
    let outcome: "ALLOW" | "COMPLETED" | "FAILED" | "DENY" = "FAILED"
    let reasonCode: string | undefined
    try {
      decision = await this.policy.authorize({ principal: actor.principal, botId: actor.botId, runtimeId: "codex", capabilityId, action, sessionId: actor.sessionId, correlationId, accessToken: actor.accessToken })
      requireRuntimePolicyDecision(decision)
      const result = await task()
      outcome = successOutcome
      return result
    } catch (error) {
      outcome = decision?.decision === "DENY" ? "DENY" : "FAILED"
      reasonCode = error instanceof Error ? error.message : "HANDS_CAPABILITY_FAILED"
      throw error
    } finally {
      if (decision) {
        try {
          await this.policy.report({ principal: actor.principal, botId: actor.botId, runtimeId: "codex", capabilityId, action, sessionId: actor.sessionId, correlationId: decision.correlation_id ?? correlationId, accessToken: actor.accessToken, outcome, reasonCode })
        } catch { throw new Error("HANDS_POLICY_REPORT_UNAVAILABLE") }
      }
    }
  }

  async ensureWorkspace(actor: HandsPlacementActor): Promise<HandsWorkspace> {
    const active = this.workspaces.active(actor.principal, actor.botId)
    const provider = active?.provider ?? await this.providerForNew(actor)
    return this.run(actor, provider, () => active ?? this.workspaces.create(actor.principal, actor.botId, provider))
  }
}
