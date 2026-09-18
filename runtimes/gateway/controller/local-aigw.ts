import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { join } from "node:path"

import { mergeGatewayNativeResources } from "./native-resources"
import { withGatewayDetailCapture } from "./detail-capture"
import {
  aigwEphemeralRunId,
  aigwRuntimeEnvironment,
  createAigwEphemeralRuntimeDirectory,
  prepareAigwRuntimeCache,
  removeAigwEphemeralRuntimeDirectory,
  type AigwEphemeralRuntimeDirectory,
} from "./aigw-runtime-cache"
import { operationalError, writeOperationalEvent } from "../../../packages/telemetry/src/operational-log"

import { stringify } from "yaml"
import { Check } from "typebox/value"

import type { GatewayComponentObservation } from "../../../packages/protocol/src/gateway-release"
import type { GatewayActivityIngest } from "../../../apps/platform/platform-api/src/capabilities/activities/contract"
import { POLICY_RELEASE_FILES } from "../services/shared/policy-release"
import { gatewayDetailActivityReference } from "../../../packages/telemetry/src/otlp-detail-capture"
import {
  DataClassificationReceiptSchema,
  type DataClassificationReceipt,
} from "../services/shared/data-classification"
import type { GatewayReleaseApplier } from "./runtime"

export interface LocalAigwOptions {
  binary: string
  stateRoot: string
  adminPort: number
  listenerPort?: number
  telemetry?: { port: number; httpPort: number }
  environment?: NodeJS.ProcessEnv
  /** Development-only secret values keyed by the projected Kubernetes Secret name. */
  localCredentialValues?: Readonly<Record<string, string>>
  readinessTimeoutMs?: number
  aigwDownloadTimeoutMs?: number
  shutdownSignal?: AbortSignal
  runtimeCommandKeyRingPath: string
  releaseRootKeyRingPath: string
  onActivity?(event: GatewayActivityIngest): Promise<void>
}

interface ModelRouteLeaseObservation {
  event: "genio.one.model-route-lease"
  correlation_id: string
  lease_id: string
  routing_policy_id: string
  routing_revision: number
  candidate_set_digest: string
  selected_public_model_id: string
  selected_public_model: string
  connection_id: string
  provider_model: string
  reused: boolean
}

interface ProcessorHttpObservation {
  event: "genio.one.processor-http-request-completed" |
    "genio.one.processor-http-response-completed"
  correlation_id: string
  bundle_revision: string
  steps: Array<{ step_id: string; action: string }>
  data_classifications: DataClassificationReceipt[]
}

export function attachMcpRouteSecurityPolicies(resources: Array<Record<string, any>>): void {
  const policies = resources.filter((resource) => resource.kind === "SecurityPolicy")
  for (const route of resources) {
    if (route.kind !== "MCPRoute" || route.spec?.securityPolicy) continue
    const generatedName = route.metadata?.annotations?.["genio.one/generated-httproute-name"]
      ?? route.metadata?.name
    const policy = policies.find((candidate) =>
      Array.isArray(candidate.spec?.targetRefs) &&
      candidate.spec.targetRefs.some((ref: { name?: string }) => ref?.name === generatedName),
    )
    const provider = policy?.spec?.jwt?.providers?.[0]
    if (!policy || !provider?.issuer) continue
    route.spec ??= {}
    route.spec.securityPolicy = {
      oauth: {
        issuer: provider.issuer,
        audiences: provider.audiences ?? [],
        jwks: { remoteJWKS: { uri: provider.remoteJWKS?.uri } },
        claimToHeaders: provider.claimToHeaders ?? [],
      },
      ...(policy.spec.extAuth ? { extAuth: policy.spec.extAuth } : {}),
    }
  }
}

export function absoluteMcpBackendPath(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined
  const trimmed = path.trim()
  if (!trimmed) return undefined
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

export function gatewayServiceEntrypoint(service: "authorizer" | "processor"): string {
  return join(import.meta.dirname, "..", "services", service, "server.ts")
}

/**
 * The signed Gateway diagnostic setting controls detail-capture policies. This
 * independently controls AIGW span content and is disabled unless an operator
 * explicitly enables it in the local runtime environment.
 */
export function aigwSpanContentCapture(environment?: NodeJS.ProcessEnv): "true" | "false" {
  return environment?.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === "true"
    ? "true"
    : "false"
}

/** Keep native command flags before its positional configuration path. */
export function aigwRunArguments(configPath: string, adminPort: number, runId: string): string[] {
  return ["run", "--admin-port", String(adminPort), "--run-id", runId, configPath]
}

/** A selected cluster is routing intent; only an upstream host proves an attempt. */
export function activityUpstreamAttempted(raw: Record<string, unknown>): boolean {
  return typeof raw.upstream_host === "string" && raw.upstream_host.length > 0
}

export function localCredentialSecrets(
  resources: Array<Record<string, any>>,
  localCredentialValues: Readonly<Record<string, string>>,
  namespaceName: string,
): Array<Record<string, any>> {
  const secretKeys = new Map<string, "apiKey" | "client-secret">()
  const addSecret = (secretName: unknown, key: "apiKey" | "client-secret") => {
    if (typeof secretName !== "string") return
    const existing = secretKeys.get(secretName)
    if (existing && existing !== key) {
      throw new Error(`Local credential ${secretName} is referenced with incompatible secret keys`)
    }
    secretKeys.set(secretName, key)
  }
  for (const resource of resources) {
    if (resource.kind === "MCPRoute" && Array.isArray(resource.spec?.backendRefs)) {
      for (const backendRef of resource.spec.backendRefs) {
        const secretName = backendRef?.securityPolicy?.apiKey?.secretRef?.name
        addSecret(secretName, "apiKey")
      }
    }
    if (resource.kind === "BackendSecurityPolicy" && resource.spec?.type === "APIKey") {
      const secretName = resource.spec?.apiKey?.secretRef?.name
      addSecret(secretName, "apiKey")
    }
    if (resource.kind === "BackendSecurityPolicy" && resource.spec?.type === "GCPCredentials") {
      const secretName = resource.spec?.gcpCredentials
        ?.workloadIdentityFederationConfig
        ?.oidcExchangeToken
        ?.oidc
        ?.clientSecret
        ?.name
      addSecret(secretName, "client-secret")
    }
  }
  return [...secretKeys].map(([secretName, key]) => {
    const value = localCredentialValues[secretName]
    if (!value) throw new Error(`Local credential value is missing for ${secretName}`)
    return {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: secretName, namespace: namespaceName },
      type: "Opaque",
      stringData: { [key]: value },
    }
  })
}

