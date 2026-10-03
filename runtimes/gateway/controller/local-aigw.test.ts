import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  absoluteMcpBackendPath,
  aigwSpanContentCapture,
  aigwRunArguments,
  activityUpstreamAttempted,
  activityPathWithoutQuery,
  authenticationFailureForNativeEvent,
  attachMcpRouteSecurityPolicies,
  consumeActivityLogLines,
  gatewayServiceEntrypoint,
  localCredentialSecrets,
  parseProcessorHttpObservation,
  projectionDocuments,
  readActivityCursor,
  writeActivityCursor,
} from "./local-aigw"
import { stopProcessTree, waitForEnvoyRunReadiness } from "./process-lifecycle"

async function startReadyServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    response.statusCode = request.url === "/ready" ? 200 : 404
    response.end()
  })
  await new Promise<void>((resolve, reject) => {
    const rejectStartup = (error: Error) => reject(error)
    server.once("error", rejectStartup)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectStartup)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("ready server did not bind TCP")
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

async function waitForTextFile(path: string): Promise<string> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    try {
      return (await readFile(path, "utf8")).trim()
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting for " + path)
}

test("local Gateway release apply resolves both managed services from the runtime services directory", () => {
  for (const service of ["authorizer", "processor"] as const) {
    const entrypoint = gatewayServiceEntrypoint(service)
    assert.equal(existsSync(entrypoint), true)
    assert.match(entrypoint, new RegExp(`runtimes/gateway/services/${service}/server\\.ts$`))
  }
})

test("local AIGW span content capture is disabled until explicitly enabled by its runtime environment", () => {
  assert.equal(aigwSpanContentCapture(), "false")
  assert.equal(aigwSpanContentCapture({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false" }), "false")
  assert.equal(aigwSpanContentCapture({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true" }), "true")
})

test("standalone release skips old and new GatewayConfig for a truncated gateway name", () => {
  const gatewayId = "g".repeat(252)
  const config = (value: string) => ({
    apiVersion: "aigateway.envoyproxy.io/v1beta1",
    kind: "GatewayConfig",
    metadata: {
      name: gatewayId,
      namespace: "default",
      annotations: { "genio.one/global-contract-revision": "2" },
      labels: { "genio.one/shared-component": "ai-gateway-config" },
    },
    spec: { extProc: { kubernetes: { env: [{
      name: "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
      value,
    }] } } },
  })
  const route = {
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRoute",
    metadata: { name: "public-route", namespace: "default" },
    spec: { rules: [{ backendRefs: [{ name: "upstream" }] }] },
  }
  const input = {
    command: { tenant_id: "tenant-1", desired_release: { gateway_id: gatewayId } },
    release: {
      gateway_configuration: { capture_message_content: false },
      projections: [{ projection: { operation: "APPLY", resources: [config("true"), route] } }],
    },
  } as any
  const historical = projectionDocuments(input, 19000)
  assert.doesNotMatch(historical, /kind: GatewayConfig/)

  input.release.gateway_configuration.capture_message_content = true
  input.release.projections.push({ projection: { operation: "APPLY", resources: [config("false")] } })
  const mixed = projectionDocuments(input, 19000)
  assert.doesNotMatch(mixed, /kind: GatewayConfig/)
  assert.match(mixed, /name: genio-one-detail-capture/)
  assert.match(mixed, /body: Streamed/)
  assert.match(mixed, /failOpen: false/)
})

test("legacy processor stdout without safety decisions retains its classification receipt", () => {
  const receipt = parseProcessorHttpObservation({
    event: "genio.one.processor-http-request-completed",
    correlation_id: "legacy-correlation",
    bundle_revision: "bundle-legacy",
    steps: [{ step_id: "token-vault", action: "TOKENIZE" }],
    data_classifications: [{
      classification: "PERSON",
      handling_action: "TOKENIZE",
      source: "DLP_DETECTOR",
      source_version: "builtin-v1",
      trust_level: "RUNTIME_OBSERVED",
      step_id: "token-vault",
    }],
  })

  assert.deepEqual(receipt?.safety_decisions, [])
  assert.deepEqual(receipt?.data_classifications, [{
    classification: "PERSON",
    handling_action: "TOKENIZE",
    source: "DLP_DETECTOR",
    source_version: "builtin-v1",
    trust_level: "RUNTIME_OBSERVED",
    step_id: "token-vault",
  }])
})

test("local AIGW flags precede its positional configuration path", () => {
  assert.deepEqual(aigwRunArguments("/runtime/release/gateway.yaml", 1064, "runtime-4"), [
    "run",
    "--admin-port",
    "1064",
    "--run-id",
    "runtime-4",
    "/runtime/release/gateway.yaml",
  ])
})

test("run-specific Envoy readiness accepts the current run admin listener", async () => {
  const server = await startReadyServer()
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "g1aigw-readiness-"))
  try {
    const runId = "r18"
    await mkdir(join(runtimeDirectory, runId), { recursive: true })
    await writeFile(join(runtimeDirectory, runId, "admin-address.txt"), `127.0.0.1:${server.port}\n`)
    await waitForEnvoyRunReadiness(runtimeDirectory, runId, { exitCode: null }, 1_000)
  } finally {
    await server.close()
    await rm(runtimeDirectory, { recursive: true, force: true })
  }
})

test("run-specific Envoy readiness ignores a ready listener from an earlier run", async () => {
  const server = await startReadyServer()
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "g1aigw-readiness-"))
  try {
    await mkdir(join(runtimeDirectory, "r17"), { recursive: true })
    await writeFile(join(runtimeDirectory, "r17", "admin-address.txt"), `127.0.0.1:${server.port}\n`)
    await assert.rejects(
      waitForEnvoyRunReadiness(runtimeDirectory, "r18", { exitCode: null }, 300),
      /aigw Envoy run did not become ready before the deadline/,
    )
  } finally {
    await server.close()
    await rm(runtimeDirectory, { recursive: true, force: true })
  }
})

test("process cleanup escalates for a detached group whose exited leader leaves a TERM-ignoring worker", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "g1aigw-process-tree-"))
  const workerPidPath = join(directory, "worker.pid")
  const workerSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"
  const leaderSource = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const worker = spawn(process.execPath, ['-e', " + JSON.stringify(workerSource) + "], { stdio: 'ignore' })",
    "writeFileSync(process.env.G1_AIGW_WORKER_PID_PATH, String(worker.pid))",
    "setTimeout(() => process.exit(0), 10)",
  ].join("; ")
  const leader = spawn(process.execPath, ["-e", leaderSource], {
    detached: true,
    env: { ...process.env, G1_AIGW_WORKER_PID_PATH: workerPidPath },
    stdio: "ignore",
  })
  try {
    await new Promise<void>((resolve, reject) => {
      leader.once("error", reject)
      leader.once("exit", () => resolve())
    })
    const workerPid = Number(await waitForTextFile(workerPidPath))
    assert.equal(Number.isSafeInteger(workerPid), true)
    await stopProcessTree(leader, 100)
    let workerRunning = true
    try {
      process.kill(workerPid, 0)
    } catch {
      workerRunning = false
    }
    assert.equal(workerRunning, false)
  } finally {
    if (leader.pid !== undefined) {
      try {
        process.kill(-leader.pid, "SIGKILL")
      } catch {}
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test("standalone MCPRoute security is attached from a sibling SecurityPolicy", () => {
  const resources: Array<Record<string, any>> = [
    {
      kind: "MCPRoute",
      metadata: {
        name: "resource-mcp-pending",
        annotations: { "genio.one/generated-httproute-name": "resource-mcp-pending" },
      },
      spec: { path: "/mcp", backendRefs: [{ path: "mcp" }] },
    },
    {
      kind: "SecurityPolicy",
      spec: {
        jwt: {
          providers: [{
            issuer: "http://127.0.0.1:58080/realms/genio-one",
            audiences: ["genio-one-product-api"],
            remoteJWKS: { uri: "http://127.0.0.1:58080/certs" },
            claimToHeaders: [{ claim: "sub", header: "x-genio-verified-subject" }],
          }],
        },
        extAuth: { failOpen: false },
        targetRefs: [{ kind: "HTTPRoute", name: "resource-mcp-pending" }],
      },
    },
  ]
  attachMcpRouteSecurityPolicies(resources)
  assert.equal(resources[0]!.spec.securityPolicy.oauth.issuer, "http://127.0.0.1:58080/realms/genio-one")
  assert.equal(resources[0]!.spec.securityPolicy.extAuth.failOpen, false)
})

test("MCP backend paths are absolute before aigw run applies them", () => {
  assert.equal(absoluteMcpBackendPath("mcp"), "/mcp")
  assert.equal(absoluteMcpBackendPath("/mcp"), "/mcp")
  assert.equal(absoluteMcpBackendPath("  mcp  "), "/mcp")
  assert.equal(absoluteMcpBackendPath(""), undefined)
  assert.equal(absoluteMcpBackendPath(undefined), undefined)
})

test("standalone local credentials materialize MCP and LLM API key references", () => {
  const resources = [{
    kind: "MCPRoute",
    spec: { backendRefs: [{ securityPolicy: { apiKey: { secretRef: { name: "mcp-key" } } } }] },
  }, {
    kind: "BackendSecurityPolicy",
    spec: { type: "APIKey", apiKey: { secretRef: { name: "llm-key" } } },
  }]
  const secrets = localCredentialSecrets(resources, {
    "mcp-key": "mcp-value",
    "llm-key": "llm-value",
  }, "default")

  assert.deepEqual(secrets.map((secret) => secret.metadata.name), ["mcp-key", "llm-key"])
  assert.deepEqual(secrets.map((secret) => secret.stringData.apiKey), ["mcp-value", "llm-value"])
})

test("standalone local credentials materialize and remove GCP workload identity references", () => {
  const policy = {
    kind: "BackendSecurityPolicy",
    spec: {
      type: "GCPCredentials",
      gcpCredentials: {
        workloadIdentityFederationConfig: {
          oidcExchangeToken: {
            oidc: {
              clientSecret: { name: "vertex-oidc-client", namespace: "default" },
            },
          },
        },
      },
    },
  }
  assert.deepEqual(localCredentialSecrets([policy], { "vertex-oidc-client": "local-only" }, "default"), [{
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "vertex-oidc-client", namespace: "default" },
    type: "Opaque",
    stringData: { "client-secret": "local-only" },
  }])
  assert.deepEqual(localCredentialSecrets([], {}, "default"), [])
  assert.throws(
    () => localCredentialSecrets([policy], {}, "default"),
    /Local credential value is missing for vertex-oidc-client/,
  )
})

test("an ext-auth denial does not treat a selected cluster as an upstream attempt", () => {
  assert.equal(activityUpstreamAttempted({
    response_code: 403,
    response_code_details: "ext_authz_denied",
    response_flags: "UAEX",
    upstream_cluster: "httproute/default/resource/rule/0",
    upstream_host: null,
  }), false)

  assert.equal(activityUpstreamAttempted({
    response_code: 403,
    response_code_details: "ext_authz_denied",
    response_flags: "UAEX",
    upstream_cluster: "httproute/default/resource/rule/0",
  }), false)
})

test("a concrete upstream host proves that the Gateway attempted the backend", () => {
  assert.equal(activityUpstreamAttempted({
    response_code: 200,
    response_code_details: "via_upstream",
    upstream_cluster: "httproute/default/resource/rule/0",
    upstream_host: "127.0.0.1:9856",
  }), true)
})

test("canonical activity paths do not retain query or fragment secrets", () => {
  const secret = "sentinel-api-key-do-not-store"
  assert.equal(
    activityPathWithoutQuery(`/v1/chat/completions?api_key=${secret}#fragment`),
    "/v1/chat/completions",
  )
  assert.equal(
    activityPathWithoutQuery(`/v1/chat/completions#fragment?api_key=${secret}`),
    "/v1/chat/completions",
  )
  assert.equal(activityPathWithoutQuery(`/v1/chat/${secret}`), `/v1/chat/${secret}`)
})

test("missing activity or authentication audit callbacks retain the native line", async () => {
  const failures: Array<{ lineNumber: number; phase: string; kind: string; message: string }> = []
  let cursor = 0
  const onFailure = ({ lineNumber, phase, kind, error }: {
    lineNumber: number
    phase: string
    kind: string
    error: unknown
  }) => failures.push({
    lineNumber,
    phase,
    kind,
    message: error instanceof Error ? error.message : String(error),
  })
  const persistCursor = async (nextCursor: number) => {
    cursor = nextCursor
  }
  const activityConsumed = await consumeActivityLogLines(
    [JSON.stringify({ event: "activity" })],
    cursor,
    () => ({ event: "activity" }),
    undefined,
    persistCursor,
    () => undefined,
    onFailure,
  )
  assert.equal(activityConsumed, 0)
  assert.equal(cursor, 0)
  assert.deepEqual(failures, [{
    lineNumber: 1,
    phase: "DELIVERY",
    kind: "ACTIVITY",
    message: "Activity delivery callback is not configured",
  }])

  failures.length = 0
  const authConsumed = await consumeActivityLogLines(
    [JSON.stringify({
      "x-request-id": "authn-correlation",
      response_code: 401,
      response_code_details: "jwt_authn_access_denied",
    })],
    cursor,
    () => null,
    async () => undefined,
    persistCursor,
    () => undefined,
    onFailure,
    (value, lineNumber) => authenticationFailureForNativeEvent("release-1", value, lineNumber),
    undefined,
  )
  assert.equal(authConsumed, 0)
  assert.equal(cursor, 0)
  assert.deepEqual(failures, [{
    lineNumber: 1,
    phase: "DELIVERY",
    kind: "AUTHENTICATION_FAILURE",
    message: "Authentication failure audit callback is not configured",
  }])
})

test("native JWT authentication failures produce deterministic anonymous audit events", () => {
  const value = {
    "x-request-id": "authn-correlation",
    response_code: "401",
    response_code_details: "jwt_authn_access_denied{Jwt_is_expired}",
    start_time: "2026-10-03T03:04:05.000Z",
    "genio.subject.id": "unverified-subject",
    "genio.client.id": "unverified-client",
  }
  const first = authenticationFailureForNativeEvent("release-1", value, 7)
  const retry = authenticationFailureForNativeEvent("release-1", value, 7)
  assert.ok(first)
  assert.deepEqual(retry, first)
  assert.deepEqual(first, {
    audit_event_id: first.audit_event_id,
    correlation_id: "authn-correlation",
    kind: "GATEWAY_AUTHENTICATION_FAILURE",
    outcome: "DENY",
    subject: null,
    acting_client: null,
    resource_id: null,
    capability_id: null,
    status: 401,
    reason: "JWT_AUTHN_ACCESS_DENIED",
    occurred_at: Math.floor(Date.parse("2026-10-03T03:04:05.000Z") / 1_000),
  })
  assert.notEqual(
    first.audit_event_id,
    authenticationFailureForNativeEvent("release-2", value, 7)?.audit_event_id,
  )
  assert.notEqual(
    first.audit_event_id,
    authenticationFailureForNativeEvent("release-1", value, 8)?.audit_event_id,
  )
  assert.equal(authenticationFailureForNativeEvent("release-1", { ...value, response_code: 403 }, 7), null)
  assert.equal(authenticationFailureForNativeEvent("release-1", {
    ...value,
    response_code_details: "jwt_authn_access_denied_extra",
  }, 7), null)
})

test("activity and authentication audit ACKs both gate cursor progress", async () => {
  const line = JSON.stringify({
    "x-request-id": "authn-correlation",
    response_code: 401,
    response_code_details: "jwt_authn_access_denied{Jwt_is_expired}",
    start_time: "2026-10-03T03:04:05.000Z",
    "genio.subject.id": "unverified-subject",
    "genio.client.id": "unverified-client",
  })
  let cursor = 0
  let activityAttempts = 0
  let auditAttempts = 0
  const failures: Array<{ lineNumber: number; phase: string; kind: string }> = []
  const toActivity = (value: unknown, authenticationFailure: boolean) =>
    authenticationFailure && value ? { id: "sanitized-authentication-failure" } : null
  const persistCursor = async (nextCursor: number) => {
    cursor = nextCursor
  }
  const firstConsumed = await consumeActivityLogLines(
    [line],
    cursor,
    toActivity,
    async () => {
      activityAttempts += 1
    },
    persistCursor,
    () => undefined,
    ({ lineNumber, phase, kind }) => failures.push({ lineNumber, phase, kind }),
    (value, lineNumber) => authenticationFailureForNativeEvent("release-1", value, lineNumber),
    async () => {
      auditAttempts += 1
      throw new Error("temporary audit delivery failure")
    },
  )
  assert.equal(firstConsumed, 0)
  assert.equal(cursor, 0)
  assert.equal(activityAttempts, 1)
  assert.equal(auditAttempts, 1)
  assert.deepEqual(failures, [{ lineNumber: 1, phase: "DELIVERY", kind: "AUTHENTICATION_FAILURE" }])

  const replayedAuditEvents: unknown[] = []
  const secondConsumed = await consumeActivityLogLines(
    [line],
    cursor,
    toActivity,
    async () => {
      activityAttempts += 1
    },
    persistCursor,
    () => undefined,
    () => undefined,
    (value, lineNumber) => authenticationFailureForNativeEvent("release-1", value, lineNumber),
    async (event) => {
      auditAttempts += 1
      replayedAuditEvents.push(event)
    },
  )
  assert.equal(secondConsumed, 1)
  assert.equal(cursor, 1)
  assert.equal(activityAttempts, 2)
  assert.equal(auditAttempts, 2)
  assert.equal(replayedAuditEvents.length, 1)
  assert.equal((replayedAuditEvents[0] as { audit_event_id: string }).audit_event_id,
    authenticationFailureForNativeEvent("release-1", JSON.parse(line), 1)?.audit_event_id)
})

test("activity reader replays unacknowledged lines after a reader restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "g1aigw-activity-reader-"))
  const logPath = join(directory, "activity.jsonl")
  const cursorPath = join(directory, "activity.cursor")
  const lines = [
    JSON.stringify({ id: "first" }),
    JSON.stringify({ id: "second" }),
  ]
  await writeFile(logPath, `${lines.join("\n")}\n`)
  const toActivity = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const id = (value as { id?: unknown }).id
    return typeof id === "string" ? { id } : null
  }
  const readPersistedCursor = async () => {
    try {
      return await readActivityCursor(cursorPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
      throw error
    }
  }
  const readCompleteLines = async () => {
    const content = await readFile(logPath, "utf8")
    const lastNewline = content.lastIndexOf("\n")
    return content.slice(0, lastNewline).split("\n")
  }
  try {
    const firstReaderDeliver = async () => {
      throw new Error("temporary delivery failure")
    }
    const firstReaderFailures: Array<{ lineNumber: number; phase: string }> = []
    const firstConsumed = await consumeActivityLogLines(
      await readCompleteLines(),
      await readPersistedCursor(),
      toActivity,
      firstReaderDeliver,
      (nextCursor) => writeActivityCursor(cursorPath, nextCursor),
      () => undefined,
      ({ lineNumber, phase }) => firstReaderFailures.push({ lineNumber, phase }),
    )
    assert.equal(firstConsumed, 0)
    assert.deepEqual(firstReaderFailures, [{ lineNumber: 1, phase: "DELIVERY" }])
    assert.equal(await readPersistedCursor(), 0)
    assert.equal(await readFile(logPath, "utf8"), `${lines.join("\n")}\n`)

    const replayed: string[] = []
    const secondReaderDeliver = async (event: { id: string }) => {
      replayed.push(event.id)
    }
    const secondConsumed = await consumeActivityLogLines(
      await readCompleteLines(),
      await readPersistedCursor(),
      toActivity,
      secondReaderDeliver,
      (nextCursor) => writeActivityCursor(cursorPath, nextCursor),
      () => undefined,
      () => undefined,
    )
    assert.equal(secondConsumed, 2)
    assert.deepEqual(replayed, ["first", "second"])
    assert.equal(await readActivityCursor(cursorPath), 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
