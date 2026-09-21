import { observedFetch } from "@genioone/telemetry/operation-observability"
import { chatStreamToResponses } from "./model-response-stream"
import { randomUUID } from "node:crypto"
import { Readable } from "node:stream"
import type { FastifyInstance } from "fastify"

import type { BotServerContext } from "./context"
import { authorizedManagedMcpMount, managedMcpTarget } from "./managed-mcp"
import type { RuntimeSession } from "./runtime-broker"
import { requireRuntimePolicyDecision } from "./runtime-policy"
import { runtimePolicyDecisionTarget, type RuntimePolicyDecision } from "./runtime-policy-contract"
import {
  CONSUMER_ORGANIZATION_HEADER,
  CORRELATION_HEADER,
  SESSION_ID_HEADER,
  USE_CASE_HEADER,
} from "../../../runtimes/gateway/services/shared/enforcement-headers"

type JsonRecord = Record<string, unknown>

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value.map((part) => {
    if (typeof part === "string") return part
    if (!part || typeof part !== "object") return ""
    const item = part as JsonRecord
    if (typeof item.text === "string") return item.text
    if (typeof item.value === "string") return item.value
    return ""
  }).join("")
}

function isCatalogDiscoveryRequest(request: any): boolean {
  if (request.method !== "POST" || !request.body || typeof request.body !== "object" || Array.isArray(request.body)) return false
  const body = request.body as JsonRecord
  if (["initialize", "notifications/initialized", "ping", "tools/list"].includes(body.method as string)) return true
  if (body.method !== "tools/call" || !body.params || typeof body.params !== "object" || Array.isArray(body.params)) return false
  const name = (body.params as JsonRecord).name
  return name === "search_resources" || name === "get_resource"
}

function responseInputToMessages(input: unknown, instructions: unknown): Array<JsonRecord> {
  const messages: Array<JsonRecord> = []
  if (typeof instructions === "string" && instructions.trim()) {
    messages.push({ role: "system", content: instructions })
  }
  if (typeof input === "string" && input.trim()) {
    messages.push({ role: "user", content: input })
    return messages
  }
  if (!Array.isArray(input)) return messages
  let pendingUserText = ""
  const flushPendingUser = () => {
    if (!pendingUserText.trim()) return
    messages.push({ role: "user", content: pendingUserText })
    pendingUserText = ""
  }
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue
    const item = raw as JsonRecord
    const type = typeof item.type === "string" ? item.type : ""
    const role = item.role === "assistant" || item.role === "system" || item.role === "developer" || item.role === "tool"
      ? item.role
      : item.role === "user" ? "user" : null
    const text = textFromContent(item.content ?? item.text)
    if (role) {
      flushPendingUser()
      messages.push({ role, content: text })
      continue
    }
    if (type === "input_text" || type === "text" || type === "input_image") {
      pendingUserText += text
    }
  }
  flushPendingUser()
  return messages
}

function responsesToolsToChatTools(value: unknown): Array<JsonRecord> | undefined {
  if (!Array.isArray(value)) return undefined
  const tools = value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return []
    const item = raw as JsonRecord
    if (item.type !== "function" || typeof item.name !== "string") return []
    return [{
      type: "function",
      function: {
        name: item.name,
        ...(typeof item.description === "string" ? { description: item.description } : {}),
        ...(item.parameters && typeof item.parameters === "object" ? { parameters: item.parameters } : {}),
        ...(typeof item.strict === "boolean" ? { strict: item.strict } : {}),
      },
    }]
  })
  return tools.length > 0 ? tools : undefined
}

