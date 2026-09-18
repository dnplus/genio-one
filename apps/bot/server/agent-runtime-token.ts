import { randomUUID } from "node:crypto"

import type { BotInvocationRequest } from "./bot-registry"

export interface AgentRuntimeCredential {
  mode: "exchange" | "session-bound"
  agentSubjectId: string
  invocationId: string
  capabilityIds: string[]
  actionDigest: string
  expiresAt: number
  accessToken: string | null
}

export interface AgentRuntimeCredentialInput {
  invocation: BotInvocationRequest
  agentSubjectId: string
}

export function invocationAccessTokens(input: {
  credential: AgentRuntimeCredential
  sameOwner: boolean
  ownerAccessToken?: string
  callerAccessToken?: string
}) {
  const owner = input.ownerAccessToken?.trim() || (input.sameOwner ? input.callerAccessToken?.trim() : undefined)
  const runtime = input.credential.accessToken?.trim() || owner
  if (!runtime) throw new Error("TARGET_OWNER_AUTHORITY_UNAVAILABLE")
  return { runtime, tools: owner || runtime, owner }
}

function configuredEndpoint(environment: NodeJS.ProcessEnv = process.env) {
  return environment.GENIO_ONE_AGENT_TOKEN_EXCHANGE_URL?.trim() || ""
}

export async function issueAgentRuntimeCredential(
  input: AgentRuntimeCredentialInput,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AgentRuntimeCredential> {
  const endpoint = configuredEndpoint(environment)
  const expiresAt = Math.min(input.invocation.expiresAt, Date.now() + 5 * 60 * 1000)
  if (!endpoint) {
    if (environment.NODE_ENV === "production") throw new Error("AGENT_TOKEN_EXCHANGE_REQUIRED")
    return {
      mode: "session-bound",
      agentSubjectId: input.agentSubjectId,
      invocationId: input.invocation.requestId,
      capabilityIds: [...input.invocation.requestedCapabilityIds],
      actionDigest: input.invocation.actionDigest,
      expiresAt,
      accessToken: null,
    }
  }
  const serviceToken = environment.GENIO_ONE_AGENT_TOKEN_EXCHANGE_TOKEN?.trim()
  if (!serviceToken) throw new Error("AGENT_TOKEN_EXCHANGE_TOKEN_REQUIRED")
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${serviceToken}`,
    },
    body: JSON.stringify({
      subject_id: input.agentSubjectId,
      invocation_id: input.invocation.requestId,
      capability_ids: input.invocation.requestedCapabilityIds,
      action_digest: input.invocation.actionDigest,
      expires_at: expiresAt,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json().catch(() => null) as { access_token?: unknown; expires_at?: unknown } | null
  if (!response.ok || typeof body?.access_token !== "string" || !body.access_token.trim()) throw new Error("AGENT_TOKEN_EXCHANGE_FAILED")
  const returnedExpiry = typeof body.expires_at === "number" && body.expires_at > Date.now() ? Math.min(body.expires_at, expiresAt) : expiresAt
  return {
    mode: "exchange",
    agentSubjectId: input.agentSubjectId,
    invocationId: input.invocation.requestId,
    capabilityIds: [...input.invocation.requestedCapabilityIds],
    actionDigest: input.invocation.actionDigest,
    expiresAt: returnedExpiry,
    accessToken: body.access_token,
  }
}

export function credentialCorrelation(credential: AgentRuntimeCredential) {
  return {
    credential_id: `agent-runtime-${randomUUID()}`,
    credential_mode: credential.mode,
    agent_subject_id: credential.agentSubjectId,
    invocation_id: credential.invocationId,
    capability_ids: credential.capabilityIds,
    action_digest: credential.actionDigest,
    expires_at: credential.expiresAt,
  }
}
