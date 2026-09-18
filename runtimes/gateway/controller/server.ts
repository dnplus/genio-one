import { observeOperation, observedFetch } from "../../../packages/telemetry/src/operation-observability"
import {
  createPrivateKey,
  createPublicKey,
  sign as signPayload,
} from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { serve } from "bun"

import type { VerificationKeyRing } from "../../../packages/protocol/src/compact-jws"
import type { GatewayRuntimeCommand } from "../../../packages/protocol/src/runtime-command"
import { createLocalAigwApplier } from "./local-aigw"
import { createKubernetesGatewayApplier } from "./kubernetes"
import {
  createGatewayRuntime,
  GatewayRuntimeDeploymentBindingError,
  type GatewayRuntimeSigner,
} from "./runtime"
import { createGatewayRuntimeFileState } from "./file-state"
import { createGatewayRuntimeFileAuthorityFloor } from "./authority-floor"
import { createRuntimeTokenSource, type RuntimeTokenSource } from "./runtime-token"
import { startLeaseHeartbeat } from "./lease-heartbeat"
import { discoverMcpConnection, discoverMcpWithUserAuthorization } from "./mcp-discovery"
import { materializeGatewayBootstrap } from "./bootstrap"
import { operationalError, writeOperationalEvent } from "../../../packages/telemetry/src/operational-log"
import type {
  CompleteMcpDiscoveryInput,
  McpDiscoveryOperation,
} from "../../../apps/platform/platform-api/src/capabilities/mcp-discovery/contract"
import type { ConnectionCertificate } from "../../../apps/platform/platform-api/src/capabilities/connections/contract"