export function responsesToChatRequest(input: JsonRecord): JsonRecord {
  if (typeof input.model !== "string" || !input.model.trim()) throw new Error("MODEL_REQUIRED")
  const request: JsonRecord = {
    model: input.model,
    messages: responseInputToMessages(input.input, input.instructions),
    stream: true,
  }
  const tools = responsesToolsToChatTools(input.tools)
  if (tools) request.tools = tools
  if (input.tool_choice !== undefined) request.tool_choice = input.tool_choice
  if (input.parallel_tool_calls !== undefined) request.parallel_tool_calls = input.parallel_tool_calls
  if (typeof input.temperature === "number") request.temperature = input.temperature
  if (typeof input.top_p === "number") request.top_p = input.top_p
  if (typeof input.max_output_tokens === "number") request.max_tokens = input.max_output_tokens
  return request
}

function upstreamUrl(): URL {
  const configured = process.env.GENIO_ONE_MODEL_GATEWAY_BASE_URL?.trim()
  if (!configured) throw new Error("GENIO_ONE_MODEL_GATEWAY_BASE_URL_REQUIRED")
  const base = configured.endsWith("/") ? configured : `${configured}/`
  return new URL("chat/completions", base)
}

function loopbackTarget(target: URL): { url: URL; host: string | null } {
  if (!target.hostname.endsWith(".localhost")) return { url: target, host: null }
  const host = target.host
  const url = new URL(target)
  url.hostname = "127.0.0.1"
  return { url, host }
}

async function fetchMcpResponse(request: any, session: RuntimeSession, configured: string): Promise<Response> {
  const configuredTarget = new URL(configured)
  const requestUrl = new URL(request.url, "http://127.0.0.1")
  configuredTarget.search = requestUrl.search
  const resolvedTarget = loopbackTarget(configuredTarget)
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase()
    if (lower === "authorization" || lower === "host" || lower === "content-length" || lower === "connection" || (typeof value !== "string" && !Array.isArray(value))) continue
    headers.set(lower, Array.isArray(value) ? value.join(",") : value)
  }
  headers.set("authorization", `Bearer ${session.accessToken}`)
  if (resolvedTarget.host) headers.set("host", resolvedTarget.host)
  const method = request.method
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : typeof request.body === "string" || Buffer.isBuffer(request.body)
      ? request.body as BodyInit
      : request.body === undefined ? undefined : JSON.stringify(request.body)
  return observedFetch("genio-one-bot", resolvedTarget.url, { method, headers, body })
}

function sendMcpResponse(reply: any, upstream: Response, stream?: Readable) {
  for (const [key, value] of upstream.headers) {
    if (["connection", "content-length", "transfer-encoding", "upgrade"].includes(key.toLowerCase())) continue
    reply.header(key, value)
  }
  if (!upstream.body) return reply.code(upstream.status).send()
  return reply.code(upstream.status).send(stream ?? Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]))
}

async function forwardMcpRequest(request: any, reply: any, session: RuntimeSession, configured: string) {
  return sendMcpResponse(reply, await fetchMcpResponse(request, session, configured))
}

function reportedMcpResponseStream(
  body: ReadableStream<Uint8Array>,
  report: (outcome: "COMPLETED" | "FAILED", reasonCode?: string) => Promise<void>,
) {
  const reader = body.getReader()
  let reported = false
  let completionAttempted = false
  let cancelled = false
  let cancellationAttempted = false
  const reportFailure = async (reasonCode: string) => {
    if (reported || completionAttempted) return
    reported = true
    await report("FAILED", reasonCode)
  }
  const source = (async function*() {
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) {
          if (cancelled) {
            await reportFailure("MCP_GATEWAY_UPSTREAM_STREAM_CANCELLED")
            return
          }
          completionAttempted = true
          await report("COMPLETED")
          reported = true
          return
        }
        yield Buffer.from(next.value)
      }
    } catch (error) {
      try {
        await reportFailure(cancelled ? "MCP_GATEWAY_UPSTREAM_STREAM_CANCELLED" : "MCP_GATEWAY_UPSTREAM_STREAM_FAILED")
      } catch {
        throw new Error("RUNTIME_POLICY_REPORT_UNAVAILABLE")
      }
      throw error
    } finally {
      if (!reported && !completionAttempted) {
        cancelled = true
        try { await reader.cancel() } catch {}
        try {
          await reportFailure("MCP_GATEWAY_UPSTREAM_STREAM_CANCELLED")
        } catch {
          throw new Error("RUNTIME_POLICY_REPORT_UNAVAILABLE")
        }
      }
    }
  })()
  const stream = Readable.from(source)
  const cancel = () => {
    if (!reported && !completionAttempted && !cancellationAttempted) {
      cancellationAttempted = true
      cancelled = true
      void (async () => {
        try { await reader.cancel() } catch {}
        try { await reportFailure("MCP_GATEWAY_UPSTREAM_STREAM_CANCELLED") } catch {}
      })()
    }
  }
  const destroy = stream.destroy.bind(stream)
  stream.destroy = (error?: Error) => {
    cancel()
    return destroy(error)
  }
  stream.once("close", cancel)
  return stream
}

