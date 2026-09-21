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
  attachMcpRouteSecurityPolicies,
  gatewayServiceEntrypoint,
  localCredentialSecrets,
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
