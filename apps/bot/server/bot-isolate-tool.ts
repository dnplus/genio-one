import type { BotToolDefinition, BotToolExecution, BotToolResponse } from "./bot-tool-contract"
import { executeHandsIsolate } from "./hands-isolate"

export const isolateToolDefinitions: readonly BotToolDefinition[] = [{
  name: "run_workspace_javascript",
  description: "Run JavaScript in the Bot's Cloudflare Hands workspace. Choose workspaceAccess explicitly: none for pure computation, read for files, or read-write for file changes. Use a stable requestId UUID for retries. If WORKSPACE_BUSY, explicitly release the native environment before retrying. The result includes the persisted workspace revision.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string", pattern: "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$" },
      code: { type: "string", minLength: 1, maxLength: 65536 },
      workspaceAccess: { type: "string", enum: ["none", "read", "read-write"] },
      timeoutMs: { type: "integer", minimum: 100, maximum: 30000 },
      workspaceId: { type: "string", minLength: 36, maxLength: 36 },
    },
    required: ["requestId", "code", "workspaceAccess"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}]

export async function executeIsolateTool(name: string, args: unknown, execution: BotToolExecution): Promise<BotToolResponse> {
  if (name !== "run_workspace_javascript") throw new Error("BOT_TOOL_NOT_FOUND")
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("HANDS_ISOLATE_ARGUMENTS_INVALID")
  const input = args as Record<string, unknown>
  if (Object.keys(input).some((key) => !["requestId", "code", "workspaceAccess", "timeoutMs", "workspaceId"].includes(key))) throw new Error("HANDS_ISOLATE_ARGUMENTS_INVALID")
  const result = await executeHandsIsolate(execution.context, execution.principal, execution.botId, execution.accessToken, {
    requestId: typeof input.requestId === "string" ? input.requestId : "",
    code: typeof input.code === "string" ? input.code : "",
    workspaceAccess: input.workspaceAccess === "none" || input.workspaceAccess === "read" || input.workspaceAccess === "read-write" ? input.workspaceAccess : undefined,
    ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
    ...(typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
  })
  return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.exitCode !== 0 }
}