interface RuntimeConfiguration {
  platformOrigin: string
  tenantId: string
  runtimeId: string
  gatewayId: string
  oidcClientId: string
  token?: string
  oidcTokenEndpoint?: string
  oidcClientIdFile?: string
  oidcClientSecretFile?: string
  oidcScope?: string
  commandKeyRingPath: string
  releaseRootKeyRingPath: string
  reportPrivateKeyPath: string
  reportKeyId: string
  applyMode: "LOCAL_AIGW" | "KUBERNETES"
  aigwBinary?: string
  kubectl?: string
  stateRoot: string
  adminPort: number
  listenerPort: number
  aigwDownloadTimeoutMs: number
  observationPort: number
  authorizerReadinessOrigin?: string
  processorReadinessOrigin?: string
  telemetry?: {
    name: string
    namespace?: string
    host: string
    port: number
    httpPort: number
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function port(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`)
  }
  return value
}

function positiveSeconds(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback * 1_000
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 3_600) {
    throw new Error(`${name} must be an integer from 1 through 3600`)
  }
  return value * 1_000
}

function localCredentialValues(): Record<string, string> {
  const raw = process.env.GENIO_ONE_LOCAL_CREDENTIALS_JSON?.trim()
  if (!raw) return {}
  const value = JSON.parse(raw) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GENIO_ONE_LOCAL_CREDENTIALS_JSON must be an object")
  }
  const result: Record<string, string> = {}
  for (const [name, secret] of Object.entries(value)) {
    if (!name || typeof secret !== "string" || !secret) {
      throw new Error("GENIO_ONE_LOCAL_CREDENTIALS_JSON values must be non-empty strings")
    }
    result[name] = secret
  }
  return result
}

function matchingEnvironment(name: string, expected: string): void {
  const value = process.env[name]?.trim()
  if (value && value !== expected) {
    throw new Error(`${name} conflicts with Gateway bootstrap`)
  }
}

async function configuration(): Promise<RuntimeConfiguration> {
  const applyMode = process.env.GENIO_ONE_GATEWAY_APPLY_MODE?.trim() || "LOCAL_AIGW"
  if (applyMode !== "LOCAL_AIGW" && applyMode !== "KUBERNETES") {
    throw new Error("GENIO_ONE_GATEWAY_APPLY_MODE must be LOCAL_AIGW or KUBERNETES")
  }
  const telemetryHost = process.env.GENIO_ONE_GATEWAY_OTEL_HOST?.trim()
  const stateRoot = resolve(process.env.GENIO_ONE_GATEWAY_RUNTIME_STATE ?? ".local/gateway-runtime")
  const bootstrapPath = process.env.GENIO_ONE_GATEWAY_BOOTSTRAP_FILE?.trim()
  const materialized = bootstrapPath
    ? await materializeGatewayBootstrap({ path: bootstrapPath, stateRoot })
    : null
  if (materialized) {
    matchingEnvironment("GENIO_ONE_PLATFORM_ORIGIN", materialized.bootstrap.platform_origin)
    matchingEnvironment("GENIO_ONE_TENANT_ID", materialized.bootstrap.tenant_id)
    matchingEnvironment("GENIO_ONE_RUNTIME_ID", materialized.bootstrap.runtime_id)
    matchingEnvironment("GENIO_ONE_GATEWAY_ID", materialized.bootstrap.gateway_id)
  }
  return {
    platformOrigin: materialized?.bootstrap.platform_origin ?? required("GENIO_ONE_PLATFORM_ORIGIN").replace(/\/$/, ""),
    tenantId: materialized?.bootstrap.tenant_id ?? required("GENIO_ONE_TENANT_ID"),
    runtimeId: materialized?.bootstrap.runtime_id ?? required("GENIO_ONE_RUNTIME_ID"),
    gatewayId: materialized?.bootstrap.gateway_id ?? required("GENIO_ONE_GATEWAY_ID"),
    oidcClientId: materialized?.bootstrap.oidc.client_id ?? (process.env.GENIO_ONE_RUNTIME_OIDC_CLIENT_ID?.trim() || required("GENIO_ONE_RUNTIME_ID")),
    token: process.env.GENIO_ONE_RUNTIME_TOKEN?.trim() || undefined,
    oidcTokenEndpoint: materialized?.bootstrap.oidc.token_endpoint ?? (process.env.GENIO_ONE_RUNTIME_OIDC_TOKEN_ENDPOINT?.trim() || undefined),
    oidcClientIdFile: materialized?.clientIdFile ?? (process.env.GENIO_ONE_RUNTIME_OIDC_CLIENT_ID_FILE?.trim() || undefined),
    oidcClientSecretFile: materialized?.clientSecretFile ?? (process.env.GENIO_ONE_RUNTIME_OIDC_CLIENT_SECRET_FILE?.trim() || undefined),
    oidcScope: materialized?.bootstrap.oidc.scope ?? (process.env.GENIO_ONE_RUNTIME_OIDC_SCOPE?.trim() || undefined),
    commandKeyRingPath: materialized?.commandKeyRingPath ?? required("GENIO_ONE_RUNTIME_COMMAND_KEYRING"),
    releaseRootKeyRingPath: materialized?.releaseRootKeyRingPath ?? required("GENIO_ONE_POLICY_RELEASE_ROOT_KEYRING"),
    reportPrivateKeyPath: materialized?.reportPrivateKeyPath ?? required("GENIO_ONE_RUNTIME_REPORT_PRIVATE_KEY"),
    reportKeyId: materialized?.bootstrap.report_signing.key_id ?? required("GENIO_ONE_RUNTIME_REPORT_KEY_ID"),
    applyMode,
    ...(applyMode === "LOCAL_AIGW"
      ? { aigwBinary: required("GENIO_ONE_AIGW_BINARY") }
      : { kubectl: process.env.GENIO_ONE_KUBECTL?.trim() || "kubectl" }),
    stateRoot,
    adminPort: port("GENIO_ONE_AIGW_ADMIN_PORT", 1064),
    listenerPort: port("GENIO_ONE_AIGW_LISTENER_PORT", 1975),
    aigwDownloadTimeoutMs: positiveSeconds("GENIO_ONE_AIGW_DOWNLOAD_TIMEOUT_SECONDS", 600),
    observationPort: port("GENIO_ONE_GATEWAY_OBSERVATION_PORT", 9090),
    authorizerReadinessOrigin:
      process.env.GENIO_ONE_AUTHORIZER_READINESS_ORIGIN?.trim() || undefined,
    processorReadinessOrigin:
      process.env.GENIO_ONE_PROCESSOR_READINESS_ORIGIN?.trim() || undefined,
    ...(telemetryHost
      ? {
          telemetry: {
            name: process.env.GENIO_ONE_GATEWAY_OTEL_BACKEND_NAME?.trim() || "genio-one-otel-collector",
            ...(process.env.GENIO_ONE_GATEWAY_OTEL_NAMESPACE?.trim()
              ? { namespace: process.env.GENIO_ONE_GATEWAY_OTEL_NAMESPACE.trim() }
              : {}),
            host: telemetryHost,
            port: port("GENIO_ONE_GATEWAY_OTEL_PORT", 4317),
            httpPort: port("GENIO_ONE_GATEWAY_OTEL_HTTP_PORT", 4318),
          },
        }
      : {}),
  }
}

function runtimePath(config: RuntimeConfiguration): string {
  return `/v1/tenants/${encodeURIComponent(config.tenantId)}/runtime-control/GATEWAY/${encodeURIComponent(config.runtimeId)}`
}

async function negotiate(
  config: RuntimeConfiguration,
  tokens: RuntimeTokenSource,
  signal?: AbortSignal,
): Promise<void> {
  const response = await observedFetch("genio-one-gateway-runtime", `${config.platformOrigin}${runtimePath(config)}/capabilities`, {
    method: "PUT",
    headers: { ...await tokens.headers(), "content-type": "application/json" },
    ...(signal ? { signal } : {}),
    body: JSON.stringify({
      protocol_versions: ["genio.one.runtime.v1"],
      preferred_protocol_version: "genio.one.runtime.v1",
      delivery_mode: "AGGREGATE_RELEASE",
    }),
  })
  if (!response.ok) {
    throw new Error(`Gateway Runtime capability negotiation failed (${response.status})`)
  }
}

async function heartbeat(
  config: RuntimeConfiguration,
  tokens: RuntimeTokenSource,
  signal?: AbortSignal,
): Promise<void> {
  const response = await observedFetch("genio-one-gateway-runtime",
    `${config.platformOrigin}${runtimePath(config)}/aggregate/heartbeat`,
    {
      method: "PUT",
      headers: await tokens.headers(),
      signal: AbortSignal.any([
        AbortSignal.timeout(5_000),
        ...(signal ? [signal] : []),
      ]),
    },
  )
  if (!response.ok) {
    throw new Error(`Gateway Runtime lease heartbeat failed (${response.status})`)
  }
}

interface ConnectionHealthTarget {
  resource_id: string
  connection_id: string
  endpoint: string
  credential_ref: string | null
  configuration_revision: number
  health_state: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNAVAILABLE"
  health_observed_at: number | null
  health_source_revision: number | null
  certificate?: ConnectionCertificate
}

type TlsRequestInit = RequestInit & { tls?: { ca?: string } }

function certificateFetchInit(certificate: ConnectionCertificate | undefined): RequestInit {
  if (certificate?.mode !== "CUSTOM_CA" || !certificate.certificate_pem) return {}
  return { tls: { ca: certificate.certificate_pem } } as TlsRequestInit
}

async function connectionHealthTargets(
  config: RuntimeConfiguration,
  tokens: RuntimeTokenSource,
): Promise<ConnectionHealthTarget[]> {
  const response = await observedFetch("genio-one-gateway-runtime", `${config.platformOrigin}${runtimePath(config)}/connection-health-targets`, {
    headers: await tokens.headers(),
  })
  if (!response.ok) throw new Error(`Gateway Runtime Connection health target poll failed (${response.status})`)
  return await response.json() as ConnectionHealthTarget[]
}

async function probeConnectionHealth(
  target: ConnectionHealthTarget,
): Promise<"HEALTHY" | "UNAVAILABLE"> {
  try {
    const response = await observedFetch("genio-one-gateway-runtime", target.endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
      ...certificateFetchInit(target.certificate),
    } as TlsRequestInit)
    return response.status < 500 ? "HEALTHY" : "UNAVAILABLE"
  } catch {
    return "UNAVAILABLE"
  }
}

function connectionHealthHostAllowed(endpoint: string): boolean {
  const hostname = new URL(endpoint).hostname.toLowerCase()
  const configured = (process.env.GENIO_ONE_CONNECTION_HEALTH_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  return ["127.0.0.1", "localhost", "::1"].includes(hostname) || configured.includes(hostname)
}

async function observeConnectionHealthBatch(
  config: RuntimeConfiguration,
  tokens: RuntimeTokenSource,
  observations: Array<{
    target: ConnectionHealthTarget
    state: "HEALTHY" | "UNAVAILABLE"
  }>,
  observedAt: number,
): Promise<void> {
  const response = await observedFetch("genio-one-gateway-runtime",
    `${config.platformOrigin}${runtimePath(config)}/connection-health-observations`,
    {
      method: "POST",
      headers: { ...await tokens.headers(), "content-type": "application/json" },
      body: JSON.stringify({
        correlation_id: `connection-health-${config.runtimeId}-${observedAt}`,
        observations: observations.map(({ target, state }) => ({
          resource_id: target.resource_id,
          connection_id: target.connection_id,
          source_revision: (target.health_source_revision ?? 0) + 1,
          state,
          observed_at: observedAt,
        })),
      }),
    },
  )
  if (!response.ok) {
    throw new Error(`Gateway Runtime Connection health scan failed (${response.status})`)
  }
}

async function refreshConnectionHealth(
  config: RuntimeConfiguration,
  tokens: RuntimeTokenSource,
): Promise<void> {
  const observedAt = Math.floor(Date.now() / 1_000)
  const targets = (await connectionHealthTargets(config, tokens)).filter((target) =>
    connectionHealthHostAllowed(target.endpoint) &&
    (target.health_observed_at === null || observedAt - target.health_observed_at >= 30)
  )
  const observations = await Promise.all(targets.map(async (target) => {
    const state = await probeConnectionHealth(target)
    return { target, state }
  }))
  if (observations.length > 0) {
    await observeConnectionHealthBatch(config, tokens, observations, observedAt)
  }
}

async function fetchRelease(
  config: RuntimeConfiguration,
  tokens: RuntimeTokenSource,
  command: GatewayRuntimeCommand,
): Promise<unknown> {
  const releaseId = encodeURIComponent(command.desired_release.release_id)
  const commandId = encodeURIComponent(command.command_id)
  const response = await observedFetch("genio-one-gateway-runtime",
    `${config.platformOrigin}${runtimePath(config)}/aggregate/releases/${releaseId}/package?command_id=${commandId}`,
    { headers: await tokens.headers() },
  )
  if (!response.ok) {
    throw new Error(`Gateway release download failed (${response.status})`)
  }
  return response.json()
}

async function pollCommand(
  config: RuntimeConfiguration,
  tokens: RuntimeTokenSource,
): Promise<GatewayRuntimeCommand | null> {
  const response = await observedFetch("genio-one-gateway-runtime",
    `${config.platformOrigin}${runtimePath(config)}/aggregate/commands/next`,
    { headers: await tokens.headers() },
  )
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2_048)
    throw new Error(
      `Gateway Runtime command poll failed (${response.status})${detail ? `: ${detail}` : ""}`,
    )
  }
  return await response.json() as GatewayRuntimeCommand | null
}

async function deliverReport(
  config: RuntimeConfiguration,
  tokens: RuntimeTokenSource,
  report: unknown,
): Promise<void> {
  const response = await observedFetch("genio-one-gateway-runtime",
    `${config.platformOrigin}${runtimePath(config)}/aggregate/reports`,
    {
      method: "POST",
      headers: { ...await tokens.headers(), "content-type": "application/json" },
      body: JSON.stringify(report),
    },
  )
  if (!response.ok) {
    throw new Error(`Gateway Runtime report delivery failed (${response.status})`)
  }
}

async function pollMcpDiscovery(
  config: RuntimeConfiguration,
  tokens: RuntimeTokenSource,
): Promise<McpDiscoveryOperation | null> {
  const response = await observedFetch("genio-one-gateway-runtime",
    `${config.platformOrigin}${runtimePath(config)}/operations/mcp-discovery/next`,
    { headers: await tokens.headers() },
  )
  if (!response.ok) {
    throw new Error(`Gateway Runtime MCP discovery poll failed (${response.status})`)
  }
  return await response.json() as McpDiscoveryOperation | null
}

async function deliverMcpDiscovery(
  config: RuntimeConfiguration,
  tokens: RuntimeTokenSource,
  operationId: string,
  result: CompleteMcpDiscoveryInput,
): Promise<void> {
  const response = await observedFetch("genio-one-gateway-runtime",
    `${config.platformOrigin}${runtimePath(config)}/operations/mcp-discovery/${encodeURIComponent(operationId)}/result`,
    {
      method: "POST",
      headers: { ...await tokens.headers(), "content-type": "application/json" },
      body: JSON.stringify(result),
    },
  )
  if (!response.ok) {
    throw new Error(`Gateway Runtime MCP discovery result delivery failed (${response.status})`)
  }
}

async function resolveMcpDiscoveryCredential(
  config: RuntimeConfiguration,
  tokens: RuntimeTokenSource,
  operationId: string,
): Promise<string> {
  const response = await observedFetch("genio-one-gateway-runtime",
    `${config.platformOrigin}${runtimePath(config)}/operations/mcp-discovery/${encodeURIComponent(operationId)}/credential`,
    { headers: await tokens.headers() },
  )
  if (!response.ok) throw new Error("MCP discovery credential is unavailable")
  const value = await response.json() as { access_token?: unknown }
  if (typeof value.access_token !== "string" || !value.access_token) {
    throw new Error("MCP discovery credential is unavailable")
  }
  return value.access_token
}

function discoveryError(error: unknown): CompleteMcpDiscoveryInput {
  const message = (error instanceof Error ? error.message : "MCP discovery failed")
    .replace(/[\u0000\r\n]+/g, " ")
    .slice(0, 2_048)
  const code = message.includes("interactive")
    ? "MCP_DISCOVERY_INTERACTIVE_AUTHORIZATION_REQUIRED"
    : message.includes("credential")
      ? "MCP_DISCOVERY_CREDENTIAL_UNAVAILABLE"
      : "MCP_DISCOVERY_FAILED"
  return { state: "FAILED", error_code: code, error_message: message }
}

async function executeMcpDiscovery(
  operation: McpDiscoveryOperation,
  credentials: Readonly<Record<string, string>>,
  oauthCredential: () => Promise<string>,
): Promise<CompleteMcpDiscoveryInput> {
  try {
    writeOperationalEvent("gateway-runtime", "INFO", "genio.one.mcp-discovery.started", {
      operation_id: operation.operation_id,
      connection_id: operation.connection_id,
      downstream_identity_mode: operation.downstream_identity.mode,
    })
    const identity = operation.downstream_identity
    if (identity.mode === "USER_PASSTHROUGH") {
      throw new Error("MCP discovery requires an interactive user credential")
    }
    const credential = identity.mode === "SERVICE"
      ? operation.credential_ref
        ? credentials[operation.credential_ref]
        : undefined
      : undefined
    writeOperationalEvent("gateway-runtime", "INFO", "genio.one.mcp-discovery.credential-resolved", {
      operation_id: operation.operation_id,
      credential_present: Boolean(credential),
    })
    if (identity.mode === "SERVICE" && !credential) {
      throw new Error("MCP discovery credential is unavailable in this Gateway Runtime")
    }
    const observation = identity.mode === "USER_OAUTH"
      ? await discoverMcpWithUserAuthorization({ endpoint: operation.endpoint, credential: oauthCredential })
      : await discoverMcpConnection({
          endpoint: operation.endpoint,
          ...(credential ? { authProvider: { token: async () => credential } } : {}),
        })
    writeOperationalEvent("gateway-runtime", "INFO", "genio.one.mcp-discovery.observed", {
      operation_id: operation.operation_id,
      server_name: observation.server_name,
      tool_count: observation.tools.length,
    })
    return { state: "SUCCEEDED", observation }
  } catch (error) {
    return discoveryError(error)
  }
}

async function runtimeIdentity(config: RuntimeConfiguration): Promise<{
  signer: GatewayRuntimeSigner
  publicKeyPem: string
}> {
  const privateKey = createPrivateKey(await readFile(config.reportPrivateKeyPath, "utf8"))
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Gateway Runtime report key must be Ed25519")
  }
  return {
    publicKeyPem: createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString(),
    signer: {
      keyId: config.reportKeyId,
      sign(payload) {
        return signPayload(null, Buffer.from(payload), privateKey).toString("base64url")
      },
    },
  }
}

async function registerRuntime(
  config: RuntimeConfiguration,
  tokens: RuntimeTokenSource,
  reportPublicKeyPem: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await observedFetch("genio-one-gateway-runtime", `${config.platformOrigin}${runtimePath(config)}/registration`, {
    method: "PUT",
    headers: { ...await tokens.headers(), "content-type": "application/json" },
    ...(signal ? { signal } : {}),
    body: JSON.stringify({
      target_id: config.gatewayId,
      oidc_client_id: config.oidcClientId,
      report_key_id: config.reportKeyId,
      report_public_key_pem: reportPublicKeyPem,
      status: "ACTIVE",
    }),
  })
  if (!response.ok) {
    throw new Error(`Gateway Runtime self-registration failed (${response.status})`)
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
    return
  }
  const abortSignal = signal
  if (abortSignal.aborted) return
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(done, milliseconds)
    function done() {
      clearTimeout(timer)
      abortSignal.removeEventListener("abort", done)
      resolveDelay()
    }
    abortSignal.addEventListener("abort", done, { once: true })
  })
}

async function waitForDependency(
  label: string,
  operation: () => Promise<void>,
  signal?: AbortSignal,
): Promise<boolean> {
  let delayMilliseconds = 250
  while (!signal?.aborted) {
    try {
      await operation()
      return true
    } catch (error) {
      if (signal?.aborted) return false
      writeOperationalEvent("gateway-runtime", "WARN", "genio.one.gateway-runtime.dependency-retry", {
        dependency: label,
        ...operationalError(error),
      })
      await abortableDelay(delayMilliseconds, signal)
      delayMilliseconds = Math.min(delayMilliseconds * 2, 5_000)
    }
  }
  return false
}

function startObservationRelay(
  config: RuntimeConfiguration,
  tokens: RuntimeTokenSource,
) {
  return serve({
    hostname: "127.0.0.1",
    port: config.observationPort,
    async fetch(request) {
      const url = new URL(request.url)
      const pathname = url.pathname
      if (request.method === "GET" && pathname === "/mcp-oauth/headers") {
        const resourceId = url.searchParams.get("resource_id")?.trim()
        const subjectId = url.searchParams.get("subject_id")?.trim()
        if (
          !resourceId ||
          !subjectId ||
          resourceId.length > 256 ||
          subjectId.length > 256 ||
          /[\u0000\r\n]/.test(resourceId) ||
          /[\u0000\r\n]/.test(subjectId)
        ) {
          return new Response("Bad Request", { status: 400 })
        }
        const target = new URL(
          `${config.platformOrigin}${runtimePath(config)}/mcp-oauth/headers`,
        )
        target.searchParams.set("resource_id", resourceId)
        target.searchParams.set("subject_id", subjectId)
        const mcpMethod = url.searchParams.get("mcp_method")
        if (mcpMethod) target.searchParams.set("mcp_method", mcpMethod)
        const response = await observedFetch("genio-one-gateway-runtime", target, { headers: await tokens.headers() })
        return new Response(await response.text(), {
          status: response.status,
          headers: {
            "cache-control": "no-store",
            "content-type": response.headers.get("content-type") ?? "application/json",
          },
        })
      }
      const target = pathname === "/activities"
        ? "activities"
        : pathname === "/audit-events"
          ? "audit-events"
          : pathname === "/accounting"
            ? "accounting"
          : undefined
      if (request.method !== "POST" || !target) return new Response("Not Found", { status: 404 })
      const contentLength = Number(request.headers.get("content-length") ?? "0")
      if (!Number.isFinite(contentLength) || contentLength > 262_144) {
        return new Response("Payload Too Large", { status: 413 })
      }
      const body = await request.text()
      if (body.length > 262_144) return new Response("Payload Too Large", { status: 413 })
      let correlationId: string | undefined
      try { const observation = JSON.parse(body); if (typeof observation.correlation_id === "string") correlationId = observation.correlation_id } catch { return new Response("Invalid JSON", { status: 400 }) }
      const response = await observedFetch("genio-one-gateway-runtime",
        `${config.platformOrigin}${runtimePath(config)}/${target}`,
        {
          method: "POST",
          headers: { ...await tokens.headers(), "content-type": "application/json", ...(correlationId ? { "x-genio-correlation-id": correlationId } : {}) },
          body,
        },
      )
      return new Response(await response.text(), {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
      })
    },
  })
}

async function main(): Promise<void> {
  const config = await configuration()
  const credentials = localCredentialValues()
  const tokens = createRuntimeTokenSource({
    staticToken: config.token,
    tokenEndpoint: config.oidcTokenEndpoint,
    clientIdFile: config.oidcClientIdFile,
    clientSecretFile: config.oidcClientSecretFile,
    scope: config.oidcScope,
  })
  const observationRelay = startObservationRelay(config, tokens)
  const commandKeyRing = JSON.parse(
    await readFile(config.commandKeyRingPath, "utf8"),
  ) as VerificationKeyRing
  const identity = await runtimeIdentity(config)
  const shutdownController = new AbortController()
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    shutdownController.abort()
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
  const applier = config.applyMode === "KUBERNETES"
    ? createKubernetesGatewayApplier({
        stateRoot: config.stateRoot,
        kubectl: config.kubectl,
        authorizerReadinessOrigin: config.authorizerReadinessOrigin,
        processorReadinessOrigin: config.processorReadinessOrigin,
        telemetry: config.telemetry,
        async credentials(command, release) {
          const response = await observedFetch("genio-one-gateway-runtime", `${config.platformOrigin}${runtimePath(config)}/aggregate/releases/${encodeURIComponent(release.release_id)}/credentials?command_id=${encodeURIComponent(command.command_id)}`, { headers: await tokens.headers(), signal: AbortSignal.timeout(30000) })
          if (!response.ok) throw new Error("GATEWAY_CREDENTIAL_DOWNLOAD_FAILED")
          return response.json()
        },
      })
    : createLocalAigwApplier({
        binary: config.aigwBinary!,
        stateRoot: config.stateRoot,
        adminPort: config.adminPort,
        listenerPort: config.listenerPort,
        aigwDownloadTimeoutMs: config.aigwDownloadTimeoutMs,
        shutdownSignal: shutdownController.signal,
        telemetry: config.telemetry,
        runtimeCommandKeyRingPath: config.commandKeyRingPath,
        releaseRootKeyRingPath: config.releaseRootKeyRingPath,
        environment: {
          ...process.env,
          GENIO_ONE_GATEWAY_OBSERVATION_ORIGIN: `http://127.0.0.1:${config.observationPort}`,
        },
        localCredentialValues: credentials,
        async onActivity(event) {
          return observeOperation("genio-one-gateway-runtime", "envoy.activity.materialize", event, async () => {
          const response = await observedFetch("genio-one-gateway-runtime",
            `${config.platformOrigin}${runtimePath(config)}/activities`,
            {
              method: "POST",
              headers: { ...await tokens.headers(), "content-type": "application/json", "x-genio-correlation-id": event.correlation_id },
              body: JSON.stringify(event),
            },
          )
          if (!response.ok) {
            throw new Error(`Gateway activity delivery failed (${response.status})`)
          }
          })
        },
      })
  const runtime = createGatewayRuntime({
    deployment: {
      tenantId: config.tenantId,
      runtimeId: config.runtimeId,
      gatewayId: config.gatewayId,
    },
    commandKeyRing,
    signer: identity.signer,
    fetchRelease: (command) => fetchRelease(config, tokens, command),
    applier,
    authorityFloor: createGatewayRuntimeFileAuthorityFloor(resolve(config.stateRoot, "authority-floor.json")),
    state: createGatewayRuntimeFileState(resolve(config.stateRoot, "current.json")),
  })

  if (!stopping) {
    try {
      if (await runtime.restore()) {
        writeOperationalEvent("gateway-runtime", "INFO", "genio.one.gateway-runtime.release-restored")
      }
    } catch (error) {
      writeOperationalEvent("gateway-runtime", "ERROR", "genio.one.gateway-runtime.persisted-release-rejected", {
        ...operationalError(error),
      })
    }
  }
  if (!stopping) await waitForDependency(
    "Gateway Runtime registration",
    () => registerRuntime(config, tokens, identity.publicKeyPem, shutdownController.signal),
    shutdownController.signal,
  )
  if (!stopping) await waitForDependency(
    "Gateway Runtime capability negotiation",
    () => negotiate(config, tokens, shutdownController.signal),
    shutdownController.signal,
  )
  let leaseHeartbeat: ReturnType<typeof startLeaseHeartbeat> | undefined
  if (!stopping) {
    const renewed = await waitForDependency(
      "Gateway Runtime lease heartbeat",
      () => heartbeat(config, tokens, shutdownController.signal),
      shutdownController.signal,
    )
    if (renewed && !stopping) {
      leaseHeartbeat = startLeaseHeartbeat({
        signal: shutdownController.signal,
        startImmediately: false,
        heartbeat: (signal) => heartbeat(config, tokens, signal),
        onError(error) {
          writeOperationalEvent("gateway-runtime", "WARN", "genio.one.gateway-runtime.lease-heartbeat-failed", {
            runtime_id: config.runtimeId,
            gateway_id: config.gatewayId,
            ...operationalError(error),
          })
        },
      })
    }
  }
  let lastConnectionHealthScanAt = 0
  let lastRuntimeReportAt = 0

  while (!stopping) {
    try {
      const currentTime = Math.floor(Date.now() / 1_000)
      if (currentTime - lastConnectionHealthScanAt >= 30) {
        await refreshConnectionHealth(config, tokens)
        lastConnectionHealthScanAt = currentTime
      }
      const command = await pollCommand(config, tokens)
      if (command) {
        const report = await runtime.applyCommand(command)
        await deliverReport(config, tokens, report)
        lastRuntimeReportAt = currentTime
        const error = report.observed_status.state === "DEGRADED"
          ? report.observed_status.error
          : undefined
        const safeError = error ? operationalError(new Error(error.message)) : undefined
        writeOperationalEvent("gateway-runtime", "INFO", "genio.one.gateway-runtime-report", {
          state: report.observed_status.state,
          revision: report.revision,
          error_code: error?.code ?? null,
          error_message: safeError?.error_message ?? null,
        })
      }
      if (!command && currentTime - lastRuntimeReportAt >= 30) {
        const report = await runtime.reportCurrent()
        if (report) {
          await deliverReport(config, tokens, report)
          lastRuntimeReportAt = currentTime
          writeOperationalEvent("gateway-runtime", "INFO", "genio.one.gateway-runtime-report", {
            state: report.observed_status.state,
            revision: report.revision,
            error_code: null,
            error_message: null,
          })
        }
      }
      const discovery = await pollMcpDiscovery(config, tokens)
      if (discovery) {
        const result = await executeMcpDiscovery(
          discovery,
          credentials,
          () => resolveMcpDiscoveryCredential(config, tokens, discovery.operation_id),
        )
        await deliverMcpDiscovery(config, tokens, discovery.operation_id, result)
        writeOperationalEvent("gateway-runtime", "INFO", "genio.one.mcp-discovery", {
          operation_id: discovery.operation_id,
          connection_id: discovery.connection_id,
          state: result.state,
          error_code: result.state === "FAILED" ? result.error_code : null,
        })
      }
    } catch (error) {
      if (!stopping) {
        writeOperationalEvent("gateway-runtime", "ERROR", error instanceof GatewayRuntimeDeploymentBindingError
          ? "genio.one.gateway-runtime.deployment-binding-rejected"
          : "genio.one.gateway-runtime.control-poll-failed", {
          runtime_id: config.runtimeId,
          gateway_id: config.gatewayId,
          ...operationalError(error),
        })
      }
    }
    if (!stopping) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000))
  }
  await leaseHeartbeat?.stop()
  await applier.close()
  await observationRelay.stop(true)
}

await main()
