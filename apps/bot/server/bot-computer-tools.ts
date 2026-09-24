import { randomUUID } from "node:crypto"

import { assertCapability, PERSONAL_BOT_COMPUTER_USE } from "./capability-gate"
import { type DesktopComputerOperation, validComputerKey } from "./desktop-driver"
import type { BotToolDefinition, BotToolExecution, BotToolResponse } from "./bot-tool-contract"
import { requireRuntimePolicyDecision } from "./runtime-policy"
import type { RuntimeSession } from "./runtime-broker"

const COMPUTER_USE_CAPABILITY = "computer.use"

export const computerToolDefinitions: readonly BotToolDefinition[] = [{
  name: "computer_use",
  description: "Operate the Bot's managed desktop through a governed screenshot, pointer, keyboard, or scroll action. Take a screenshot first, pass its observationRevision to every mutating action, and never retry an action after an uncertain result. This never controls the Bot host or a Local Hands endpoint.",
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["screenshot", "click", "double_click", "right_click", "type", "key", "scroll"] },
      x: { type: "integer", minimum: 0, maximum: 4095 },
      y: { type: "integer", minimum: 0, maximum: 4095 },
      text: { type: "string", minLength: 1, maxLength: 4000 },
      keys: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 1, maxLength: 16 } },
      direction: { type: "string", enum: ["up", "down"] },
      amount: { type: "integer", minimum: 1, maximum: 10 },
      expectedRevision: { type: "integer", minimum: 0 },
    },
    required: ["operation"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}]

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= minimum && value <= maximum
}

function expectedRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!integer(value, 0, Number.MAX_SAFE_INTEGER)) throw new Error("COMPUTER_EXPECTED_REVISION_INVALID")
  return value
}

function computerOperation(args: unknown): { operation: DesktopComputerOperation; expectedRevision?: number } {
  const value = record(args)
  if (!value || Object.keys(value).some((key) => !["operation", "x", "y", "text", "keys", "direction", "amount", "expectedRevision"].includes(key))) throw new Error("COMPUTER_ARGUMENTS_INVALID")
  const revision = expectedRevision(value.expectedRevision)
  if (value.operation === "screenshot") return { operation: { operation: "screenshot" }, expectedRevision: revision }
  if (revision === undefined) throw new Error("COMPUTER_OBSERVATION_REQUIRED")
  if (value.operation === "click" || value.operation === "double_click" || value.operation === "right_click") {
    if (!integer(value.x, 0, 4095) || !integer(value.y, 0, 4095)) throw new Error("COMPUTER_COORDINATES_INVALID")
    return { operation: { operation: value.operation, x: value.x, y: value.y }, expectedRevision: revision }
  }
  if (value.operation === "type") {
    if (typeof value.text !== "string" || value.text.length === 0 || value.text.length > 4000) throw new Error("COMPUTER_TEXT_INVALID")
    return { operation: { operation: "type", text: value.text }, expectedRevision: revision }
  }
  if (value.operation === "key") {
    if (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 3 || value.keys.some((key) => !validComputerKey(key))) throw new Error("COMPUTER_KEY_INVALID")
    return { operation: { operation: "key", keys: value.keys }, expectedRevision: revision }
  }
  if (value.operation === "scroll") {
    if ((value.direction !== "up" && value.direction !== "down") || !integer(value.amount, 1, 10)) throw new Error("COMPUTER_SCROLL_INVALID")
    return { operation: { operation: "scroll", direction: value.direction, amount: value.amount }, expectedRevision: revision }
  }
  throw new Error("COMPUTER_OPERATION_INVALID")
}

function response(operation: DesktopComputerOperation, result: { revision: number; screenshot?: Uint8Array }, provider: string): BotToolResponse {
  const status = { provider, operation: operation.operation, observationRevision: result.revision }
  if (!result.screenshot) return { content: [{ type: "text", text: JSON.stringify(status) }] }
  return {
    content: [
      { type: "image", data: Buffer.from(result.screenshot).toString("base64"), mimeType: "image/png" },
      { type: "text", text: JSON.stringify({ ...status, bytes: result.screenshot.byteLength }) },
    ],
  }
}

