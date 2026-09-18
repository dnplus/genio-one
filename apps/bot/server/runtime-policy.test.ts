import { describe, expect, test } from "bun:test"
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto"

import { canonicalRuntimeReportPayload } from "../../../runtimes/gateway/services/shared/runtime-report-attestation"

import { createRuntimePolicyClient, requireRuntimePolicyDecision, RuntimePolicyUnavailableError } from "./runtime-policy"
import type { GenioPrincipal } from "./runtime-broker"
import type { RuntimePolicyDecision } from "./runtime-policy-contract"

const principal: GenioPrincipal = {
  tenant_id: "tenant-local",
  subject_id: "person-dylan",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}
const reportKeys = generateKeyPairSync("ed25519")
const reportPrivateKeyPem = reportKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()

function decision(overrides: Record<string, unknown> = {}): RuntimePolicyDecision {
  return {
    tenant_id: principal.tenant_id,
    subject_id: principal.subject_id,
    client_id: principal.acting_client_id,
    bot_id: "bot-dylan",
    runtime_id: "codex",
    policy_id: "one-policy.runtime.capabilities",
    policy_display_name: "Runtime capabilities",
    policy_revision: 4,
    capability_id: "shell.exec",
    action: "expose",
    target: "runtime:codex:shell.exec",
    decision: "ALLOW",
    reason_code: "RULE_ALLOW:shell",
    constraints: [],
    obligations: [],
    correlation_id: "corr-runtime",
    session_id: "runtime-session",
    evaluated_at: 1_757_000_000,
    ...overrides,
  }
}