function positivePort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${label} must be a valid TCP port`)
  }
  return value
}


function standaloneApiRouteName(name: string): string {
  return `ai-eg-mcp-api-${createHash("sha256").update(name).digest("hex").slice(0, 32)}`
}

const PROCESS_TREE_STOP_TIMEOUT_MS = 5_000

function processHasExited(child: Pick<ChildProcess, "exitCode" | "signalCode">): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function terminateProcessTree(
  child: ChildProcess | undefined,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!child) return
  if (process.platform === "win32" || child.pid === undefined) {
    if (!processHasExited(child)) child.kill(signal)
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    if (!processHasExited(child)) child.kill(signal)
  }
}

function processTreeHasExited(child: ChildProcess): boolean {
  if (process.platform === "win32" || child.pid === undefined) return processHasExited(child)
  try {
    process.kill(-child.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
  }
}

async function waitForProcessTreeExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (processTreeHasExited(child)) return true
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())))
  }
  return processTreeHasExited(child)
}

export async function stopProcessTree(
  child: ChildProcess | undefined,
  timeoutMs = PROCESS_TREE_STOP_TIMEOUT_MS,
): Promise<void> {
  if (!child) return
  terminateProcessTree(child, "SIGTERM")
  if (await waitForProcessTreeExit(child, timeoutMs)) return
  terminateProcessTree(child, "SIGKILL")
  if (await waitForProcessTreeExit(child, timeoutMs)) return
  throw new Error("aigw process group did not exit after SIGKILL")
}

async function waitForHealth(
  origin: string,
  process: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`aigw run exited before readiness with code ${process.exitCode}`)
    }
    try {
      const response = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok) return
    } catch {
      // The admin listener is expected to refuse connections while starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error("aigw run did not become ready before the deadline")
}

function envoyAdminOrigin(address: string): string | undefined {
  const match = /^127\.0\.0\.1:(\d{1,5})\s*$/.exec(address)
  if (!match) return undefined
  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  return `http://127.0.0.1:${port}`
}

export async function waitForEnvoyRunReadiness(
  runtimeDirectory: string,
  runId: string,
  process: Pick<ChildProcess, "exitCode">,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const adminAddressPath = join(runtimeDirectory, runId, "admin-address.txt")
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`aigw run exited before Envoy readiness with code ${process.exitCode}`)
    }
    try {
      const origin = envoyAdminOrigin(await readFile(adminAddressPath, "utf8"))
      if (origin) {
        const response = await fetch(`${origin}/ready`, {
          signal: AbortSignal.timeout(1_000),
        })
        if (response.ok) return
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error("aigw Envoy run did not become ready before the deadline")
}

async function waitForListener(
  port: number,
  process: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`aigw run exited before Envoy readiness with code ${process.exitCode}`)
    }
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port })
      const finish = (value: boolean) => {
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(1_000, () => finish(false))
      socket.once("connect", () => finish(true))
      socket.once("error", () => finish(false))
    })
    if (connected) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error("Envoy listener did not become ready before the deadline")
}

function localGatewayInfrastructure(input: {
  gatewayId: string
  namespace: string
  listenerPort: number
  aiGatewayEnabled: boolean
  envoyProxySpec?: Record<string, unknown>
}): unknown[] {
  const gatewayClassName = `${input.gatewayId}-local`
  return [
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "GatewayClass",
      metadata: { name: gatewayClassName },
      spec: { controllerName: "gateway.envoyproxy.io/gatewayclass-controller" },
    },
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "Gateway",
      metadata: {
        name: input.gatewayId,
        namespace: input.namespace,
        ...(input.aiGatewayEnabled ? {
          annotations: {
            "aigateway.envoyproxy.io/gateway-config": `${input.gatewayId}-config`,
          },
        } : {}),
      },
      spec: {
        gatewayClassName,
        listeners: [
          { name: "http", protocol: "HTTP", port: input.listenerPort },
          { name: "internal", protocol: "HTTP", port: input.listenerPort + 1 },
        ],
        infrastructure: {
          parametersRef: {
            group: "gateway.envoyproxy.io",
            kind: "EnvoyProxy",
            name: input.gatewayId,
          },
        },
      },
    },
    {
      apiVersion: "gateway.envoyproxy.io/v1alpha1",
      kind: "EnvoyProxy",
      metadata: { name: input.gatewayId, namespace: input.namespace },
      spec: input.envoyProxySpec ?? {},
    },
    ...(input.aiGatewayEnabled ? [{
      apiVersion: "gateway.envoyproxy.io/v1alpha1",
      kind: "Backend",
      metadata: {
        name: "genio-one-aigw-internal",
        namespace: input.namespace,
        labels: { "genio.one/shared-component": "genio-one-aigw-internal" },
      },
      spec: {
        endpoints: [{ ip: { address: "127.0.0.1", port: input.listenerPort + 1 } }],
      },
    }] : []),
  ]
}