export async function executeComputerTool(name: string, args: unknown, execution: BotToolExecution): Promise<BotToolResponse> {
  if (name !== "computer_use") throw new Error("BOT_TOOL_NOT_FOUND")
  const parsed = computerOperation(args)
  const { context, botId, principal, accessToken } = execution
  if (!context.botRegistry.getOwned(botId, principal)) throw new Error("BOT_NOT_FOUND")
  await assertCapability(context.capabilityGate, principal, PERSONAL_BOT_COMPUTER_USE, accessToken)
  const existing = context.runtimeBroker.findByPrincipal(principal)
  if (!existing) throw new Error("RUNTIME_SESSION_NOT_FOUND")
  const exposeCorrelationId = randomUUID()
  const exposure = await context.runtimePolicy.authorize({
    principal,
    botId,
    runtimeId: "codex",
    capabilityId: COMPUTER_USE_CAPABILITY,
    action: "expose",
    sessionId: existing.id,
    correlationId: exposeCorrelationId,
    accessToken,
  })
  try {
    requireRuntimePolicyDecision(exposure)
  } catch (error) {
    await context.runtimePolicy.report({
      principal,
      botId,
      runtimeId: "codex",
      capabilityId: COMPUTER_USE_CAPABILITY,
      action: "expose",
      sessionId: existing.id,
      correlationId: exposeCorrelationId,
      accessToken,
      outcome: "DENY",
      reasonCode: error instanceof Error ? error.message : "COMPUTER_POLICY_DENIED",
    })
    throw error
  }
  const correlationId = randomUUID()
  let policy
  try {
    policy = await context.runtimePolicy.authorize({
      principal,
      botId,
      runtimeId: "codex",
      capabilityId: COMPUTER_USE_CAPABILITY,
      action: "invoke",
      sessionId: existing.id,
      correlationId,
      accessToken,
    })
  } catch (error) {
    await context.runtimePolicy.report({
      principal,
      botId,
      runtimeId: "codex",
      capabilityId: COMPUTER_USE_CAPABILITY,
      action: "expose",
      sessionId: existing.id,
      correlationId: exposeCorrelationId,
      accessToken,
      outcome: "FAILED",
      reasonCode: error instanceof Error ? error.message : "COMPUTER_POLICY_AUTHORIZE_FAILED",
    }).catch(() => undefined)
    throw error
  }
  try {
    requireRuntimePolicyDecision(policy)
  } catch (error) {
    await Promise.all([
      context.runtimePolicy.report({
        principal,
        botId,
        runtimeId: "codex",
        capabilityId: COMPUTER_USE_CAPABILITY,
        action: "expose",
        sessionId: existing.id,
        correlationId: exposeCorrelationId,
        accessToken,
        outcome: "ALLOW",
      }),
      context.runtimePolicy.report({
        principal,
        botId,
        runtimeId: "codex",
        capabilityId: COMPUTER_USE_CAPABILITY,
        action: "invoke",
        sessionId: existing.id,
        correlationId,
        accessToken,
        outcome: "DENY",
        reasonCode: error instanceof Error ? error.message : "COMPUTER_POLICY_DENIED",
      }),
    ])
    throw error
  }
  let session: RuntimeSession
  let exposureOutcome: "COMPLETED" | "FAILED" = "FAILED"
  let exposureFailure: string | undefined
  let exposureReportUnconfirmed = false
  try {
    session = await context.runtimeBroker.ensure(existing.id, "desktop", botId)
    exposureOutcome = "COMPLETED"
  } catch (error) {
    exposureFailure = error instanceof Error ? error.message : "COMPUTER_DESKTOP_PROVISION_FAILED"
    await context.runtimePolicy.report({
      principal,
      botId,
      runtimeId: "codex",
      capabilityId: COMPUTER_USE_CAPABILITY,
      action: "invoke",
      sessionId: existing.id,
      correlationId,
      accessToken,
      outcome: "FAILED",
      reasonCode: exposureFailure,
    }).catch(() => undefined)
    throw error
  } finally {
    try {
      await context.runtimePolicy.report({
        principal,
        botId,
        runtimeId: "codex",
        capabilityId: COMPUTER_USE_CAPABILITY,
        action: "expose",
        sessionId: existing.id,
        correlationId: exposeCorrelationId,
        accessToken,
        outcome: exposureOutcome,
        reasonCode: exposureFailure,
      })
    } catch (error) {
      exposureReportUnconfirmed = exposureOutcome === "COMPLETED"
    }
  }
  if (exposureReportUnconfirmed) {
    await context.runtimePolicy.report({
      principal,
      botId,
      runtimeId: "codex",
      capabilityId: COMPUTER_USE_CAPABILITY,
      action: "invoke",
      sessionId: session.id,
      correlationId,
      accessToken,
      outcome: "FAILED",
      reasonCode: "COMPUTER_RESULT_UNCONFIRMED",
    }).catch(() => undefined)
    throw new Error("COMPUTER_RESULT_UNCONFIRMED")
  }
  let outcome: "COMPLETED" | "FAILED" = "FAILED"
  let reasonCode: string | undefined
  try {
    if (context.runtimeBroker.get(session.id) !== session) throw new Error("RUNTIME_SESSION_CHANGED")
    const lease = session.leases.desktop
    const computer = lease?.computer
    if (!lease || (lease.details.kind !== "e2b-self-hosted" && lease.details.kind !== "cloudflare-hands") || lease.details.tier !== "desktop" || !computer || !lease.details.execReady || lease.details.botId !== botId) throw new Error("MANAGED_DESKTOP_REQUIRED")
    if (
      computer.binding.runtimeSessionId !== session.id ||
      computer.binding.tenantId !== principal.tenant_id ||
      computer.binding.subjectId !== principal.subject_id ||
      computer.binding.actingClientId !== principal.acting_client_id
    ) throw new Error("COMPUTER_LEASE_BINDING_INVALID")
    const result = await computer.execute(parsed.operation, {
      actorBotId: botId,
      expectedRevision: parsed.expectedRevision,
      assertCurrent: () => {
        if (!context.botRegistry.getOwned(botId, principal)) throw new Error("BOT_NOT_FOUND")
        if (
          context.runtimeBroker.get(session.id) !== session ||
          session.leases.desktop !== lease ||
          lease.computer !== computer
        ) throw new Error("RUNTIME_SESSION_CHANGED")
      },
    })
    outcome = "COMPLETED"
    return response(parsed.operation, result, lease.details.kind)
  } catch (error) {
    reasonCode = error instanceof Error ? error.message : "COMPUTER_OPERATION_FAILED"
    throw error
  } finally {
    try {
      await context.runtimePolicy.report({
        principal,
        botId,
        runtimeId: "codex",
        capabilityId: COMPUTER_USE_CAPABILITY,
        action: "invoke",
        sessionId: session.id,
        correlationId,
        accessToken,
        outcome,
        reasonCode,
      })
    } catch (error) {
      if (outcome === "COMPLETED") throw new Error("COMPUTER_RESULT_UNCONFIRMED")
    }
  }
}
