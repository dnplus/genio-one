import type { HandsIsolateResult } from "@genioone/protocol/hands"
import { assertCapability, PERSONAL_BOT_USE } from "./capability-gate"
import { handsBackendFor } from "./hands-provider"
import type { BotServerContext } from "./context"
import { handsCorrelationId } from "./hands-placement-gate"
import { requireRuntimePolicyDecision } from "./runtime-policy"
import type { GenioPrincipal } from "./runtime-broker"
import type { RuntimePolicyDecision } from "./runtime-policy-contract"

export interface IsolateInput {
  workspaceId?: string
  requestId: string
  code: string
  workspaceAccess?: "none" | "read" | "read-write"
  timeoutMs?: number
}

export async function executeHandsIsolate(context: BotServerContext, principal: GenioPrincipal, botId: string, accessToken: string, input: IsolateInput): Promise<HandsIsolateResult> {
  if (!context.botRegistry.getOwned(botId, principal)) throw new Error("BOT_NOT_FOUND")
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId)) throw new Error("HANDS_REQUEST_ID_INVALID")
  if (typeof input.code !== "string" || input.code.length === 0 || input.code.length > 65_536 || input.code.trim() !== input.code) throw new Error("HANDS_ISOLATE_CODE_INVALID")
  const workspaceAccess = input.workspaceAccess ?? "none"
  if (workspaceAccess !== "none" && workspaceAccess !== "read" && workspaceAccess !== "read-write") throw new Error("HANDS_WORKSPACE_ACCESS_INVALID")
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 30_000)) throw new Error("HANDS_ISOLATE_TIMEOUT_INVALID")
  const actor = { principal, botId, accessToken, sessionId: context.runtimeBroker.findByPrincipal(principal)?.id }
  let workspace = input.workspaceId
    ? context.workspaces.get(principal, botId, input.workspaceId)
    : context.workspaces.active(principal, botId)
  if (!workspace && !input.workspaceId) {
    const provider = await context.handsPlacement.providerForNew(actor)
    if (provider !== "cloudflare-hands") throw new Error("HANDS_ISOLATE_PROVIDER_UNSUPPORTED")
    workspace = await context.handsPlacement.run(actor, provider, () => context.workspaces.create(principal, botId, provider), handsCorrelationId(input.requestId, botId, "remote_hands.use", "workspace.create"))
  }
  if (!workspace) throw new Error("WORKSPACE_NOT_FOUND")
  const backend = handsBackendFor(workspace.provider)
  if (!backend.supportsJavascript) throw new Error("HANDS_ISOLATE_PROVIDER_UNSUPPORTED")
  const executionActor = { ...actor, sessionId: workspace.workspaceId }
  return context.workspaces.runIsolate(workspace.workspaceId, input.requestId, { code: input.code, timeoutMs: input.timeoutMs, workspaceAccess }, async () => {
  await context.handsPlacement.authorizeUse(executionActor, workspace.provider, handsCorrelationId(input.requestId, botId, "remote_hands.use", "use"))
  if (context.runtimeBroker.hasActiveWorkspaceLease(workspace.workspaceId)) throw new Error("WORKSPACE_BUSY")
  await assertCapability(context.capabilityGate, principal, PERSONAL_BOT_USE, accessToken)
  const capabilities = [
    { capabilityId: "code.javascript", action: "execute" },
    ...(workspaceAccess === "read" || workspaceAccess === "read-write" ? [{ capabilityId: "filesystem.read", action: "invoke" }] : []),
    ...(workspaceAccess === "read-write" ? [{ capabilityId: "filesystem.write", action: "invoke" }] : []),
  ] as Array<{ capabilityId: "code.javascript" | "filesystem.read" | "filesystem.write"; action: "execute" | "invoke" }>
  const decisions: Array<{ decision: RuntimePolicyDecision; correlationId: string }> = []
  let outcome: "COMPLETED" | "FAILED" | "DENY" = "FAILED"
  let reasonCode: string | undefined
  try {
    for (const capability of capabilities) {
      const correlationId = handsCorrelationId(input.requestId, botId, capability.capabilityId, capability.action)
      const decision = await context.runtimePolicy.authorize({
        principal,
        botId,
        runtimeId: "codex",
        capabilityId: capability.capabilityId,
        action: capability.action,
        sessionId: workspace.workspaceId,
        correlationId,
        accessToken,
      })
      decisions.push({ decision, correlationId })
      requireRuntimePolicyDecision(decision)
    }
    const result = await backend.runJavascript(workspace, context.workspaces, {
      runtimeSessionId: workspace.workspaceId,
      requestId: input.requestId,
      code: input.code,
      workspaceAccess,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      expectedRevision: workspace.revision,
    }, principal.acting_client_id)
    outcome = result.exitCode === 0 ? "COMPLETED" : "FAILED"
    if (result.exitCode !== 0) reasonCode = "HANDS_ISOLATE_EXIT_NONZERO"
    return result
  } catch (error) {
    reasonCode = error instanceof Error ? error.message : "HANDS_ISOLATE_FAILED"
    outcome = decisions.at(-1)?.decision.decision === "DENY" ? "DENY" : "FAILED"
    throw error
  } finally {
    let reportFailed = false
    for (const entry of decisions) {
      const { decision, correlationId } = entry
      try {
        await context.runtimePolicy.report({
          principal,
          botId,
          runtimeId: "codex",
          capabilityId: decision.capability_id as "code.javascript" | "filesystem.read" | "filesystem.write",
          action: decision.action as "execute" | "invoke",
          sessionId: workspace.workspaceId,
          correlationId: decision.correlation_id ?? correlationId,
          accessToken,
          outcome: decision.decision === "DENY" ? "DENY" : outcome,
          reasonCode,
        })
      } catch { reportFailed = true }
    }
    if (reportFailed) throw new Error("HANDS_RESULT_UNCONFIRMED")
  }
  })
}