describe("RuntimePolicyClient", () => {
  test("reads an effective decision with server identity and query fields", async () => {
    const requests: Array<{ url: string; method: string; authorization: string | null }> = []
    const client = createRuntimePolicyClient({
      origin: "http://platform.test",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          authorization: new Headers(init?.headers).get("authorization"),
        })
        return new Response(JSON.stringify(decision()), { status: 200 })
      },
    })

    const result = await client.resolve({
      principal,
      botId: "bot-dylan",
      capabilityId: "shell.exec",
      action: "expose",
      sessionId: "runtime-session",
      accessToken: "token-1",
    })

    expect(result.decision).toBe("ALLOW")
    const request = requests[0]!
    expect(request.method).toBe("GET")
    expect(request.authorization).toBe("Bearer token-1")
    expect(request.url).toContain("/v1/tenants/tenant-local/one-policy/runtime-effective")
    expect(request.url).toContain("bot_id=bot-dylan")
    expect(request.url).toContain("capability_id=shell.exec")
  })

  test("uses POST authorize and converts unsupported constraints to a denial", async () => {
    let method = ""
    const client = createRuntimePolicyClient({
      origin: "http://platform.test",
      fetch: async (_input, init) => {
        method = init?.method ?? ""
        const body = init?.body ? JSON.parse(String(init.body)) as { correlation_id?: string } : {}
        return new Response(JSON.stringify(decision({ action: "invoke", correlation_id: body.correlation_id, constraints: [{ kind: "path_allowlist", parameters: { paths: ["/workspace"] } }] })), { status: 200 })
      },
    })

    const result = await client.authorize({ principal, botId: "bot-dylan", capabilityId: "shell.exec", action: "invoke", correlationId: "corr-constraints" })
    expect(method).toBe("POST")
    expect(result.decision).toBe("DENY")
    expect(result.reason_code).toBe("RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED")
  })

  test("requires enforceable constraints before treating an ALLOW as executable", () => {
    expect(() => requireRuntimePolicyDecision(decision({ constraints: [{ kind: "path_allowlist", parameters: { paths: ["/workspace"] } }] }))).toThrow("RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED")
  })

  test("keeps the typed audit obligation enforceable for authorize and report", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> | null; keyId: string | null; signature: string | null }> = []
    const client = createRuntimePolicyClient({
      origin: "http://platform.test",
      reportKeyId: "genio-one-bot-runtime",
      reportPrivateKeyPem,
      fetch: async (_input, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
        const headers = new Headers(init?.headers)
        requests.push({ method: init?.method ?? "GET", body, keyId: headers.get("x-genio-runtime-report-key-id"), signature: headers.get("x-genio-runtime-report-signature") })
        return new Response(JSON.stringify(decision({
          action: "invoke",
          correlation_id: "corr-audit",
          obligations: [{ kind: "audit", enforcement_point_id: "AGENT_RUNTIME", parameters: {} }],
        })), { status: 200 })
      },
    })

    const authorized = await client.authorize({ principal, botId: "bot-dylan", capabilityId: "shell.exec", action: "invoke", correlationId: "corr-audit" })
    expect(authorized.decision).toBe("ALLOW")
    await client.report({
      principal,
      botId: "bot-dylan",
      capabilityId: "shell.exec",
      action: "invoke",
      correlationId: authorized.correlation_id!,
      outcome: "COMPLETED",
    })
    expect(requests.map((request) => request.method)).toEqual(["POST", "POST"])
    expect(requests[1]?.signature).toBeTruthy()
    expect(requests[1]?.keyId).toBe("genio-one-bot-runtime")
    expect(verify(null, Buffer.from(canonicalRuntimeReportPayload(requests[1]!.body!)), createPublicKey(reportKeys.publicKey.export({ type: "spki", format: "pem" })), Buffer.from(requests[1]!.signature!, "base64url"))).toBe(true)
    expect(requests[1]?.body).toEqual({
      correlation_id: "corr-audit",
      bot_id: "bot-dylan",
      runtime_id: "codex",
      capability_id: "shell.exec",
      action: "invoke",
      outcome: "COMPLETED",
    })
  })

  test("fails closed for obligations without an implemented enforcement point", async () => {
    const client = createRuntimePolicyClient({
      fetch: async () => new Response(JSON.stringify(decision({
        action: "invoke",
        correlation_id: "corr-obligation",
        obligations: [{ kind: "require_approval", parameters: {} }],
      })), { status: 200 }),
    })

    const result = await client.authorize({ principal, botId: "bot-dylan", capabilityId: "shell.exec", action: "invoke", correlationId: "corr-obligation" })
    expect(result.decision).toBe("DENY")
    expect(result.reason_code).toBe("RUNTIME_POLICY_OBLIGATION_UNSUPPORTED")
  })

  test("fails closed when Platform returns another principal", async () => {
    const client = createRuntimePolicyClient({
      fetch: async () => new Response(JSON.stringify(decision({ subject_id: "person-other" })), { status: 200 }),
    })

    await expect(client.resolve({ principal, botId: "bot-dylan", capabilityId: "shell.exec", action: "expose" })).rejects.toBeInstanceOf(RuntimePolicyUnavailableError)
  })

  test("preserves a no-match deny with an unpublished policy version", async () => {
    const client = createRuntimePolicyClient({
      fetch: async () => new Response(JSON.stringify(decision({
        policy_id: null,
        policy_revision: null,
        capability_id: "codex.subscription",
        target: "runtime:codex:codex.subscription",
        decision: "DENY",
        reason_code: "DEFAULT_DENY",
        correlation_id: "corr-no-match",
      })), { status: 200 }),
    })

    const result = await client.authorize({ principal, botId: "bot-dylan", capabilityId: "codex.subscription", action: "expose", correlationId: "corr-no-match" })
    expect(result.decision).toBe("DENY")
    expect(result.policy_id).toBeNull()
    expect(result.policy_revision).toBeNull()
    expect(() => requireRuntimePolicyDecision(result)).toThrow("DEFAULT_DENY")
  })

  test("aggregates the effective read using a common policy version", async () => {
    const client = createRuntimePolicyClient({
      fetch: async (input) => {
        const url = new URL(String(input))
        return new Response(JSON.stringify(decision({
          capability_id: url.searchParams.get("capability_id"),
          target: `runtime:codex:${url.searchParams.get("capability_id")}`,
        })), { status: 200 })
      },
    })

    const snapshot = await client.read({ principal, botId: "bot-dylan", capabilityIds: ["shell.exec", "filesystem.read"] })
    expect(snapshot.policy_id).toBe("one-policy.runtime.capabilities")
    expect(snapshot.policy_revision).toBe(4)
    expect(snapshot.decisions.map((item) => item.capability_id)).toEqual(["shell.exec", "filesystem.read"])
  })

  test("selects use for subscription, invoke for model access, and expose for native capabilities", async () => {
    const requests: Array<{ capabilityId: string | null; action: string | null }> = []
    const client = createRuntimePolicyClient({
      origin: "http://platform.test",
      fetch: async (input) => {
        const url = new URL(String(input))
        requests.push({ capabilityId: url.searchParams.get("capability_id"), action: url.searchParams.get("action") })
        const capabilityId = url.searchParams.get("capability_id")!
        const action = url.searchParams.get("action")!
        return new Response(JSON.stringify(decision({
          capability_id: capabilityId,
          action,
          target: `runtime:codex:${capabilityId}`,
        })), { status: 200 })
      },
    })

    const snapshot = await client.read({
      principal,
      botId: "bot-dylan",
      capabilityIds: ["codex.subscription", "model.invoke", "shell.exec"],
    })

    expect(requests).toEqual([
      { capabilityId: "codex.subscription", action: "use" },
      { capabilityId: "model.invoke", action: "invoke" },
      { capabilityId: "shell.exec", action: "expose" },
    ])
    expect(snapshot.decisions.map((item) => [item.capability_id, item.action])).toEqual([
      ["codex.subscription", "use"],
      ["model.invoke", "invoke"],
      ["shell.exec", "expose"],
    ])
  })

  test("keeps each decision when capabilities are authorized by different policies", async () => {
    const client = createRuntimePolicyClient({
      origin: "http://platform.test",
      fetch: async (input) => {
        const url = new URL(String(input))
        const capabilityId = url.searchParams.get("capability_id")!
        const action = url.searchParams.get("action")!
        const modelPolicy = capabilityId === "model.invoke"
        return new Response(JSON.stringify(decision({
          policy_id: modelPolicy ? "policy-model" : "policy-native",
          policy_display_name: modelPolicy ? "Model policy" : "Native policy",
          policy_revision: modelPolicy ? 3 : 5,
          capability_id: capabilityId,
          action,
          target: `runtime:codex:${capabilityId}`,
        })), { status: 200 })
      },
    })

    const snapshot = await client.read({
      principal,
      botId: "bot-dylan",
      capabilityIds: ["model.invoke", "shell.exec"],
    })

    expect(snapshot.policy_id).toBeNull()
    expect(snapshot.policy_display_name).toBeNull()
    expect(snapshot.policy_revision).toBeNull()
    expect(snapshot.decisions.map((item) => [item.capability_id, item.policy_id, item.policy_revision])).toEqual([
      ["model.invoke", "policy-model", 3],
      ["shell.exec", "policy-native", 5],
    ])
  })

  test("rejects one policy identity that changes revision within a read", async () => {
    const client = createRuntimePolicyClient({
      origin: "http://platform.test",
      fetch: async (input) => {
        const url = new URL(String(input))
        const capabilityId = url.searchParams.get("capability_id")!
        const action = url.searchParams.get("action")!
        const revision = capabilityId === "model.invoke" ? 3 : 4
        return new Response(JSON.stringify(decision({
          policy_id: "policy-shared",
          policy_display_name: "Shared policy",
          policy_revision: revision,
          capability_id: capabilityId,
          action,
          target: `runtime:codex:${capabilityId}`,
        })), { status: 200 })
      },
    })

    await expect(client.read({
      principal,
      botId: "bot-dylan",
      capabilityIds: ["model.invoke", "shell.exec"],
    })).rejects.toMatchObject({ code: "RUNTIME_POLICY_RESPONSE_INVALID" })
  })
})
