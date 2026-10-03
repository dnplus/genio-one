import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"

import type {
  MemoryTargetRetrieve,
  PersonalMemoryCommand,
  PersonalMemoryDelete,
  PersonalMemoryList,
  SharedMemory,
} from "../../platform/platform-api/src/capabilities/memories/contract"
import type { SharedMemoryDirectory } from "../../platform/platform-api/src/capabilities/memories/module"
import type { Principal } from "../../platform/platform-api/src/capabilities/tenancy-auth/contract"

const identifier = z.string().trim().min(1).max(256)
const idempotencyKey = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const context = z.object({
  kind: z.enum(["GLOBAL", "PROJECT", "CONTEXT"]),
  context_id: identifier.nullable(),
}).strict().superRefine((value, issue) => {
  if ((value.kind === "GLOBAL") !== (value.context_id === null)) {
    issue.addIssue({ code: "custom", message: "MEMORY_CONTEXT_INVALID" })
  }
})
const teamTarget = z.object({
  scope: z.literal("TEAM"),
  workspace_id: identifier,
}).strict()
const organizationTarget = z.object({
  scope: z.literal("ORGANIZATION"),
  organization_id: identifier,
}).strict()
const sharedTarget = z.discriminatedUnion("scope", [teamTarget, organizationTarget])
const personalTarget = z.object({ scope: z.literal("PERSONAL") }).strict()
const memoryTarget = z.discriminatedUnion("scope", [personalTarget, teamTarget, organizationTarget])
const retrieveTargets = z.array(memoryTarget).min(1).max(20).superRefine((values, issue) => {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    const key = value.scope === "PERSONAL"
      ? "PERSONAL"
      : value.scope === "TEAM"
        ? `TEAM:${value.workspace_id}`
        : `ORGANIZATION:${value.organization_id}`
    if (seen.has(key)) {
      issue.addIssue({
        code: "custom",
        message: "MEMORY_TARGET_DUPLICATE",
        path: [index],
      })
    }
    seen.add(key)
  }
})

export interface MemoryMcpCompleted {
  tool: "memory_list" | "memory_retrieve" | "memory_get" | "memory_remember" | "memory_forget" | "memory_scope_list"
  outcome: "SUCCEEDED" | "FAILED"
  result_count?: number
  memory_id?: string
  proposal_id?: string
  revision?: number
  error_code?: string
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code
  }
  return "MEMORY_OPERATION_FAILED"
}

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  }
}

function failure(code: string) {
  return { isError: true, content: [{ type: "text" as const, text: code }] }
}

function memoryResult(value: SharedMemory): Record<string, unknown> {
  return value
}

