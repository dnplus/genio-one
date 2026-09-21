import { randomUUID } from "node:crypto"
import { assertCapability, PERSONAL_BOT_USE, PERSONAL_BOT_COMPUTER_USE } from "./capability-gate"
import { computerToolDefinitions, executeComputerTool } from "./bot-computer-tools"
import { scheduleToolDefinitions, executeScheduleTool } from "./bot-schedule-tools"
import { selfToolDefinitions, executeSelfTool } from "./bot-self-tools"
import type { BotToolExecution, BotToolResponse } from "./bot-tool-contract"
import { requireRuntimePolicyDecision } from "./runtime-policy"

const families = [
  { definitions: selfToolDefinitions, execute: executeSelfTool },
  { definitions: scheduleToolDefinitions, execute: executeScheduleTool },
  { definitions: computerToolDefinitions, execute: executeComputerTool },
]

export const botDefaultToolDefinitions = families.flatMap((family) => family.definitions)

export async function listBotDefaultTools(execution: BotToolExecution) {
  const { context, botId, principal, accessToken } = execution
  try {
    await assertCapability(context.capabilityGate, principal, PERSONAL_BOT_COMPUTER_USE, accessToken)
    const snapshot = await context.runtimePolicy.read({ principal, botId, runtimeId: "codex", capabilityIds: ["computer.use"], action: "expose", accessToken })
    const decision = snapshot.decisions.find((entry) => entry.capability_id === "computer.use" && entry.action === "expose")
    if (!decision) throw new Error("COMPUTER_EXPOSURE_UNAVAILABLE")
    requireRuntimePolicyDecision(decision)
    return botDefaultToolDefinitions
  } catch {
    return botDefaultToolDefinitions.filter((definition) => !computerToolDefinitions.some((computer) => computer.name === definition.name))
  }
}

export function isBotDefaultTool(name: unknown): name is string {
  return typeof name === "string" && botDefaultToolDefinitions.some((tool) => tool.name === name)
}

export async function executeBotDefaultTool(name: string, args: unknown, execution: BotToolExecution): Promise<BotToolResponse> {
  const family = families.find((candidate) => candidate.definitions.some((tool) => tool.name === name))
  if (!family) throw new Error("BOT_TOOL_NOT_FOUND")
  const { context, botId, principal, accessToken } = execution
  if (!context.botRegistry.getOwned(botId, principal)) throw new Error("BOT_NOT_FOUND")
  const correlationId = randomUUID()
  try {
    await assertCapability(context.capabilityGate, principal, PERSONAL_BOT_USE, accessToken)
    const result = await family.execute(name, args, execution)
    console.info(JSON.stringify({ event: "bot.default_tool.completed", tool: name, bot_id: botId, tenant_id: principal.tenant_id, actor_subject: principal.subject_id, correlation_id: correlationId, outcome: result.isError ? "FAILED" : "COMPLETED" }))
    return result
  } catch (error) {
    console.warn(JSON.stringify({ event: "bot.default_tool.failed", tool: name, bot_id: botId, tenant_id: principal.tenant_id, actor_subject: principal.subject_id, correlation_id: correlationId }))
    throw error
  }
}
