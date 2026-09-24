import { createHash, randomBytes } from "node:crypto"

import type { ManagedMcpMounts } from "./managed-mcp"

export interface HandsMcpGrant {
  botId: string
  tier: string
  expiresAt: number
  readOnlyTools: Map<string, Set<string>>
}

export interface HandsMcpGrantHolder {
  handsMcpGrants?: Map<string, HandsMcpGrant>
}

export const HANDS_MCP_GRANT_TTL_MS = 60 * 60 * 1000
export const HANDS_MCP_MANIFEST_PATH = "/home/user/.genio/mcp.json"

const digest = (token: string) => createHash("sha256").update(token).digest("hex")

export function issueHandsMcpGrant(holder: HandsMcpGrantHolder, input: { botId: string; tier: string; now?: number }) {
  const token = randomBytes(32).toString("base64url")
  holder.handsMcpGrants ??= new Map()
  holder.handsMcpGrants.set(digest(token), {
    botId: input.botId,
    tier: input.tier,
    expiresAt: (input.now ?? Date.now()) + HANDS_MCP_GRANT_TTL_MS,
    readOnlyTools: new Map(),
  })
  return token
}

export function handsMcpGrantFor(holder: HandsMcpGrantHolder, authorization: unknown, now = Date.now()): HandsMcpGrant | null {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null
  const key = digest(authorization.slice("Bearer ".length))
  const grant = holder.handsMcpGrants?.get(key)
  if (!grant) return null
  if (grant.expiresAt <= now) {
    holder.handsMcpGrants?.delete(key)
    return null
  }
  return grant
}

export function revokeHandsMcpGrants(holder: HandsMcpGrantHolder, tier?: string) {
  if (!holder.handsMcpGrants) return
  for (const [key, grant] of holder.handsMcpGrants) {
    if (!tier || grant.tier === tier) holder.handsMcpGrants.delete(key)
  }
}

export interface HandsMcpProvision {
  token: string
  relayOrigin: string
  botId: string
  mounts: ManagedMcpMounts
}

export function handsMcpManifest(runtimeSessionId: string, provision: HandsMcpProvision) {
  return {
    version: 1,
    resources: Object.values(provision.mounts).map((mount) => ({
      resource_id: mount.resourceId,
      server_name: mount.serverName,
      url: new URL(`/api/mcp-gateway/${encodeURIComponent(runtimeSessionId)}/bots/${encodeURIComponent(provision.botId)}/${encodeURIComponent(mount.resourceId)}/mcp`, provision.relayOrigin).toString(),
    })),
  }
}

export function handsMcpNetwork(provision: HandsMcpProvision) {
  return {
    rules: {
      [new URL(provision.relayOrigin).hostname]: [{ transform: { headers: { Authorization: `Bearer ${provision.token}` } } }],
    },
  }
}

const HANDS_METHODS = new Set(["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"])

export type HandsMcpRequestCheck =
  | { allowed: true; method: string; tool?: string }
  | { allowed: false; error: string }

export function checkHandsMcpRequest(grant: HandsMcpGrant, resourceId: string, method: unknown, body: unknown): HandsMcpRequestCheck {
  if (method !== "POST" || !body || typeof body !== "object" || Array.isArray(body)) return { allowed: false, error: "HANDS_MCP_REQUEST_NOT_ALLOWED" }
  const rpc = body as { method?: unknown; params?: unknown }
  if (typeof rpc.method !== "string" || !HANDS_METHODS.has(rpc.method)) return { allowed: false, error: "HANDS_MCP_METHOD_NOT_ALLOWED" }
  if (rpc.method !== "tools/call") return { allowed: true, method: rpc.method }
  const name = rpc.params && typeof rpc.params === "object" ? (rpc.params as { name?: unknown }).name : undefined
  if (typeof name !== "string" || !grant.readOnlyTools.get(resourceId)?.has(name)) return { allowed: false, error: "HANDS_MCP_TOOL_NOT_READ_ONLY" }
  return { allowed: true, method: rpc.method, tool: name }
}

type JsonRpcMessage = { result?: { tools?: Array<{ name?: unknown; annotations?: { readOnlyHint?: unknown } }> } }

function readOnlyOnly(message: JsonRpcMessage) {
  const tools = message.result?.tools
  if (!Array.isArray(tools)) return { message }
  const kept = tools.filter((tool) => tool?.annotations?.readOnlyHint === true && typeof tool.name === "string")
  return {
    message: { ...message, result: { ...message.result, tools: kept } },
    learned: new Set(kept.map((tool) => tool.name as string)),
  }
}

export function filterHandsToolList(grant: HandsMcpGrant, resourceId: string, contentType: string | null, text: string) {
  if (contentType?.includes("text/event-stream")) {
    let learned: Set<string> | undefined
    const filtered = text.split("\n").map((line) => {
      if (!line.startsWith("data:")) return line
      try {
        const result = readOnlyOnly(JSON.parse(line.slice(5)))
        if (result.learned) learned = result.learned
        return `data: ${JSON.stringify(result.message)}`
      } catch {
        return line
      }
    }).join("\n")
    if (learned) grant.readOnlyTools.set(resourceId, learned)
    return filtered
  }
  const result = readOnlyOnly(JSON.parse(text))
  if (result.learned) grant.readOnlyTools.set(resourceId, result.learned)
  return JSON.stringify(result.message)
}