export async function modelGatewayRelayRoutes(app: FastifyInstance, context: BotServerContext) {
  app.post("/api/model-gateway/:runtimeSessionId/v1/responses", async (request, reply) => {
    const { runtimeSessionId } = request.params as { runtimeSessionId: string }
    const session = context.runtimeBroker.get(runtimeSessionId)
    if (!session?.accessToken) return reply.code(404).send({ error: "MODEL_RUNTIME_SESSION_NOT_FOUND" })
    const botId = session.selectedBotId
    if (!botId) return reply.code(409).send({ error: "MODEL_BOT_NOT_SELECTED" })
    const bot = context.botRegistry.getOwned(botId, session.principal)
    if (!bot || bot.modelRoute !== "genio-gateway") return reply.code(403).send({ error: "MODEL_ROUTE_NOT_ALLOWED" })
    const usageContext = session.usageContext
    if (!usageContext || bot.ownerOrganizationId !== usageContext.consumerOrganizationId || bot.useCaseId !== usageContext.useCaseId) {
      return reply.code(409).send({ error: "USE_CASE_REQUIRED" })
    }
    const body = request.body && typeof request.body === "object" ? request.body as JsonRecord : {}
    let chatRequest: JsonRecord
    try { chatRequest = responsesToChatRequest(body) } catch { return reply.code(400).send({ error: "MODEL_REQUIRED" }) }
    const correlationId = randomUUID()
    let decision: RuntimePolicyDecision | undefined
    const report = async (outcome: "COMPLETED" | "DENY" | "FAILED", reasonCode?: string) => {
      if (!decision?.correlation_id) throw new Error("RUNTIME_POLICY_CORRELATION_INVALID")
      const target = runtimePolicyDecisionTarget(decision)
      await context.runtimePolicy.report({
        principal: session.principal,
        botId,
        runtimeId: "codex",
        capabilityId: target.capabilityId,
        action: target.action,
        sessionId: session.id,
        correlationId: decision.correlation_id,
        accessToken: session.accessToken,
        outcome,
        ...(reasonCode ? { reasonCode } : {}),
      })
    }
    try {
      decision = await context.runtimePolicy.authorize({
        principal: session.principal,
        botId,
        runtimeId: "codex",
        capabilityId: "model.invoke",
        action: "invoke",
        sessionId: session.id,
        correlationId,
        accessToken: session.accessToken,
      })
      if (decision.correlation_id !== correlationId) throw new Error("RUNTIME_POLICY_CORRELATION_INVALID")
      requireRuntimePolicyDecision(decision)
    } catch (error) {
      const policyDecision = decision
      if (policyDecision) {
        try {
          await report("DENY", error instanceof Error ? error.message : "RUNTIME_POLICY_DENIED")
        } catch {
          return reply.code(503).send({ error: "RUNTIME_POLICY_REPORT_UNAVAILABLE" })
        }
      }
      if (policyDecision?.decision === "DENY" || error instanceof Error && error.message.startsWith("RUNTIME_POLICY_")) {
        return reply.code(403).send({ error: policyDecision?.reason_code ?? (error instanceof Error ? error.message : "RUNTIME_POLICY_DENIED") })
      }
      return reply.code(503).send({ error: "RUNTIME_POLICY_UNAVAILABLE" })
    }
    let target: URL
    try {
      target = upstreamUrl()
    } catch (error) {
      try {
        await report("FAILED", error instanceof Error ? error.message : "MODEL_GATEWAY_NOT_CONFIGURED")
      } catch {
        return reply.code(503).send({ error: "RUNTIME_POLICY_REPORT_UNAVAILABLE" })
      }
      return reply.code(503).send({ error: error instanceof Error ? error.message : "MODEL_GATEWAY_NOT_CONFIGURED" })
    }
    const resolvedTarget = loopbackTarget(target)
    let upstream: Response
    try {
      upstream = await observedFetch("genio-one-bot", resolvedTarget.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
          "x-request-id": correlationId,
          [CORRELATION_HEADER]: correlationId,
          [SESSION_ID_HEADER]: session.id,
          [CONSUMER_ORGANIZATION_HEADER]: usageContext.consumerOrganizationId,
          [USE_CASE_HEADER]: usageContext.useCaseId,
          ...(resolvedTarget.host ? { host: resolvedTarget.host } : {}),
        },
        body: JSON.stringify(chatRequest),
      })
    } catch {
      try {
        await report("FAILED", "MODEL_GATEWAY_UPSTREAM_UNAVAILABLE")
      } catch {
        return reply.code(503).send({ error: "RUNTIME_POLICY_REPORT_UNAVAILABLE" })
      }
      return reply.code(502).send({ error: "MODEL_GATEWAY_UPSTREAM_UNAVAILABLE" })
    }
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text()
      try {
        await report("FAILED", `MODEL_GATEWAY_UPSTREAM_${upstream.status}`)
      } catch {
        return reply.code(503).send({ error: "RUNTIME_POLICY_REPORT_UNAVAILABLE" })
      }
      return reply.code(upstream.status).send(text || { error: "MODEL_GATEWAY_UPSTREAM_FAILED" })
    }
    const model = chatRequest.model as string
    reply.header("x-request-id", correlationId)
    reply.header("content-type", "text/event-stream")
    reply.header("cache-control", "no-cache")
    reply.header("connection", "keep-alive")
    return reply.send(Readable.from(chatStreamToResponses(upstream.body, model, report)))
  })

  app.all("/api/mcp-gateway/:runtimeSessionId/:resourceId/mcp", async (request, reply) => {
    const { runtimeSessionId, resourceId } = request.params as { runtimeSessionId: string; resourceId: string }
    const session = context.runtimeBroker.get(runtimeSessionId)
    if (!session?.accessToken) return reply.code(404).send({ error: "MCP_RUNTIME_SESSION_NOT_FOUND" })
    const botId = session.selectedBotId
    if (!botId) return reply.code(403).send({ error: "MCP_RESOURCE_NOT_ALLOWED" })
    const bot = context.botRegistry.getOwned(botId, session.principal)
    const mount = bot ? authorizedManagedMcpMount(resourceId, session.managedMcpMounts ?? {}, bot.bindings) : null
    if (!mount) return reply.code(403).send({ error: "MCP_RESOURCE_NOT_ALLOWED" })
    const configured = managedMcpTarget(mount)
    if (!configured) return reply.code(503).send({ error: "MCP_PUBLICATION_ENDPOINT_UNAVAILABLE" })
    const correlationId = randomUUID()
    let decision: RuntimePolicyDecision | undefined
    const report = async (outcome: "COMPLETED" | "DENY" | "FAILED", reasonCode?: string) => {
      if (!decision?.correlation_id) throw new Error("RUNTIME_POLICY_CORRELATION_INVALID")
      const target = runtimePolicyDecisionTarget(decision)
      await context.runtimePolicy.report({
        principal: session.principal,
        botId,
        runtimeId: "codex",
        capabilityId: target.capabilityId,
        action: target.action,
        sessionId: session.id,
        correlationId: decision.correlation_id,
        accessToken: session.accessToken,
        outcome,
        ...(reasonCode ? { reasonCode } : {}),
      })
    }
    try {
      decision = await context.runtimePolicy.authorize({
        principal: session.principal,
        botId,
        runtimeId: "codex",
        capabilityId: "mcp.invoke",
        action: "invoke",
        sessionId: session.id,
        correlationId,
        accessToken: session.accessToken,
      })
      if (decision.correlation_id !== correlationId) throw new Error("RUNTIME_POLICY_CORRELATION_INVALID")
      requireRuntimePolicyDecision(decision)
    } catch (error) {
      const policyDecision = decision
      if (policyDecision) {
        try {
          await report("DENY", error instanceof Error ? error.message : "RUNTIME_POLICY_DENIED")
        } catch {
          return reply.code(503).send({ error: "RUNTIME_POLICY_REPORT_UNAVAILABLE" })
        }
      }
      if (policyDecision?.decision === "DENY" || error instanceof Error && error.message.startsWith("RUNTIME_POLICY_")) {
        return reply.code(403).send({ error: policyDecision?.reason_code ?? (error instanceof Error ? error.message : "RUNTIME_POLICY_DENIED") })
      }
      return reply.code(503).send({ error: "RUNTIME_POLICY_UNAVAILABLE" })
    }
    let upstream: Response
    try {
      upstream = await fetchMcpResponse(request, session, configured)
    } catch {
      try {
        await report("FAILED", "MCP_GATEWAY_UPSTREAM_UNAVAILABLE")
      } catch {
        return reply.code(503).send({ error: "RUNTIME_POLICY_REPORT_UNAVAILABLE" })
      }
      return reply.code(502).send({ error: "MCP_GATEWAY_UPSTREAM_UNAVAILABLE" })
    }
    if (!upstream.ok) {
      try {
        await report("FAILED", `MCP_GATEWAY_UPSTREAM_${upstream.status}`)
      } catch {
        void upstream.body?.cancel()
        return reply.code(503).send({ error: "RUNTIME_POLICY_REPORT_UNAVAILABLE" })
      }
      return sendMcpResponse(reply, upstream)
    }
    if (!upstream.body) {
      try {
        await report("COMPLETED")
      } catch {
        return reply.code(503).send({ error: "RUNTIME_POLICY_REPORT_UNAVAILABLE" })
      }
      return sendMcpResponse(reply, upstream)
    }
    return sendMcpResponse(reply, upstream, reportedMcpResponseStream(upstream.body, report))
  })

  app.all("/api/mcp-gateway/:runtimeSessionId/mcp", async (_request, reply) => {
    return reply.code(410).send({ error: "MCP_GENERIC_RELAY_RETIRED" })
  })

  app.all("/api/discovery-mcp/:runtimeSessionId/mcp", async (request, reply) => {
    const { runtimeSessionId } = request.params as { runtimeSessionId: string }
    const session = context.runtimeBroker.get(runtimeSessionId)
    if (!session?.accessToken) return reply.code(404).send({ error: "MCP_RUNTIME_SESSION_NOT_FOUND" })
    if (!isCatalogDiscoveryRequest(request)) return reply.code(403).send({ error: "DISCOVERY_CATALOG_EXPOSE_ONLY" })
    const configured = new URL(`/v1/tenants/${encodeURIComponent(session.principal.tenant_id)}/discovery/mcp`, process.env.GENIO_ONE_PLATFORM_ORIGIN || "http://127.0.0.1:58082").toString()
    return forwardMcpRequest(request, reply, session, configured)
  })
}
