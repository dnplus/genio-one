import { expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDefaultOnePolicy } from "../../platform/platform-api/src/capabilities/one-policy/default"
import { createInMemoryRuntimePolicyStore } from "../../platform/platform-api/src/capabilities/one-policy/runtime-memory"
import { RUNTIME_POLICY_ID } from "../../platform/platform-api/src/capabilities/one-policy/runtime"
import { RUNTIME_REPORT_KEY_ID_HEADER, RUNTIME_REPORT_SIGNATURE_HEADER } from "../../../runtimes/gateway/services/shared/runtime-report-attestation"
import { BotRegistry } from "./bot-registry"
import { BotWorkspaceStore } from "./bot-workspace-store"
import { createCapabilityGate } from "./capability-gate"
import { executeHandsIsolate } from "./hands-isolate"
import { isolateToolDefinitions } from "./bot-isolate-tool"
import { HandsPlacementGate } from "./hands-placement-gate"
import { createRuntimePolicyClient } from "./runtime-policy"

test("isolate uses distinct real One Policy correlations and retries signed reports without rerunning JavaScript", async () => {
  const root = mkdtempSync(join(tmpdir(), "genio-isolate-policy-"))
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.GENIO_CF_HANDS_ORIGIN
  const originalToken = process.env.GENIO_CF_HANDS_TOKEN
  process.env.GENIO_CF_HANDS_ORIGIN = "https://hands.example.test"
  process.env.GENIO_CF_HANDS_TOKEN = "server-secret"
  const principal = { tenant_id: "tenant-a", subject_id: "owner-a", acting_client_id: "genio-one-bot", scopes: [] }
  const cpPrincipal = { tenant_id: principal.tenant_id, subject_id: principal.subject_id, client_id: principal.acting_client_id, role: "TENANT_ADMINISTRATOR" as const, organization_ids: [] }
  const keys = generateKeyPairSync("ed25519")
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
  const scope = { subject_ids: [], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] }
  const rule = (capabilityId: string, action: "use" | "execute" | "invoke", constraints: Array<{ kind: "execution_placement"; parameters: { execution_domain: "MANAGED_CLOUD" } }> = []) => ({ rule_id: `allow-${capabilityId}`, target: { runtime_id: "codex", capability_id: capabilityId }, actions: [action], effect: "ALLOW" as const, constraints, obligations: [] })
  const runtimeStore = createInMemoryRuntimePolicyStore({ defaultPolicy: (tenantId, at) => ({ tenant_id: tenantId, policy_id: RUNTIME_POLICY_ID, revision: 1, display_name: "Hands fixture", provenance: "SYSTEM_SEED", enabled: true, scope, rules: [rule("remote_hands.use", "use", [{ kind: "execution_placement", parameters: { execution_domain: "MANAGED_CLOUD" } }]), rule("code.javascript", "execute"), rule("filesystem.read", "invoke"), rule("filesystem.write", "invoke")], published_by_subject_id: null, created_at: at, published_at: at }) })
  await runtimeStore.ensureDefault({ tenantId: principal.tenant_id })
  const policy = createDefaultOnePolicy({ runtimeStore, runtimeReportKeyId: "fixture-key", runtimeReportPublicKeyPem: publicKey })
  const correlations = new Map<string, string>()
  let failCodeReport = true
  const policyFetch = async (input: URL, init?: RequestInit) => {
    const path = input.pathname
    const body = init?.body ? JSON.parse(String(init.body)) : null
    try {
      if (path.endsWith("/runtime-effective")) return Response.json(await policy.evaluateRuntime({ principal: cpPrincipal, bot_id: input.searchParams.get("bot_id")!, runtime_id: input.searchParams.get("runtime_id")!, capability_id: input.searchParams.get("capability_id")!, action: input.searchParams.get("action")! as "use", ...(input.searchParams.get("session_id") ? { session_id: input.searchParams.get("session_id")! } : {}) }))
      if (path.endsWith("/runtime-authorize")) {
        const result = await policy.authorizeRuntime({ ...body, principal: cpPrincipal })
        correlations.set(result.capability_id, result.correlation_id!)
        return Response.json(result)
      }
      if (path.endsWith("/runtime-report")) {
        if (body.capability_id === "code.javascript" && failCodeReport) { failCodeReport = false; return Response.json({ error: "TEMPORARY_REPORT_FAILURE" }, { status: 503 }) }
        const headers = new Headers(init?.headers)
        return Response.json(await policy.reportRuntime({ ...body, principal: cpPrincipal, reportAttestation: { keyId: headers.get(RUNTIME_REPORT_KEY_ID_HEADER)!, signature: headers.get(RUNTIME_REPORT_SIGNATURE_HEADER)! } }), { status: 201 })
      }
      throw new Error("UNEXPECTED_POLICY_PATH")
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "POLICY_FAILED" }, { status: typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 500 }) }
  }
  const runtimePolicy = createRuntimePolicyClient({ origin: "https://platform.example.test", reportKeyId: "fixture-key", reportPrivateKeyPem: privateKey, environment: { GENIO_BOT_RUNTIME: "cloudflare-hands" }, fetch: policyFetch })
  const registry = new BotRegistry(":memory:", join(root, "artifacts"))
  const workspaces = new BotWorkspaceStore(registry.db, (botId, owner) => registry.getOwned(botId, owner), join(root, "workspaces"))
  const bot = registry.create(principal, { name: "Isolate", description: "Real One Policy receipt" })
  const workspace = workspaces.create(principal, bot.id, "cloudflare-hands")
  const placement = new HandsPlacementGate(runtimePolicy, workspaces)
  const requestId = "eb34f284-5810-4a0b-9da5-76e72392a791"
  let executions = 0
  let remoteRevision = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === `/v1/workspaces/${workspace.workspaceId}` && init?.method === "PUT") return Response.json({ workspaceId: workspace.workspaceId, revision: remoteRevision })
    if (url.pathname.endsWith("/isolate") && init?.method === "POST") {
      const body = JSON.parse(String(init.body))
      expect(body.requestId).toBe(requestId)
      expect(body.workspaceAccess).toBe("read-write")
      if (remoteRevision === 0) { executions += 1; remoteRevision = 1 }
      return Response.json({ requestId, stdout: "done", stderr: "", exitCode: 0, revision: remoteRevision })
    }
    throw new Error(`UNEXPECTED_CF_PATH:${url.pathname}`)
  }) as unknown as typeof fetch
  const context = { botRegistry: registry, workspaces, runtimeBroker: { findByPrincipal: () => null, hasActiveWorkspaceLease: () => false }, capabilityGate: createCapabilityGate({ mode: "open" }), runtimePolicy, handsPlacement: placement } as any
  try {
    const input = { workspaceId: workspace.workspaceId, requestId, code: "console.log('done')", workspaceAccess: "read-write" as const }
    await expect(executeHandsIsolate(context, principal, bot.id, "actor-token", input)).rejects.toThrow("HANDS_RESULT_UNCONFIRMED")
    expect(executions).toBe(1)
    const retry = await executeHandsIsolate(context, principal, bot.id, "actor-token", input)
    expect(retry.revision).toBe(1)
    expect(executions).toBe(1)
    expect(correlations.size).toBe(4)
    expect(new Set(correlations.values()).size).toBe(4)
  } finally {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.GENIO_CF_HANDS_ORIGIN
    else process.env.GENIO_CF_HANDS_ORIGIN = originalOrigin
    if (originalToken === undefined) delete process.env.GENIO_CF_HANDS_TOKEN
    else process.env.GENIO_CF_HANDS_TOKEN = originalToken
    registry.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("Bot isolate input matches Cloudflare UUID, source, and timeout limits before provision", async () => {
  const principal = { tenant_id: "tenant-a", subject_id: "owner-a", acting_client_id: "genio-one-bot", scopes: [] }
  const requestId = "eb34f284-5810-4a0b-9da5-76e72392a791"
  const context = {
    botRegistry: { getOwned: () => ({ id: "bot-a" }) },
    runtimeBroker: { findByPrincipal: () => null },
    workspaces: { active: () => null },
    handsPlacement: { async providerForNew() { throw new Error("VALIDATED") } },
  } as any
  const execute = (overrides: Record<string, unknown>) => executeHandsIsolate(context, principal, "bot-a", "actor-token", { requestId, code: "1+1", ...overrides })
  for (const invalid of ["a".repeat(36), "eb34f284-5810-4a0b-9da5-76e72392a79z", "eb34f28458104a0b9da576e72392a791"]) {
    await expect(execute({ requestId: invalid })).rejects.toThrow("HANDS_REQUEST_ID_INVALID")
  }
  for (const invalid of ["", " ", " 1+1", "1+1 ", "a".repeat(65_537)]) {
    await expect(execute({ code: invalid })).rejects.toThrow("HANDS_ISOLATE_CODE_INVALID")
  }
  for (const invalid of [99, 30_001, 100.5]) {
    await expect(execute({ timeoutMs: invalid })).rejects.toThrow("HANDS_ISOLATE_TIMEOUT_INVALID")
  }
  await expect(execute({ code: "a".repeat(65_536), timeoutMs: 100 })).rejects.toThrow("VALIDATED")
  await expect(execute({ timeoutMs: 30_000 })).rejects.toThrow("VALIDATED")
  const schema = isolateToolDefinitions[0]!.inputSchema.properties as Record<string, { maxLength?: number; minimum?: number; maximum?: number; pattern?: string }>
  expect(schema.code.maxLength).toBe(65_536)
  expect(schema.timeoutMs).toMatchObject({ minimum: 100, maximum: 30_000 })
  expect(schema.requestId.pattern).toContain("{12}")
})