function projectionDocuments(
  input: Parameters<GatewayReleaseApplier["apply"]>[0],
  listenerPort: number,
  activityLogPath?: string,
  localCredentialValues: Readonly<Record<string, string>> = {},
  telemetry?: { port: number; httpPort: number },
): string {
  const { command, release } = input
  const projectionResources = release.projections.flatMap(({ projection }) =>
    projection.operation === "APPLY" ? projection.resources : [],
  )
  const standaloneApiRouteNames = new Map<string, string>()
  for (const { projection } of release.projections) {
    if (
      projection.operation !== "APPLY" ||
      projection.resources.some((resource: any) =>
        resource.kind === "AIGatewayRoute" || resource.kind === "MCPRoute"
      )
    ) continue
    for (const resource of projection.resources as Array<Record<string, any>>) {
      if (resource.kind !== "HTTPRoute" || typeof resource.metadata?.name !== "string") continue
      standaloneApiRouteNames.set(
        resource.metadata.name,
        standaloneApiRouteName(resource.metadata.name),
      )
    }
  }
  const normalizedResources = withGatewayDetailCapture(
    projectionResources,
    release.gateway_configuration.capture_message_content,
    command.desired_release.gateway_id,
  ).map((resource) => {
    const local = structuredClone(resource) as Record<string, any>
    const standaloneName = standaloneApiRouteNames.get(local.metadata?.name)
    if (local.kind === "HTTPRoute" && standaloneName) local.metadata.name = standaloneName
    const targetRefs = Array.isArray(local.spec?.targetRefs)
      ? local.spec.targetRefs
      : local.spec?.targetRef
        ? [local.spec.targetRef]
        : []
    for (const targetRef of targetRefs) {
      if (targetRef?.kind !== "HTTPRoute") continue
      const replacement = standaloneApiRouteNames.get(targetRef.name)
      if (replacement) targetRef.name = replacement
    }
    if (local.kind === "EnvoyExtensionPolicy" && Array.isArray(local.spec?.lua)) {
      const namespace = local.metadata?.namespace ?? "default"
      for (const lua of local.spec.lua) {
        if (typeof lua?.inline !== "string") continue
        for (const [original, replacement] of standaloneApiRouteNames) {
          lua.inline = lua.inline.replaceAll(
            `httproute/${namespace}/${original}/`,
            `httproute/${namespace}/${replacement}/`,
          )
        }
      }
    }
    if (local.kind === "Backend" && local.metadata?.name === "genio-one-authorizer") {
      local.spec.endpoints = [{ ip: { port: 8081, address: "127.0.0.1" } }]
    }
    if (local.kind === "Backend" && local.metadata?.name === "genio-one-processor") {
      local.spec.endpoints = [{ ip: { port: 8082, address: "127.0.0.1" } }]
    }
    if (local.kind === "Backend" && local.metadata?.name === "genio-one-detail-capture") {
      local.spec.endpoints = [{ ip: { port: 8083, address: "127.0.0.1" } }]
    }
    if (local.kind === "Backend" && local.metadata?.name === "genio-one-processor-http") {
      local.spec.endpoints = [{ ip: { port: 8182, address: "127.0.0.1" } }]
    }
    if (local.kind === "Backend" && local.metadata?.name === "genio-one-otel-collector") {
      const port = telemetry?.port ?? 4317
      local.spec.endpoints = [{ ip: { port, address: "127.0.0.1" } }]
    }
    if (!telemetry && local.kind === "EnvoyProxy") {
      const settings = local.spec?.telemetry?.accessLog?.settings
      if (Array.isArray(settings)) {
        const withoutOtlp = settings
          .map((setting: any) => ({
            ...setting,
            sinks: Array.isArray(setting.sinks)
              ? setting.sinks.filter((sink: any) => sink?.type !== "OpenTelemetry")
              : [],
          }))
          .filter((setting: any) => setting.sinks.length > 0)
        if (withoutOtlp.length > 0) {
          local.spec.telemetry.accessLog.settings = withoutOtlp
        } else if (local.spec.telemetry.accessLog) {
          delete local.spec.telemetry.accessLog
        }
      }
      if (local.spec?.telemetry?.metrics) delete local.spec.telemetry.metrics
      if (local.spec?.telemetry?.tracing) delete local.spec.telemetry.tracing
      if (local.spec?.telemetry && Object.keys(local.spec.telemetry).length === 0) {
        delete local.spec.telemetry
      }
    }
    if (telemetry && local.kind === "EnvoyProxy") {
      const backendRefs = [
        ...local.spec?.telemetry?.metrics?.sinks?.flatMap((sink: any) =>
          sink?.openTelemetry?.backendRefs ?? []
        ) ?? [],
        ...local.spec?.telemetry?.tracing?.provider?.backendRefs ?? [],
        ...local.spec?.telemetry?.accessLog?.settings?.flatMap((setting: any) =>
          setting?.sinks?.flatMap((sink: any) => sink?.openTelemetry?.backendRefs ?? []) ?? []
        ) ?? [],
      ]
      for (const reference of backendRefs) {
        if (reference?.name === "genio-one-otel-collector") reference.port = telemetry.port
      }
    }
    if (local.kind === "GatewayConfig" && local.metadata?.name === `${command.desired_release.gateway_id}-config`) {
      local.spec ??= {}
      local.spec.extProc ??= {}
      local.spec.extProc.kubernetes ??= {}
      local.spec.extProc.kubernetes.env = [
        { name: "AI_GATEWAY_TRACING_SEMCONV", value: "gen_ai" },
        { name: "OTEL_RESOURCE_ATTRIBUTES", value: `genio.tenant.id=${command.tenant_id}` },
        {
          name: "OTEL_AIGW_SPAN_REQUEST_HEADER_ATTRIBUTES",
          value: "x-request-id:genio.correlation.id,x-genio-correlation-id:genio.correlation.id,x-genio-trusted-tenant-id:genio.tenant.id",
        },
        { name: "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", value: "false" },
        ...(telemetry ? [
          { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: `http://127.0.0.1:${telemetry.httpPort}` },
          { name: "OTEL_TRACES_EXPORTER", value: "otlp" },
          { name: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", value: `http://127.0.0.1:${telemetry.httpPort}/v1/traces` },
          { name: "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", value: "http/protobuf" },
          { name: "OTEL_EXPORTER_OTLP_PROTOCOL", value: "http/protobuf" },
        ] : []),
      ]
    }
    if (local.kind === "EnvoyProxy" && local.metadata?.name === command.desired_release.gateway_id) {
      // Normalize older immutable projections before composing the one shared
      // Gateway resource. Publication-specific differences must not decide
      // process-wide filter order.
      local.spec ??= {}
      local.spec.filterOrder = [
        {
          name: "envoy.filters.http.ext_authz",
          after: "envoy.filters.http.jwt_authn",
        },
        {
          name: "envoy.filters.http.lua",
          after: "envoy.filters.http.ext_authz",
        },
        {
          name: "envoy.filters.http.ext_proc",
          after: "envoy.filters.http.lua",
        },
      ]
    }
    if (local.kind === "ClientTrafficPolicy" && local.metadata?.name === `${command.desired_release.gateway_id}-correlation`) {
      local.spec ??= {}
      local.spec.connection = { ...(local.spec.connection ?? {}), bufferLimit: "50Mi" }
      local.spec.http2 = {
        ...(local.spec.http2 ?? {}),
        initialStreamWindowSize: 16 * 1024 * 1024,
        initialConnectionWindowSize: 24 * 1024 * 1024,
      }
    }
    const extAuth = local.kind === "SecurityPolicy"
      ? local.spec?.extAuth
      : local.kind === "MCPRoute"
        ? local.spec?.securityPolicy?.extAuth
        : undefined
    if (extAuth) {
      extAuth.bodyToExtAuth = { maxRequestBytes: 4_194_304 }
      if (Array.isArray(extAuth.headersToExtAuth)) {
        extAuth.headersToExtAuth = extAuth.headersToExtAuth
          .filter((header: unknown) => header !== "x-ai-eg-model")
      }
    }
    if (local.kind === "EnvoyExtensionPolicy" && Array.isArray(local.spec?.extProc)) {
      for (const extProc of local.spec.extProc) {
        // A short-lived development projection encoded the ExtProcMetadata
        // fields directly on ExtProc.  Normalize that already-signed local
        // fixture to the canonical Envoy Gateway shape; newly compiled
        // projections use metadata.writableNamespaces directly.
        if (Array.isArray(extProc.writableNamespaces) && extProc.metadata === undefined) {
          extProc.metadata = { writableNamespaces: extProc.writableNamespaces }
          delete extProc.writableNamespaces
        }
      }
    }
    if (local.kind === "MCPRoute" && Array.isArray(local.spec?.backendRefs)) {
      for (const backendRef of local.spec.backendRefs) {
        const path = absoluteMcpBackendPath(backendRef?.path)
        if (path) backendRef.path = path
      }
    }
    if (local.kind === "HTTPRoute" && Array.isArray(local.spec?.rules)) {
      for (const rule of local.spec.rules) {
        if (!Array.isArray(rule?.backendRefs)) continue
        for (const backendRef of rule.backendRefs) {
          if (backendRef?.name !== "genio-one-aigw-internal") continue
          // The standalone file provider has no Kubernetes Service endpoints.
          // Route the projected outer listener to the local internal listener
          // through the same Gateway API Backend shape used by the old local
          // fixture; the Kubernetes renderer keeps the Service reference.
          backendRef.group = "gateway.envoyproxy.io"
          backendRef.kind = "Backend"
          backendRef.port = listenerPort + 1
        }
      }
    }
    return local
  })
  const resources = mergeGatewayNativeResources(normalizedResources).filter((resource) => {
    // `aigw run` is a standalone file-provider process, not the Kubernetes
    // Envoy Gateway controller. GatewayConfig is a controller CRD and is not
    // registered in the standalone CLI scheme; its local-only environment
    // settings are applied below through the child process environment.
    return resource.kind !== "GatewayConfig"
  })
  attachMcpRouteSecurityPolicies(resources)
  for (const resource of resources) {
    const providers = resource.kind === "SecurityPolicy"
      ? resource.spec?.jwt?.providers
      : undefined
    if (Array.isArray(providers)) {
      for (const provider of providers) {
        if (typeof provider?.issuer === "string") {
          provider.issuer = provider.issuer.replace(
            "http://host.docker.internal:",
            "http://127.0.0.1:",
          )
        }
        const uri = provider?.remoteJWKS?.uri
        if (typeof uri === "string") {
          provider.remoteJWKS.uri = uri.replace(
            "http://host.docker.internal:",
            "http://127.0.0.1:",
          )
        }
      }
    }
    const oauth = resource.kind === "MCPRoute"
      ? resource.spec?.securityPolicy?.oauth
      : undefined
    if (oauth) {
      if (typeof oauth.issuer === "string") {
        oauth.issuer = oauth.issuer.replace(
          "http://host.docker.internal:",
          "http://127.0.0.1:",
        )
      }
      const uri = oauth.jwks?.remoteJWKS?.uri
      if (typeof uri === "string") {
        oauth.jwks.remoteJWKS.uri = uri.replace(
          "http://host.docker.internal:",
          "http://127.0.0.1:",
        )
      }
    }
  }
  const namespace = resources.find((resource) =>
    typeof resource === "object" && resource !== null &&
    "metadata" in resource && typeof resource.metadata === "object" &&
    resource.metadata !== null && "namespace" in resource.metadata &&
    typeof resource.metadata.namespace === "string"
  )
  const namespaceName = namespace && typeof namespace === "object" && "metadata" in namespace &&
      typeof namespace.metadata === "object" && namespace.metadata !== null &&
      "namespace" in namespace.metadata && typeof namespace.metadata.namespace === "string"
    ? namespace.metadata.namespace
    : "default"
  const projectedEnvoyProxy = [...resources].reverse().find((resource: Record<string, any>) =>
    resource.kind === "EnvoyProxy" && resource.metadata?.name === command.desired_release.gateway_id
  )
  if (projectedEnvoyProxy?.spec) {
    // Older local releases may predate the canonical JWT → ext_authz order.
    projectedEnvoyProxy.spec.filterOrder = [
      {
        name: "envoy.filters.http.ext_authz",
        after: "envoy.filters.http.jwt_authn",
      },
      {
        name: "envoy.filters.http.lua",
        after: "envoy.filters.http.ext_authz",
      },
      {
        name: "envoy.filters.http.ext_proc",
        after: "envoy.filters.http.lua",
      },
    ]
  }
  if (projectedEnvoyProxy && activityLogPath) {
    const settings = projectedEnvoyProxy.spec?.telemetry?.accessLog?.settings
    if (Array.isArray(settings)) {
      for (const setting of settings) {
        if (!Array.isArray(setting?.sinks)) continue
        for (const sink of setting.sinks) {
          if (sink?.type === "File" && sink.file) sink.file.path = activityLogPath
        }
        const json = setting?.format?.json
        if (json && typeof json === "object") {
          json["mcp.method.name"] = "%DYNAMIC_METADATA(io.envoy.ai_gateway:mcp_method)%"
          json["mcp.tool.name"] = "%DYNAMIC_METADATA(io.envoy.ai_gateway:mcp_tool_name)%"
          json["mcp.provider.name"] = "%DYNAMIC_METADATA(io.envoy.ai_gateway:mcp_backend)%"
          json["mcp.session.id"] = "%DYNAMIC_METADATA(io.envoy.ai_gateway:mcp_session_id)%"
          json["genio.processor.bundle_revision"] = "%DYNAMIC_METADATA(genio.one.processor:bundle_revision)%"
          json["genio.processor.request_steps"] = "%DYNAMIC_METADATA(genio.one.processor:request_steps)%"
          json["genio.processor.response_steps"] = "%DYNAMIC_METADATA(genio.one.processor:response_steps)%"
          json["genio.processor.data_classifications"] = "%DYNAMIC_METADATA(genio.one.processor:data_classifications)%"
        }
      }
    }
  }
  const resourcesWithoutInfrastructureProxy = resources.filter((resource) => !(
    resource.kind === "EnvoyProxy" &&
    resource.metadata?.name === command.desired_release.gateway_id
  ))
  const aiGatewayEnabled = resources.some((resource) =>
    resource.kind === "AIGatewayRoute" || resource.kind === "MCPRoute"
  )
  const localSecrets = localCredentialSecrets(resources, localCredentialValues, namespaceName)
  return [
    ...localGatewayInfrastructure({
      gatewayId: command.desired_release.gateway_id,
      namespace: namespaceName,
      listenerPort,
      aiGatewayEnabled,
      envoyProxySpec: projectedEnvoyProxy?.spec,
    }),
    ...localSecrets,
    ...resourcesWithoutInfrastructureProxy,
  ].map((resource) => stringify(resource)).join("---\n")
}

/** Local development adapter. Production remains a Kubernetes apply adapter. */
export function createLocalAigwApplier(options: LocalAigwOptions): GatewayReleaseApplier & {
  close(): Promise<void>
} {
  const adminPort = positivePort(options.adminPort, "adminPort")
  const listenerPort = positivePort(options.listenerPort ?? 1975, "listenerPort")
  let active: ChildProcess | undefined
  let authorizer: ChildProcess | undefined
  let processor: ChildProcess | undefined
  let aigwDownloadAbort: AbortController | undefined
  let aigwPreparation: Promise<Awaited<ReturnType<typeof prepareAigwRuntimeCache>>> | undefined
  let activeRuntimeDirectory: AigwEphemeralRuntimeDirectory | undefined
  let activeCleanup: Promise<void> | undefined
  let processorStdout = ""
  const routeLeaseByCorrelation = new Map<string, ModelRouteLeaseObservation>()
  const processorReceiptByCorrelation = new Map<string, {
    bundle_revision: string
    request_steps: Array<{ step_id: string; action: string }>
    response_steps: Array<{ step_id: string; action: string }>
    data_classifications: DataClassificationReceipt[]
  }>()
  let stopActivityReader: (() => void) | undefined

  async function stopActiveProcessTree(): Promise<void> {
    if (activeCleanup) {
      await activeCleanup
      return
    }
    const child = active
    if (!child) return
    const cleanup = stopProcessTree(child)
    activeCleanup = cleanup
    try {
      await cleanup
    } finally {
      if (activeCleanup === cleanup) activeCleanup = undefined
    }
  }

  function activityForRelease(
    release: Parameters<GatewayReleaseApplier["apply"]>[0]["release"],
    value: unknown,
  ): GatewayActivityIngest | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const raw = value as Record<string, unknown>
    const model = typeof raw["gen_ai.request.model"] === "string"
      ? raw["gen_ai.request.model"]
      : ""
    const routeName = typeof raw.route_name === "string" ? raw.route_name : ""
    const projection = release.projections.find(({ projection }) => {
      const nativeNames = projection.resources
        .filter((resource: any) =>
          typeof resource.metadata?.name === "string" &&
          (resource.kind === "HTTPRoute" || resource.kind === "AIGatewayRoute" ||
            resource.kind === "MCPRoute" || resource.kind === "Backend")
        )
        .flatMap((resource: any) => resource.kind === "HTTPRoute"
          ? [resource.metadata.name as string, standaloneApiRouteName(resource.metadata.name)]
          : [resource.metadata.name as string])
      return projection.resources.some((resource: any) =>
        (resource.kind === "AIGatewayRoute" && resource.spec?.rules?.some((rule: any) =>
          rule.matches?.some((match: any) => match.headers?.some((header: any) =>
            String(header.name).toLowerCase() === "x-ai-eg-model" && header.value === model
          ))
        )) ||
        ((resource.kind === "HTTPRoute" || resource.kind === "AIGatewayRoute" || resource.kind === "MCPRoute") &&
          typeof resource.metadata?.name === "string" &&
          routeName.includes(`/${resource.metadata.name}/`))
      ) || nativeNames.some((name) => routeName.includes(name))
    })?.projection
    const correlationId = typeof raw["x-request-id"] === "string" ? raw["x-request-id"] : ""
    const status = Number(raw.response_code)
    const path = typeof raw.path === "string" ? raw.path : ""
    const method = typeof raw.method === "string" ? raw.method : ""
    if (!projection || !correlationId || !path || !method || !Number.isInteger(status)) return null
    const projectionResources = projection.resources as Array<Record<string, any>>
    const routeLease = routeLeaseByCorrelation.get(correlationId) ?? null
    routeLeaseByCorrelation.delete(correlationId)
    const processorReceipt = processorReceiptByCorrelation.get(correlationId) ?? null
    processorReceiptByCorrelation.delete(correlationId)
    const stringOrNull = (field: string) => {
      const fieldValue = raw[field]
      return typeof fieldValue === "string" && fieldValue !== "" && fieldValue !== "-"
        ? fieldValue
        : null
    }
    const integerOrNull = (field: string) => {
      const fieldValue = raw[field]
      if (
        (typeof fieldValue !== "string" || fieldValue === "" || fieldValue === "-") &&
        typeof fieldValue !== "number"
      ) {
        return null
      }
      const normalized = Number(fieldValue)
      return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : null
    }
    const processorSteps = (field: string) => {
      const fieldValue = raw[field]
      if (fieldValue === null || fieldValue === undefined || fieldValue === "" || fieldValue === "-") {
        return []
      }
      let decoded: unknown = fieldValue
      if (typeof fieldValue === "string") {
        try {
          decoded = JSON.parse(fieldValue)
        } catch {
          return []
        }
      }
      if (!Array.isArray(decoded) || decoded.length > 4_096) return []
      const steps: Array<{ step_id: string; action: string }> = []
      for (const value of decoded) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return []
        const stepId = (value as Record<string, unknown>).step_id
        const action = (value as Record<string, unknown>).action
        if (
          typeof stepId !== "string" || !stepId || stepId.length > 256 ||
          typeof action !== "string" || !action || action.length > 256
        ) return []
        steps.push({ step_id: stepId, action })
      }
      return steps
    }
    const dataClassifications = (field: string): DataClassificationReceipt[] => {
      const fieldValue = raw[field]
      if (fieldValue === null || fieldValue === undefined || fieldValue === "" || fieldValue === "-") {
        return []
      }
      let decoded: unknown = fieldValue
      if (typeof fieldValue === "string") {
        try {
          decoded = JSON.parse(fieldValue)
        } catch {
          return []
        }
      }
      if (!Array.isArray(decoded) || decoded.length > 4_096) return []
      return decoded.every((value) => Check(DataClassificationReceiptSchema, value))
        ? decoded as DataClassificationReceipt[]
        : []
    }
    const duration = Number(raw.duration)
    const occurredAt = Date.parse(String(raw.start_time ?? ""))
    const occurredAtSeconds = Number.isFinite(occurredAt)
      ? Math.floor(occurredAt / 1_000)
      : Math.floor(Date.now() / 1_000)
    const responseCodeDetails = stringOrNull("response_code_details")
    const dataProtectionBlocked = status === 403 && responseCodeDetails === "lua_response"
    const backendName = stringOrNull("gen_ai.provider.name")
    const mcpBackendName = stringOrNull("mcp.provider.name")
    const backend = projectionResources.find((resource) => {
      if (resource.kind !== "AIServiceBackend" || typeof resource.metadata?.name !== "string") {
        return false
      }
      if (backendName) {
        return backendName === resource.metadata.name ||
          backendName.split("/").includes(resource.metadata.name)
      }
      return routeLease !== null &&
        resource.metadata?.annotations?.["genio.one/connection-id"] === routeLease.connection_id
    })
    const annotations = backend?.metadata?.annotations
    const mcpBackend = mcpBackendName
      ? projectionResources.find((resource) =>
          resource.kind === "Backend" && resource.metadata?.name === mcpBackendName
        )
      : null
    const mcpAnnotations = mcpBackend?.metadata?.annotations
    const mcpConnectionId = typeof mcpAnnotations?.["genio.one/connection-id"] === "string"
      ? mcpAnnotations["genio.one/connection-id"]
      : mcpBackendName?.match(/(connection-[a-f0-9-]+)-backend$/)?.[1] ?? null
    const matchedHttpRoute = projectionResources.find((resource) =>
      resource.kind === "HTTPRoute" &&
      typeof resource.metadata?.name === "string" &&
      (
        routeName.includes(`/${resource.metadata.name}/`) ||
        routeName.includes(`/${standaloneApiRouteName(resource.metadata.name)}/`)
      )
    )
    const genericBackendName = matchedHttpRoute?.spec?.rules
      ?.flatMap((rule: any) => rule.backendRefs ?? [])
      .map((reference: any) => reference.name)
      .find((name: unknown) => typeof name === "string")
    const genericBackend = typeof genericBackendName === "string"
      ? projectionResources.find((resource) =>
          resource.kind === "Backend" && resource.metadata?.name === genericBackendName
        )
      : null
    const genericAnnotations = genericBackend?.metadata?.annotations
    const apiProjection = projectionResources.some((resource) => resource.kind === "HTTPRoute") &&
      !projectionResources.some((resource) =>
        resource.kind === "AIGatewayRoute" || resource.kind === "MCPRoute"
      )
    const route = projectionResources.find((resource) =>
      resource.kind === "AIGatewayRoute" &&
      typeof resource.metadata?.name === "string" &&
      routeName.includes(`/${resource.metadata.name}/`)
    )
    const projectedPublicModels = route?.spec?.rules
      ?.flatMap((rule: any) => rule.matches ?? [])
      .flatMap((match: any) => match.headers ?? [])
      .filter((header: any) =>
        String(header.name).toLowerCase() === "x-ai-eg-model" &&
        typeof header.value === "string" &&
        header.value
      )
      .map((header: any) => header.value as string) ?? []
    const uniqueProjectedPublicModels = [...new Set<string>(projectedPublicModels)]
    const outcome = status === 401
      ? "UNAUTHENTICATED"
      : status === 403
        ? "DENIED"
        : status === 429
          ? "RATE_LIMITED"
          : status >= 400
            ? "FAILED"
            : "COMPLETED"
    const loggedRequestSteps = processorSteps("genio.processor.request_steps")
    const loggedResponseSteps = processorSteps("genio.processor.response_steps")
    const loggedDataClassifications = dataClassifications("genio.processor.data_classifications")
    const credentialProfileId = typeof annotations?.["genio.one/provider-credential-profile-id"] === "string"
      ? annotations["genio.one/provider-credential-profile-id"]
      : null
    const credentialProfileRevision = Number(annotations?.["genio.one/provider-credential-profile-revision"])
    const credentialStrategyDigest = typeof annotations?.["genio.one/provider-credential-strategy-digest"] === "string"
      ? annotations["genio.one/provider-credential-strategy-digest"]
      : null
    return {
      correlation_id: correlationId,
      resource_id: projection.resource_id,
      capability_id: projection.capability_id,
      application_id: stringOrNull("genio.client.id"),
      subject_id: stringOrNull("genio.subject.id"),
      acting_client_id: stringOrNull("genio.client.id"),
      entitlement_id: null,
      usage_admission_id: null,
      usage_admission_disposition: "NOT_APPLICABLE",
      usage_admission_reason: null,
      consumer_organization_id: null,
      resource_owner_organization_id: null,
      use_case_id: null,
      enforcement_point_id: apiProjection ? "API_GATEWAY" : "AI_GATEWAY",
      route: "MANAGED",
      method,
      path,
      status_code: status,
      outcome,
      error_code: status >= 400
        ? dataProtectionBlocked ? "DATA_PROTECTION_BLOCKED" : responseCodeDetails
        : null,
      latency_millis: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null,
      upstream_attempted: activityUpstreamAttempted(raw),
      requested_model_id: stringOrNull("gen_ai.request.model") ??
        (uniqueProjectedPublicModels.length === 1 ? uniqueProjectedPublicModels[0]! : null),
      effective_model_id: stringOrNull("gen_ai.response.model"),
      provider_id: typeof annotations?.["genio.one/provider-id"] === "string"
        ? annotations["genio.one/provider-id"]
        : null,
      connection_id: typeof annotations?.["genio.one/connection-id"] === "string"
        ? annotations["genio.one/connection-id"]
        : routeLease?.connection_id ?? mcpConnectionId ??
          (typeof genericAnnotations?.["genio.one/connection-id"] === "string"
            ? genericAnnotations["genio.one/connection-id"]
            : null),
      mcp_method: stringOrNull("mcp.method.name"),
      mcp_tool: stringOrNull("mcp.tool.name"),
      mcp_backend: mcpBackendName,
      processor_bundle_revision: stringOrNull("genio.processor.bundle_revision") ??
        processorReceipt?.bundle_revision ?? null,
      processor_request_steps: loggedRequestSteps.length > 0
        ? loggedRequestSteps
        : processorReceipt?.request_steps ?? [],
      processor_response_steps: loggedResponseSteps.length > 0
        ? loggedResponseSteps
        : processorReceipt?.response_steps ?? [],
      data_classifications: loggedDataClassifications.length > 0
        ? loggedDataClassifications
        : processorReceipt?.data_classifications ?? [],
      input_tokens: integerOrNull("gen_ai.usage.input_tokens"),
      output_tokens: integerOrNull("gen_ai.usage.output_tokens"),
      total_tokens: integerOrNull("gen_ai.usage.total_tokens"),
      route_mode: routeLease ? "SESSION_LEASE" : null,
      route_lease_id: routeLease?.lease_id ?? null,
      route_lease_reused: routeLease?.reused ?? null,
      provider_credential_profile_id: credentialProfileId,
      provider_credential_profile_revision: Number.isSafeInteger(credentialProfileRevision) && credentialProfileRevision > 0
        ? credentialProfileRevision
        : null,
      provider_credential_strategy_digest: credentialStrategyDigest,
      routing_policy_id: routeLease?.routing_policy_id ?? null,
      routing_revision: routeLease?.routing_revision ?? null,
      candidate_set_digest: routeLease?.candidate_set_digest ?? null,
      candidate_connection_ids: [],
      release_id: release.release_id,
      release_head_revision: release.head_revision,
      ...gatewayDetailActivityReference(
        release.gateway_configuration.capture_message_content,
        correlationId,
        occurredAtSeconds,
      ),
      occurred_at: occurredAtSeconds,
    }
  }

  function startActivityReader(
    path: string,
    release: Parameters<GatewayReleaseApplier["apply"]>[0]["release"],
  ): void {
    stopActivityReader?.()
    if (!options.onActivity) {
      writeOperationalEvent("gateway-runtime", "WARN", "genio.one.gateway-runtime.activity-delivery-disabled", {
        release_id: release.release_id,
      })
      return
    }
    writeOperationalEvent("gateway-runtime", "INFO", "genio.one.gateway-runtime.activity-reader-started", {
      release_id: release.release_id,
      activity_path: path,
    })
    let consumed = 0
    let queue = Promise.resolve()
    const timer = setInterval(() => {
      queue = queue.then(async () => {
        let content: string
        try {
          content = await readFile(path, "utf8")
        } catch {
          return
        }
        const lastNewline = content.lastIndexOf("\n")
        const completeContent = lastNewline >= 0 ? content.slice(0, lastNewline) : ""
        const lines = completeContent ? completeContent.split("\n") : []
        for (const line of lines.slice(consumed)) {
          consumed += 1
          if (!line.trim()) continue
          try {
            const event = activityForRelease(release, JSON.parse(line))
            if (event) {
              await options.onActivity!(event)
              writeOperationalEvent("gateway-runtime", "INFO", "genio.one.gateway-runtime.activity-delivered", {
                release_id: release.release_id,
                correlation_id: event.correlation_id,
              })
            } else {
              writeOperationalEvent("gateway-runtime", "WARN", "genio.one.gateway-runtime.activity-ignored", {
                release_id: release.release_id,
                reason: "UNRECOGNIZED_NATIVE_EVENT",
              })
            }
          } catch (error) {
            writeOperationalEvent("gateway-runtime", "ERROR", "genio.one.gateway-runtime.activity-delivery-failed", {
              release_id: release.release_id,
              ...operationalError(error),
            })
          }
        }
      })
    }, 100)
    stopActivityReader = () => clearInterval(timer)
  }

  async function materializePolicyRelease(
    input: Parameters<GatewayReleaseApplier["apply"]>[0],
  ): Promise<string> {
    const policyRoot = join(options.stateRoot, "policy")
    const releasesRoot = join(policyRoot, "releases")
    const releasePath = join(releasesRoot, input.release.release_id)
    await mkdir(releasePath, { recursive: true })
    await Promise.all([
      writeFile(join(releasePath, POLICY_RELEASE_FILES.manifest), input.release.manifest_jws),
      writeFile(join(releasePath, POLICY_RELEASE_FILES.authorizationBundle), input.release.authorization_bundle_jws),
      writeFile(join(releasePath, POLICY_RELEASE_FILES.processorPolicyBundle), input.release.processor_policy_jws),
      writeFile(join(releasePath, POLICY_RELEASE_FILES.gatewayRoutingArtifact), input.release.gateway_routing_artifact_jws),
      writeFile(join(releasePath, POLICY_RELEASE_FILES.verificationKeyRing), input.release.enforcement_verification_keys_json),
      writeFile(join(releasePath, POLICY_RELEASE_FILES.runtimeCommand), JSON.stringify(input.command)),
    ])
    return policyRoot
  }

  async function ensureAuthorizer(
    input: Parameters<GatewayReleaseApplier["apply"]>[0],
    policyRoot: string,
  ): Promise<void> {
    if (authorizer && authorizer.exitCode === null) return
    authorizer = spawn(
      process.execPath,
      [gatewayServiceEntrypoint("authorizer")],
      {
        env: {
          ...process.env,
          ...options.environment,
          GENIO_ONE_POLICY_ROOT: policyRoot,
          GENIO_ONE_POLICY_RELEASE_ROOT_KEYRING: options.releaseRootKeyRingPath,
          GENIO_ONE_RUNTIME_COMMAND_KEYRING: options.runtimeCommandKeyRingPath,
          GENIO_ONE_AUTHORITY_FLOOR_FILE: join(options.stateRoot, "authority-floor.json"),
          GENIO_ONE_TENANT_ID: input.command.tenant_id,
          GENIO_ONE_RUNTIME_ID: input.command.runtime_id,
          GENIO_ONE_GATEWAY_ID: input.command.desired_release.gateway_id,
          GENIO_ONE_AUTHORIZER_LISTEN: "127.0.0.1:8081",
          GENIO_ONE_AUTHORIZER_READINESS_LISTEN: "127.0.0.1:9081",
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    )
    await waitForListener(8081, authorizer, options.readinessTimeoutMs ?? 120_000)
  }

  async function ensureProcessor(
    input: Parameters<GatewayReleaseApplier["apply"]>[0],
    policyRoot: string,
  ): Promise<void> {
    if (processor && processor.exitCode === null) return
    processor = spawn(
      process.execPath,
      [gatewayServiceEntrypoint("processor")],
      {
        env: {
          ...process.env,
          ...options.environment,
          GENIO_ONE_POLICY_ROOT: policyRoot,
          GENIO_ONE_POLICY_RELEASE_ROOT_KEYRING: options.releaseRootKeyRingPath,
          GENIO_ONE_RUNTIME_COMMAND_KEYRING: options.runtimeCommandKeyRingPath,
          GENIO_ONE_TENANT_ID: input.command.tenant_id,
          GENIO_ONE_RUNTIME_ID: input.command.runtime_id,
          GENIO_ONE_GATEWAY_ID: input.command.desired_release.gateway_id,
          GENIO_ONE_AI_PROCESSOR_LISTEN: "127.0.0.1:8082",
          GENIO_ONE_AI_PROCESSOR_READINESS_LISTEN: "127.0.0.1:9082",
          GENIO_ONE_AI_PROCESSOR_HTTP_LISTEN: "127.0.0.1:8182",
          GENIO_ONE_DETAIL_CAPTURE_LISTEN: "127.0.0.1:8083",
          ...(options.telemetry
            ? {
                OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
                  `http://127.0.0.1:${options.telemetry.httpPort}/v1/traces`,
              }
            : {}),
        },
        stdio: ["ignore", "pipe", "inherit"],
      },
    )
    processor.stdout?.on("data", (chunk) => {
      processorStdout += chunk.toString("utf8")
      const lines = processorStdout.split("\n")
      processorStdout = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        let observed: Partial<ModelRouteLeaseObservation> | Partial<ProcessorHttpObservation>
        try {
          observed = JSON.parse(line) as Partial<ModelRouteLeaseObservation> | Partial<ProcessorHttpObservation>
        } catch {
          process.stdout.write(`${line}\n`)
          continue
        }
        const processorObserved = observed as Partial<ProcessorHttpObservation>
        if (
          (processorObserved.event === "genio.one.processor-http-request-completed" ||
            processorObserved.event === "genio.one.processor-http-response-completed") &&
          typeof processorObserved.correlation_id === "string" &&
          typeof processorObserved.bundle_revision === "string" &&
          Array.isArray(processorObserved.steps) &&
          processorObserved.steps.every((step) =>
            step && typeof step === "object" &&
            typeof step.step_id === "string" && step.step_id.length > 0 &&
            typeof step.action === "string" && step.action.length > 0
          ) &&
          Array.isArray(processorObserved.data_classifications) &&
          processorObserved.data_classifications.every((value) =>
            Check(DataClassificationReceiptSchema, value)
          )
        ) {
          const receipt = processorObserved as ProcessorHttpObservation
          const current = processorReceiptByCorrelation.get(receipt.correlation_id) ?? {
            bundle_revision: receipt.bundle_revision,
            request_steps: [],
            response_steps: [],
            data_classifications: [],
          }
          processorReceiptByCorrelation.set(receipt.correlation_id, {
            bundle_revision: receipt.bundle_revision,
            request_steps: receipt.event === "genio.one.processor-http-request-completed"
              ? receipt.steps
              : current.request_steps,
            response_steps: receipt.event === "genio.one.processor-http-response-completed"
              ? receipt.steps
              : current.response_steps,
            data_classifications: receipt.data_classifications.length > 0
              ? receipt.data_classifications
              : current.data_classifications,
          })
          process.stdout.write(`${line}\n`)
          continue
        }
        if (
          observed.event !== "genio.one.model-route-lease" ||
          typeof observed.correlation_id !== "string" ||
          typeof observed.lease_id !== "string" ||
          typeof observed.routing_policy_id !== "string" ||
          !Number.isSafeInteger(observed.routing_revision) ||
          typeof observed.candidate_set_digest !== "string" ||
          typeof observed.selected_public_model_id !== "string" ||
          typeof observed.selected_public_model !== "string" ||
          typeof observed.connection_id !== "string" ||
          typeof observed.provider_model !== "string" ||
          typeof observed.reused !== "boolean"
        ) {
          process.stdout.write(`${line}\n`)
          continue
        }
        routeLeaseByCorrelation.set(
          observed.correlation_id,
          observed as ModelRouteLeaseObservation,
        )
        process.stdout.write(`${line}\n`)
      }
    })
    await waitForListener(8082, processor, options.readinessTimeoutMs ?? 120_000)
    await waitForListener(8083, processor, options.readinessTimeoutMs ?? 120_000)
  }

  return {
    async apply({ command, release }) {
      routeLeaseByCorrelation.clear()
      processorReceiptByCorrelation.clear()

      if (release.projections.length === 0) {
        await stopActiveProcessTree()
        active = undefined
        writeOperationalEvent("gateway-runtime", "INFO", "genio.one.gateway-runtime.release-applied", {
          release_id: release.release_id,
          head_revision: release.head_revision,
          active_routes: 0,
        })
        return [
          {
            component: "AI_GATEWAY",
            state: "READY",
            observed_revision: String(release.head_revision),
            payload: { active_routes: 0 },
          } satisfies GatewayComponentObservation,
        ]
      }

      const policyRoot = await materializePolicyRelease({ command, release })
      if (options.shutdownSignal?.aborted) throw new Error("AIGW preparation aborted by controller shutdown")
      aigwDownloadAbort = new AbortController()
      const abortForShutdown = () => aigwDownloadAbort?.abort()
      options.shutdownSignal?.addEventListener("abort", abortForShutdown, { once: true })
      if (options.shutdownSignal?.aborted) abortForShutdown()
      const preparation = prepareAigwRuntimeCache({
        binary: options.binary,
        stateRoot: options.stateRoot,
        environment: options.environment,
        timeoutMs: options.aigwDownloadTimeoutMs,
        signal: aigwDownloadAbort.signal,
      })
      aigwPreparation = preparation
      let aigwPaths: Awaited<ReturnType<typeof prepareAigwRuntimeCache>>
      try {
        aigwPaths = await preparation
        if (options.shutdownSignal?.aborted) throw new Error("AIGW preparation aborted by controller shutdown")
      } finally {
        options.shutdownSignal?.removeEventListener("abort", abortForShutdown)
        if (aigwPreparation === preparation) {
          aigwPreparation = undefined
          aigwDownloadAbort = undefined
        }
      }
      await ensureAuthorizer({ command, release }, policyRoot)
      await ensureProcessor({ command, release }, policyRoot)

      const releaseRoot = join(options.stateRoot, release.release_id)
      await mkdir(releaseRoot, { recursive: true })
      const configPath = join(releaseRoot, "gateway.yaml")
      const activityLogPath = join(releaseRoot, "activity.jsonl")
      const gatewayConfiguration = projectionDocuments(
        { command, release },
        listenerPort,
        activityLogPath,
        options.localCredentialValues,
        options.telemetry,
      )
      await stopActiveProcessTree()
      await writeFile(join(policyRoot, "current"), `${release.release_id}\n`)
      await rm(activityLogPath, { force: true })
      await writeFile(configPath, gatewayConfiguration, {
        encoding: "utf8",
        mode: 0o600,
      })

      const runId = aigwEphemeralRunId(release.head_revision)
      const runtimeDirectory = await createAigwEphemeralRuntimeDirectory(options.stateRoot, runId)
      let runtimeDirectoryRemoved = false
      const removeRuntimeDirectory = async () => {
        if (runtimeDirectoryRemoved) return
        runtimeDirectoryRemoved = true
        try {
          await removeAigwEphemeralRuntimeDirectory(runtimeDirectory)
        } catch (error) {
          writeOperationalEvent("gateway-runtime", "WARN", "genio.one.gateway-runtime.aigw-runtime-directory-cleanup-failed", {
            ...operationalError(error),
          })
        }
      }
      const child = spawn(
        options.binary,
        aigwRunArguments(configPath, adminPort, runId),
        {
          detached: process.platform !== "win32",
          env: {
            ...aigwRuntimeEnvironment(options.environment, aigwPaths, runtimeDirectory.directory),
            AI_GATEWAY_TRACING_SEMCONV: "gen_ai",
            OTEL_RESOURCE_ATTRIBUTES: `genio.tenant.id=${command.tenant_id}`,
            OTEL_AIGW_SPAN_REQUEST_HEADER_ATTRIBUTES:
              "x-request-id:genio.correlation.id,x-genio-correlation-id:genio.correlation.id,x-genio-trusted-tenant-id:genio.tenant.id",
            OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: aigwSpanContentCapture(options.environment),
            ...(options.telemetry
              ? {
                  OTEL_EXPORTER_OTLP_ENDPOINT:
                    `http://127.0.0.1:${options.telemetry.httpPort}`,
                  OTEL_TRACES_EXPORTER: "otlp",
                  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
                    `http://127.0.0.1:${options.telemetry.httpPort}/v1/traces`,
                  OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
                  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
                }
              : {}),
          },
          stdio: "inherit",
        },
      )
      child.once("exit", () => {
        if (active === child) {
          active = undefined
          if (!activeCleanup) {
            const cleanup = stopProcessTree(child)
            activeCleanup = cleanup
            void cleanup.then(
              () => {
                if (activeCleanup === cleanup) activeCleanup = undefined
              },
              (error) => {
                writeOperationalEvent("gateway-runtime", "WARN", "genio.one.gateway-runtime.aigw-process-group-cleanup-failed", {
                  ...operationalError(error),
                })
                if (activeCleanup === cleanup) activeCleanup = undefined
              },
            )
          }
        }
        if (activeRuntimeDirectory === runtimeDirectory) activeRuntimeDirectory = undefined
        void removeRuntimeDirectory()
      })
      child.once("error", () => { void removeRuntimeDirectory() })
      try {
        writeOperationalEvent("gateway-runtime", "INFO", "genio.one.gateway-runtime.readiness-wait-started", {
          release_id: release.release_id,
          head_revision: release.head_revision,
        })
        await waitForHealth(
          `http://127.0.0.1:${adminPort}`,
          child,
          options.readinessTimeoutMs ?? 120_000,
        )
        await waitForEnvoyRunReadiness(
          runtimeDirectory.directory,
          runId,
          child,
          options.readinessTimeoutMs ?? 120_000,
        )
        startActivityReader(activityLogPath, release)
        writeOperationalEvent("gateway-runtime", "INFO", "genio.one.gateway-runtime.release-applied", {
          release_id: release.release_id,
          head_revision: release.head_revision,
          active_routes: release.projections.length,
        })
        await writeFile(join(policyRoot, "lkg"), `${release.release_id}\n`)
      } catch (error) {
        try {
          await stopProcessTree(child)
        } catch (cleanupError) {
          writeOperationalEvent("gateway-runtime", "WARN", "genio.one.gateway-runtime.aigw-process-group-cleanup-failed", {
            ...operationalError(cleanupError),
          })
        }
        await removeRuntimeDirectory()
        throw error
      }
      active = child
      activeRuntimeDirectory = runtimeDirectory
      return [
        {
          component: "AI_GATEWAY",
          state: "READY",
          observed_revision: String(release.head_revision),
          payload: {
            active_routes: release.projection_count,
          },
        } satisfies GatewayComponentObservation,
      ]
    },

    async close() {
      stopActivityReader?.()
      aigwDownloadAbort?.abort()
      await aigwPreparation?.catch(() => undefined)
      await stopActiveProcessTree()
      if (activeRuntimeDirectory) {
        await removeAigwEphemeralRuntimeDirectory(activeRuntimeDirectory).catch(() => undefined)
        activeRuntimeDirectory = undefined
      }
      if (authorizer && authorizer.exitCode === null) {
        authorizer.kill("SIGTERM")
        await new Promise<void>((resolve) => authorizer?.once("exit", () => resolve()))
      }
      if (processor && processor.exitCode === null) {
        processor.kill("SIGTERM")
        await new Promise<void>((resolve) => processor?.once("exit", () => resolve()))
      }
    },
  }
}