export async function handleMemoryMcp(request: Request, options: {
  actor: Principal
  directory: Pick<
    SharedMemoryDirectory,
    | "listPersonalAsAgent"
    | "retrievePersonalAsAgent"
    | "getPersonalAsAgent"
    | "rememberPersonalAsAgent"
    | "deletePersonalAsAgent"
    | "listMemoryScopesAsAgent"
    | "listSharedAsAgent"
    | "retrieveMemoryTargetsAsAgent"
    | "getSharedAsAgent"
    | "rememberSharedAsAgent"
    | "deleteSharedAsAgent"
  >
  completed: (input: MemoryMcpCompleted) => void
}): Promise<Response> {
  const server = new McpServer({ name: "genio-one-memory", version: "1.0.0" })
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  const execute = async <T extends Record<string, unknown>>(
    tool: MemoryMcpCompleted["tool"],
    operation: () => Promise<{ value: T; completion: Omit<MemoryMcpCompleted, "tool" | "outcome"> }>,
  ) => {
    try {
      const completed = await operation()
      options.completed({ tool, outcome: "SUCCEEDED", ...completed.completion })
      return result(completed.value)
    } catch (error) {
      const code = errorCode(error)
      options.completed({ tool, outcome: "FAILED", error_code: code })
      return failure(code)
    }
  }

  server.registerTool("memory_list", {
    title: "列出記憶",
    description: "列出目前已授權使用者的個人或明確指定共享範圍長期記憶。只保存與使用長期有價值的偏好、背景與決定；不要把完整對話或工作摘要當成記憶。",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().min(1).max(512).optional(),
      context: context.optional(),
      target: sharedTarget.optional(),
    }).strict(),
    annotations: read,
  }, (input) => execute("memory_list", async () => {
    const { target, ...command } = input
    const value = target === undefined
      ? await options.directory.listPersonalAsAgent(options.actor, command satisfies PersonalMemoryList)
      : await options.directory.listSharedAsAgent(options.actor, target, command satisfies PersonalMemoryList)
    return { value, completion: { result_count: value.memories.length } }
  }))

  server.registerTool("memory_retrieve", {
    title: "擷取相關記憶",
    description: "依查詢擷取目前使用者的相關長期記憶作為工作脈絡。未指定 targets 時只擷取個人記憶；可明確選擇個人、團隊或組織範圍。",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(512).optional(),
      limit: z.number().int().min(1).max(20).optional(),
      max_context_chars: z.number().int().min(1).max(16_000).optional(),
      context: context.optional(),
      targets: retrieveTargets.optional(),
    }).strict(),
    annotations: read,
  }, (input) => execute("memory_retrieve", async () => {
    const value = await options.directory.retrieveMemoryTargetsAsAgent(
      options.actor,
      input satisfies MemoryTargetRetrieve,
    )
    return { value, completion: { result_count: value.memories.length } }
  }))

  server.registerTool("memory_get", {
    title: "讀取記憶",
    description: "讀取指定的個人或明確指定共享範圍長期記憶。",
    inputSchema: z.object({
      memory_id: identifier,
      target: sharedTarget.optional(),
    }).strict(),
    annotations: read,
  }, (input) => execute("memory_get", async () => {
    const value = input.target === undefined
      ? await options.directory.getPersonalAsAgent(options.actor, input.memory_id)
      : await options.directory.getSharedAsAgent(options.actor, input.target, input.memory_id)
    return { value: memoryResult(value), completion: { result_count: 1, memory_id: value.memory_id, revision: value.revision } }
  }))

  server.registerTool("memory_remember", {
    title: "保存記憶",
    description: "保存 Agent 推斷出的長期有價值偏好、背景或決定。不得保存完整對話或工作摘要；使用者明確更正只能由使用者自己的介面進行。共享範圍必須明確提供 context，即使是 GLOBAL。",
    inputSchema: z.object({
      memory_id: identifier.optional(),
      expected_revision: z.number().int().min(0),
      idempotency_key: idempotencyKey,
      key: identifier,
      kind: z.enum(["preference", "fact", "decision"]),
      context: context.optional(),
      content: z.string().min(1).max(12_000),
      source_reference_id: identifier.optional(),
      target: sharedTarget.optional(),
    }).strict().superRefine((value, issue) => {
      if (value.target !== undefined && value.context === undefined) {
        issue.addIssue({ code: "custom", message: "MEMORY_CONTEXT_REQUIRED", path: ["context"] })
      }
    }),
    annotations: write,
  }, (input) => execute("memory_remember", async () => {
    const { target, ...command } = input
    if (target === undefined) {
      const value = await options.directory.rememberPersonalAsAgent(options.actor, command satisfies PersonalMemoryCommand)
      return { value: memoryResult(value), completion: { result_count: 1, memory_id: value.memory_id, revision: value.revision } }
    }
    const value = await options.directory.rememberSharedAsAgent(options.actor, target, command satisfies PersonalMemoryCommand)
    if (value.result === "PROPOSAL") {
      return {
        value: { result: "PROPOSAL", proposal: value.proposal },
        completion: {
          result_count: 1,
          memory_id: value.proposal.memory_id,
          proposal_id: value.proposal.proposal_id,
        },
      }
    }
    return {
      value: memoryResult(value.memory),
      completion: { result_count: 1, memory_id: value.memory.memory_id, revision: value.memory.revision },
    }
  }))

  server.registerTool("memory_forget", {
    title: "刪除記憶",
    description: "已獲使用者授權的 Agent 可刪除指定個人或明確指定共享範圍記憶；共享範圍仍依目前管理權限判斷。",
    inputSchema: z.object({
      memory_id: identifier,
      expected_revision: z.number().int().min(1),
      idempotency_key: idempotencyKey,
      target: sharedTarget.optional(),
    }).strict(),
    annotations: { ...write, destructiveHint: true },
  }, (input) => execute("memory_forget", async () => {
    const { target, ...command } = input
    const value = target === undefined
      ? await options.directory.deletePersonalAsAgent(options.actor, command satisfies PersonalMemoryDelete)
      : await options.directory.deleteSharedAsAgent(options.actor, target, command satisfies PersonalMemoryDelete)
    return { value, completion: { result_count: 1, memory_id: value.memory_id, revision: value.deleted_revision } }
  }))

  server.registerTool("memory_scope_list", {
    title: "列出可用記憶範圍",
    description: "列出目前 Agent 可讀取的個人、團隊與組織記憶範圍。",
    inputSchema: z.object({}).strict(),
    annotations: read,
  }, () => execute("memory_scope_list", async () => {
    const scopes = await options.directory.listMemoryScopesAsAgent(options.actor)
    return {
      value: { scopes: scopes.map((scope) => scope.target) },
      completion: { result_count: scopes.length },
    }
  }))

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    await server.close()
  }
}
