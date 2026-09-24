import { describe, expect, test } from "bun:test"
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto"

import { canonicalRuntimeReportPayload } from "../../../runtimes/gateway/services/shared/runtime-report-attestation"

import { createRuntimePolicyClient, requireRuntimePolicyDecision, RuntimePolicyUnavailableError } from "./runtime-policy"
import type { GenioPrincipal } from "./runtime-broker"
import type { RuntimePolicyDecision } from "./runtime-policy-contract"

const managedPlacement = [{ kind: "execution_placement", parameters: { execution_domain: "MANAGED_CLOUD" } }]

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
  test("inspects placement without making a generic decision executable", async () => {
    const client = createRuntimePolicyClient({
      fetch: async () => new Response(JSON.stringify(decision({ capability_id: "remote_hands.use", action: "use", target: "runtime:codex:remote_hands.use", constraints: managedPlacement })), { status: 200 }),
    })
    const input = { principal, botId: "bot-dylan", capabilityId: "remote_hands.use" as const, action: "use" as const }
    const generic = await client.resolve(input)
    expect(generic.decision).toBe("DENY")
    const inspected = await client.resolve({ ...input, handsPlacement: { mode: "inspect" } })
    expect(inspected.decision).toBe("ALLOW")
    expect(() => requireRuntimePolicyDecision(inspected)).toThrow("RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED")
    expect(() => requireRuntimePolicyDecision(inspected, { mode: "inspect" })).toThrow("RUNTIME_POLICY_PLACEMENT_CONTEXT_INVALID")
    await expect(client.authorize({ ...input, handsPlacement: { mode: "inspect" } })).rejects.toThrow("RUNTIME_POLICY_PLACEMENT_CONTEXT_INVALID")
  })

  test("read shows the selected domain without authorizing execution", async () => {
    const client = createRuntimePolicyClient({
      fetch: async () => new Response(JSON.stringify(decision({ capability_id: "remote_hands.use", action: "use", target: "runtime:codex:remote_hands.use", constraints: managedPlacement })), { status: 200 }),
    })
    const snapshot = await client.read({ principal, botId: "bot-dylan", capabilityIds: ["remote_hands.use"] })
    expect(snapshot.decisions[0]?.decision).toBe("ALLOW")
    expect(snapshot.decisions[0]?.constraints).toEqual(managedPlacement)
    expect(() => requireRuntimePolicyDecision(snapshot.decisions[0]!)).toThrow("RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED")
  })

  test("enforces policy domain against the pinned workspace provider", async () => {
    const client = createRuntimePolicyClient({
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { correlation_id: string }
        return new Response(JSON.stringify(decision({ capability_id: "remote_hands.use", action: "use", target: "runtime:codex:remote_hands.use", correlation_id: body.correlation_id, constraints: managedPlacement })), { status: 200 })
      },
    })
    const input = { principal, botId: "bot-dylan", capabilityId: "remote_hands.use" as const, action: "use" as const, correlationId: "placement-1" }
    const allowed = await client.authorize({ ...input, handsPlacement: { mode: "enforce", provider: "cloudflare-hands" } })
    expect(allowed.decision).toBe("ALLOW")
    expect(requireRuntimePolicyDecision(allowed, { mode: "enforce", provider: "cloudflare-hands" })).toBe(allowed)
    const changed = await client.authorize({ ...input, handsPlacement: { mode: "enforce", provider: "e2b-self-hosted" } })
    expect(changed.decision).toBe("DENY")
    expect(changed.reason_code).toBe("POLICY_PLACEMENT_CHANGED")
    expect(() => requireRuntimePolicyDecision(changed, { mode: "enforce", provider: "e2b-self-hosted" })).toThrow("POLICY_PLACEMENT_CHANGED")
  })

  test("without a placement rule only the deployment provider is allowed", async () => {
    const client = createRuntimePolicyClient({
      environment: { GENIO_BOT_RUNTIME: "e2b-self-hosted" },
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { correlation_id: string }
        return new Response(JSON.stringify(decision({ capability_id: "remote_hands.use", action: "use", target: "runtime:codex:remote_hands.use", correlation_id: body.correlation_id })), { status: 200 })
      },
    })
    const input = { principal, botId: "bot-dylan", capabilityId: "remote_hands.use" as const, action: "use" as const, correlationId: "placement-default" }
    expect((await client.authorize({ ...input, handsPlacement: { mode: "enforce", provider: "e2b-self-hosted" } })).decision).toBe("ALLOW")
    const override = await client.authorize({ ...input, handsPlacement: { mode: "enforce", provider: "cloudflare-hands" } })
    expect(override.decision).toBe("DENY")
    expect(override.reason_code).toBe("POLICY_PLACEMENT_CHANGED")
  })

  test("Local Endpoint enforces its ON_PREM domain without presenting itself as E2B", async () => {
    const makeClient = (placementDomain: "ON_PREM" | "MANAGED_CLOUD" | null, configuredRuntime: string) => createRuntimePolicyClient({
      environment: { GENIO_BOT_RUNTIME: configuredRuntime },
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { correlation_id: string }
        return new Response(JSON.stringify(decision({
          capability_id: "remote_hands.use",
          action: "use",
          target: "runtime:codex:remote_hands.use",
          correlation_id: body.correlation_id,
          constraints: placementDomain ? [{ kind: "execution_placement", parameters: { execution_domain: placementDomain } }] : [],
        })), { status: 200 })
      },
    })
    const input = { principal, botId: "bot-dylan", capabilityId: "remote_hands.use" as const, action: "use" as const, correlationId: "local-endpoint-1", handsPlacement: { mode: "enforce" as const, localEndpoint: true as const } }
    const onPrem = await makeClient("ON_PREM", "cloudflare-hands").authorize(input)
    expect(onPrem.decision).toBe("ALLOW")
    expect(requireRuntimePolicyDecision(onPrem, input.handsPlacement)).toBe(onPrem)
    const managed = await makeClient("MANAGED_CLOUD", "e2b-self-hosted").authorize(input)
    expect(managed.decision).toBe("DENY")
    expect(managed.reason_code).toBe("POLICY_PLACEMENT_CHANGED")
    expect((await makeClient(null, "local").authorize(input)).decision).toBe("ALLOW")
    const cloudDefault = await makeClient(null, "cloudflare-hands").authorize(input)
    expect(cloudDefault.decision).toBe("DENY")
    expect(cloudDefault.reason_code).toBe("POLICY_PLACEMENT_CHANGED")
  })

  test("placement on another capability and unknown constraints remain denied", () => {
    expect(() => requireRuntimePolicyDecision(decision({ constraints: managedPlacement }))).toThrow("RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED")
    expect(() => requireRuntimePolicyDecision(decision({ capability_id: "remote_hands.use", action: "use", target: "runtime:codex:remote_hands.use", constraints: [{ kind: "path_allowlist", parameters: { paths: ["/tmp"] } }] }), { mode: "enforce", provider: "e2b-self-hosted" })).toThrow("RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED")
  })

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
        return new Response(JSON.stringify(decision({ action: "execute", correlation_id: body.correlation_id, constraints: [{ kind: "path_allowlist", parameters: { paths: ["/workspace"] } }] })), { status: 200 })
      },
    })

    const result = await client.authorize({ principal, botId: "bot-dylan", capabilityId: "shell.exec", action: "execute", correlationId: "corr-constraints" })
    expect(method).toBe("POST")
    expect(result.decision).toBe("DENY")
    expect(result.reason_code).toBe("RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED")
  })

  test("requires enforceable constraints before treating an ALLOW as executable", () => {
    expect(() => requireRuntimePolicyDecision(decision({ constraints: [{ kind: "path_allowlist", parameters: { paths: ["/workspace"] } }] }))).toThrow("RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED")
  })

  test("fails closed before execution when a decision action or target is not registered", () => {
    expect(() => requireRuntimePolicyDecision(decision({ capability_id: "code.javascript", action: "execute", target: "runtime:codex:code.javascript" }))).not.toThrow()
    expect(() => requireRuntimePolicyDecision(decision({ action: "invoke" }))).toThrow("RUNTIME_POLICY_RESPONSE_INVALID")
    expect(() => requireRuntimePolicyDecision(decision({ target: "runtime:codex:model.invoke" }))).toThrow("RUNTIME_POLICY_RESPONSE_INVALID")
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
          action: "execute",
          correlation_id: "corr-audit",
          obligations: [{ kind: "audit", enforcement_point_id: "AGENT_RUNTIME", parameters: {} }],
        })), { status: 200 })
      },
    })

    const authorized = await client.authorize({ principal, botId: "bot-dylan", capabilityId: "shell.exec", action: "execute", correlationId: "corr-audit" })
    expect(authorized.decision).toBe("ALLOW")
    await client.report({
      principal,
      botId: "bot-dylan",
      capabilityId: "shell.exec",
      action: "execute",
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
      action: "execute",
      outcome: "COMPLETED",
    })
  })

  test("fails closed for obligations without an implemented enforcement point", async () => {
    const client = createRuntimePolicyClient({
      fetch: async () => new Response(JSON.stringify(decision({
        action: "execute",
        correlation_id: "corr-obligation",
        obligations: [{ kind: "require_approval", parameters: {} }],
      })), { status: 200 }),
    })

    const result = await client.authorize({ principal, botId: "bot-dylan", capabilityId: "shell.exec", action: "execute", correlationId: "corr-obligation" })
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
          action: url.searchParams.get("action"),
          target: `runtime:codex:${url.searchParams.get("capability_id")}`,
        })), { status: 200 })
      },
    })

    const snapshot = await client.read({ principal, botId: "bot-dylan", capabilityIds: ["shell.exec", "filesystem.read"] })
    expect(snapshot.policy_id).toBe("one-policy.runtime.capabilities")
    expect(snapshot.policy_revision).toBe(4)
    expect(snapshot.decisions.map((item) => item.capability_id)).toEqual(["shell.exec", "filesystem.read"])
  })

  test("selects each runtime capability's executable action by default", async () => {
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
      capabilityIds: ["codex.subscription", "model.invoke", "code.javascript", "shell.exec"],
    })

    expect(requests).toEqual([
      { capabilityId: "codex.subscription", action: "use" },
      { capabilityId: "model.invoke", action: "invoke" },
      { capabilityId: "code.javascript", action: "execute" },
      { capabilityId: "shell.exec", action: "execute" },
    ])
    expect(snapshot.decisions.map((item) => [item.capability_id, item.action])).toEqual([
      ["codex.subscription", "use"],
      ["model.invoke", "invoke"],
      ["code.javascript", "execute"],
      ["shell.exec", "execute"],
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
