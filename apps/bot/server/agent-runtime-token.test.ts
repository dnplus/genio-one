import { describe, expect, test } from "bun:test"

import { issueAgentRuntimeCredential, invocationAccessTokens } from "./agent-runtime-token"
import type { BotInvocationRequest } from "./bot-registry"

const invocation: BotInvocationRequest = {
  requestId: "invocation-1",
  tenantId: "tenant-acme",
  callerSubjectId: "person-caller",
  callerBotId: "bot-caller",
  targetOwnerSubjectId: "person-owner",
  targetBotId: "bot-target",
  targetAgentSubjectId: "agent-target",
  task: "查詢 CS001284",
  selectedContextRefs: ["current-task"],
  requestedCapabilityIds: ["servicenow.csm.read_case"],
  actionDigest: "sha256-action",
  state: "APPROVED",
  decisionReason: "approved",
  expiresAt: Date.now() + 60_000,
  createdAt: Date.now(),
  decidedAt: Date.now(),
  resultSummary: null,
  artifactRefs: [],
}

describe("agent runtime credential", () => {
  test("uses a development session-bound credential without putting a token in the browser", async () => {
    const credential = await issueAgentRuntimeCredential({ invocation, agentSubjectId: "agent-target" }, { NODE_ENV: "development" })
    expect(credential.mode).toBe("session-bound")
    expect(credential.accessToken).toBeNull()
    expect(credential.agentSubjectId).toBe("agent-target")
    expect(credential.capabilityIds).toEqual(["servicenow.csm.read_case"])
  })

  test("fails closed in production when the CP exchange is not configured", async () => {
    await expect(issueAgentRuntimeCredential({ invocation, agentSubjectId: "agent-target" }, { NODE_ENV: "production" })).rejects.toThrow("AGENT_TOKEN_EXCHANGE_REQUIRED")
  })
})


test("invocation authority never substitutes caller credentials for another owner", async () => {
  const credential = await issueAgentRuntimeCredential({ invocation, agentSubjectId: "agent-target" }, {})
  expect(invocationAccessTokens({ credential, sameOwner: true, callerAccessToken: "caller" })).toEqual({ runtime: "caller", tools: "caller", owner: "caller" })
  expect(() => invocationAccessTokens({ credential, sameOwner: false, callerAccessToken: "caller" })).toThrow("TARGET_OWNER_AUTHORITY_UNAVAILABLE")
  expect(invocationAccessTokens({ credential, sameOwner: false, callerAccessToken: "caller", ownerAccessToken: "owner" })).toEqual({ runtime: "owner", tools: "owner", owner: "owner" })
  expect(invocationAccessTokens({ credential: { ...credential, mode: "exchange", accessToken: "agent" }, sameOwner: false, callerAccessToken: "caller" })).toEqual({ runtime: "agent", tools: "agent", owner: undefined })
})
