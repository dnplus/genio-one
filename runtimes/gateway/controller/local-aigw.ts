import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { mergeGatewayNativeResources } from "./native-resources"
import { withGatewayDetailCapture } from "./detail-capture"
import {
  releaseLocalDistillationTriageForProcessor,
} from "./local-distillation-triage-port"
import {
  promoteDistillationTriageHandoff,
  type DistillationTriageHandoff,
} from "./local-distillation-triage-handoff.mjs"
import {
  stopChild,
  stopProcessTree,
  waitForEnvoyRunReadiness,
  waitForHealth,
  waitForListener,
} from "./process-lifecycle"
import {
  aigwEphemeralRunId,
  aigwRuntimeEnvironment,
  createAigwEphemeralRuntimeDirectory,
  prepareAigwRuntimeCache,
  removeAigwEphemeralRuntimeDirectory,
  type AigwEphemeralRuntimeDirectory,
} from "./aigw-runtime-cache"
import { operationalError, writeOperationalEvent } from "@genioone/telemetry/operational-log"

import { stringify } from "yaml"
import { Check } from "typebox/value"

import type { GatewayComponentObservation } from "@genioone/protocol/gateway-release"
import type { GatewayActivityIngest } from "../../../apps/platform/platform-api/src/capabilities/activities/contract"
import type { GatewayAuthenticationFailureAuditIngest } from "../../../apps/platform/platform-api/src/capabilities/audit-events/contract"
import { POLICY_RELEASE_FILES } from "../services/shared/policy-release"
import { gatewayDetailActivityReference } from "@genioone/telemetry/otlp-detail-capture"
import {
  DataClassificationReceiptSchema,
  type DataClassificationReceipt,
} from "../services/shared/data-classification"
import {
  SafetyDecisionReceiptSchema,
  mergeSafetyDecisionReceipts,
  type SafetyDecisionReceipt,
} from "../services/shared/safety-decision"
import type { GatewayReleaseApplier } from "./runtime"
import {
  createNativeActivitySourceManager,
  readNativeActivityReceipt,
  writeNativeActivityReceipt,
} from "./native-activity-source"

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
  onAuthenticationFailure?(event: GatewayAuthenticationFailureAuditIngest): Promise<void>
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

interface ProcessorActivityReceipt {
  bundle_revision: string
  request_steps: Array<{ step_id: string; action: string }>
  response_steps: Array<{ step_id: string; action: string }>
  data_classifications: DataClassificationReceipt[]
  safety_decisions: SafetyDecisionReceipt[]
}

export interface ProcessorHttpObservation {
  event: "genio.one.processor-http-request-completed" |
    "genio.one.processor-http-response-completed"
  correlation_id: string
  bundle_revision: string
  steps: Array<{ step_id: string; action: string }>
  data_classifications: DataClassificationReceipt[]
  safety_decisions: SafetyDecisionReceipt[]
}

export function parseProcessorHttpObservation(value: unknown): ProcessorHttpObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const observed = value as Partial<ProcessorHttpObservation>
  if (
    (observed.event !== "genio.one.processor-http-request-completed" &&
      observed.event !== "genio.one.processor-http-response-completed") ||
    typeof observed.correlation_id !== "string" ||
    typeof observed.bundle_revision !== "string" ||
    !Array.isArray(observed.steps) ||
    !observed.steps.every((step) =>
      step && typeof step === "object" &&
      typeof step.step_id === "string" && step.step_id.length > 0 &&
      typeof step.action === "string" && step.action.length > 0
    ) ||
    !Array.isArray(observed.data_classifications) ||
    !observed.data_classifications.every((entry) => Check(DataClassificationReceiptSchema, entry)) ||
    (observed.safety_decisions !== undefined &&
      (!Array.isArray(observed.safety_decisions) ||
        !observed.safety_decisions.every((entry) => Check(SafetyDecisionReceiptSchema, entry))))
  ) return null
  return {
    event: observed.event,
    correlation_id: observed.correlation_id,
    bundle_revision: observed.bundle_revision,
    steps: observed.steps,
    data_classifications: observed.data_classifications,
    safety_decisions: observed.safety_decisions ?? [],
  }
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

type ActivityReaderIgnoredReason = "MALFORMED_NATIVE_EVENT" | "UNRECOGNIZED_NATIVE_EVENT"
type ActivityReaderFailurePhase = "DELIVERY" | "CURSOR_PERSISTENCE"
type ActivityReaderDeliveryKind = "ACTIVITY" | "AUTHENTICATION_FAILURE" | "CURSOR"

const jwtAuthnAccessDeniedDetails = /^jwt_authn_access_denied(?:\{[^{}\r\n]*\})?$/

export async function readActivityCursor(path: string): Promise<number> {
  const value = (await readFile(path, "utf8")).trim()
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("Activity cursor is invalid")
  const cursor = Number(value)
  if (!Number.isSafeInteger(cursor)) throw new Error("Activity cursor is invalid")
  return cursor
}

export async function writeActivityCursor(path: string, cursor: number): Promise<void> {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Activity cursor is invalid")
  const candidatePath = `${path}.candidate`
  await writeFile(candidatePath, `${cursor}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(candidatePath, path)
}

export function authenticationFailureForNativeEvent(
  releaseId: string,
  value: unknown,
  lineNumber: number,
): GatewayAuthenticationFailureAuditIngest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return null
  const raw = value as Record<string, unknown>
  if (Number(raw.response_code) !== 401) return null
  if (typeof raw.response_code_details !== "string" || !jwtAuthnAccessDeniedDetails.test(raw.response_code_details)) {
    return null
  }
  const correlationId = raw["x-request-id"]
  if (typeof correlationId !== "string" || correlationId.length === 0 || correlationId.length > 256) {
    return null
  }
  const parsedStartTime = Date.parse(String(raw.start_time ?? ""))
  const occurredAt = Number.isFinite(parsedStartTime) ? Math.floor(parsedStartTime / 1_000) : 0
  const auditEventId = `gateway-authentication-failure-${createHash("sha256")
    .update(releaseId)
    .update("\0")
    .update(String(lineNumber))
    .digest("hex")}`
  return {
    audit_event_id: auditEventId,
    correlation_id: correlationId,
    kind: "GATEWAY_AUTHENTICATION_FAILURE",
    outcome: "DENY",
    subject: null,
    acting_client: null,
    resource_id: null,
    capability_id: null,
    status: 401,
    reason: "JWT_AUTHN_ACCESS_DENIED",
    occurred_at: occurredAt,
  }
}

export function activityPathWithoutQuery(value: unknown): string {
  if (typeof value !== "string") return ""
  const queryIndex = value.indexOf("?")
  const fragmentIndex = value.indexOf("#")
  const end = Math.min(
    queryIndex >= 0 ? queryIndex : value.length,
    fragmentIndex >= 0 ? fragmentIndex : value.length,
  )
  return value.slice(0, end)
}

export async function consumeActivityLogLines<T, A = never>(
  lines: readonly string[],
  consumed: number,
  toActivity: (value: unknown, authenticationFailure: boolean) => T | null,
  onActivity: ((event: T) => Promise<void>) | undefined,
  persistCursor: (consumed: number) => Promise<void>,
  onIgnored: (input: {
    reason: ActivityReaderIgnoredReason
    lineNumber: number
    error?: unknown
  }) => void,
  onDeliveryFailed: (input: {
    lineNumber: number
    error: unknown
    phase: ActivityReaderFailurePhase
    kind: ActivityReaderDeliveryKind
  }) => void,
  toAuthenticationFailure?: (value: unknown, lineNumber: number) => A | null,
  onAuthenticationFailure?: (event: A) => Promise<void>,
  onLineAcknowledged?: (input: { activity: T | null; authenticationFailure: A | null }) => void,
  lineOffset = 0,
): Promise<number> {
  let cursor = consumed
  const advance = async (lineNumber: number): Promise<boolean> => {
    const nextCursor = cursor + 1
    try {
      await persistCursor(nextCursor)
    } catch (error) {
      onDeliveryFailed({ lineNumber, error, phase: "CURSOR_PERSISTENCE", kind: "CURSOR" })
      return false
    }
    cursor = nextCursor
    return true
  }
  while (cursor < lines.length) {
    const line = lines[cursor] ?? ""
    if (!line.trim()) {
      if (!(await advance(lineOffset + cursor + 1))) break
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      onIgnored({ reason: "MALFORMED_NATIVE_EVENT", lineNumber: lineOffset + cursor + 1, error })
      if (!(await advance(lineOffset + cursor + 1))) break
      continue
    }
    let authenticationFailure: A | null = null
    if (toAuthenticationFailure) {
      authenticationFailure = toAuthenticationFailure(parsed, lineOffset + cursor + 1)
    }
    let event: T | null
    try {
      event = toActivity(parsed, authenticationFailure !== null)
    } catch (error) {
      event = null
      if (authenticationFailure === null) {
        onIgnored({ reason: "UNRECOGNIZED_NATIVE_EVENT", lineNumber: lineOffset + cursor + 1, error })
        if (!(await advance(lineOffset + cursor + 1))) break
        continue
      }
    }
    if (event === null && authenticationFailure === null) {
      onIgnored({ reason: "UNRECOGNIZED_NATIVE_EVENT", lineNumber: lineOffset + cursor + 1 })
      if (!(await advance(lineOffset + cursor + 1))) break
      continue
    }
    if (event !== null && !onActivity) {
      onDeliveryFailed({
        lineNumber: lineOffset + cursor + 1,
        error: new Error("Activity delivery callback is not configured"),
        phase: "DELIVERY",
        kind: "ACTIVITY",
      })
      break
    }
    if (event !== null && onActivity) {
      try {
        await onActivity(event)
      } catch (error) {
        onDeliveryFailed({ lineNumber: lineOffset + cursor + 1, error, phase: "DELIVERY", kind: "ACTIVITY" })
        break
      }
    }
    if (authenticationFailure !== null && !onAuthenticationFailure) {
      onDeliveryFailed({
        lineNumber: lineOffset + cursor + 1,
        error: new Error("Authentication failure audit callback is not configured"),
        phase: "DELIVERY",
        kind: "AUTHENTICATION_FAILURE",
      })
      break
    }
    if (authenticationFailure !== null && onAuthenticationFailure) {
      try {
        await onAuthenticationFailure(authenticationFailure)
      } catch (error) {
        onDeliveryFailed({
          lineNumber: lineOffset + cursor + 1,
          error,
          phase: "DELIVERY",
          kind: "AUTHENTICATION_FAILURE",
        })
        break
      }
    }
    if (!(await advance(lineOffset + cursor + 1))) break
    onLineAcknowledged?.({ activity: event, authenticationFailure })
  }
  return cursor
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
          json["genio.processor.safety_decisions"] = "%DYNAMIC_METADATA(genio.one.processor:safety_decisions)%"
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
  let processorHandoff: {
    handoff: DistillationTriageHandoff
    processor: ChildProcess | undefined
  } | undefined
  let processorStdout = ""
  let observationReleaseId: string | undefined
  let processorObservationPending = Promise.resolve()
  let receiptPersistence = Promise.resolve()
  const sourceByChild = new WeakMap<ChildProcess, string>()
  const routeLeaseByCorrelation = new Map<string, ModelRouteLeaseObservation>()
  const processorReceiptByCorrelation = new Map<string, ProcessorActivityReceipt>()
  const activitySources = options.onActivity || options.onAuthenticationFailure
    ? createNativeActivitySourceManager({
        stateRoot: options.stateRoot,
        runtimeCommandKeyRingPath: options.runtimeCommandKeyRingPath,
        consume: consumeNativeActivityBatch,
        onError({ releaseId, error }) {
          writeOperationalEvent("gateway-runtime", "ERROR", "genio.one.gateway-runtime.activity-source-recovery-failed", {
            release_id: releaseId,
            ...operationalError(error),
          })
        },
      })
    : undefined

  async function persistCorrelationReceipt(releaseId: string, correlationId: string): Promise<void> {
    if (!activitySources) return
    const operation = receiptPersistence.then(async () => {
      if (observationReleaseId !== releaseId) return
      const routeLease = routeLeaseByCorrelation.get(correlationId) ?? null
      const processorReceipt = processorReceiptByCorrelation.get(correlationId) ?? null
      if (!routeLease && !processorReceipt) return
      await writeNativeActivityReceipt(join(options.stateRoot, releaseId), correlationId, {
        schema_version: 1,
        release_id: releaseId,
        correlation_id: correlationId,
        route_lease: routeLease,
        processor_receipt: processorReceipt,
      })
    })
    receiptPersistence = operation.then(() => undefined, () => undefined)
    await operation
  }

  async function persistStoppedReceipts(releaseId: string): Promise<void> {
    if (observationReleaseId !== releaseId) return
    for (const correlationId of routeLeaseByCorrelation.keys()) await persistCorrelationReceipt(releaseId, correlationId)
    for (const correlationId of processorReceiptByCorrelation.keys()) {
      if (!routeLeaseByCorrelation.has(correlationId)) await persistCorrelationReceipt(releaseId, correlationId)
    }
  }

  function reapProcessTree(child: ChildProcess): Promise<void> {
    if (activeCleanup) return activeCleanup
    const cleanup = Promise.resolve().then(async () => {
      await processorObservationPending
      await receiptPersistence
      await stopProcessTree(child)
      await processorObservationPending
      const releaseId = sourceByChild.get(child)
      if (releaseId) {
        await persistStoppedReceipts(releaseId)
        await receiptPersistence
        await activitySources?.seal(releaseId)
        await receiptPersistence
        sourceByChild.delete(child)
        if (observationReleaseId === releaseId) {
          routeLeaseByCorrelation.clear()
          processorReceiptByCorrelation.clear()
          observationReleaseId = undefined
        }
      }
    }).finally(() => {
      if (activeCleanup === cleanup) activeCleanup = undefined
    })
    activeCleanup = cleanup
    return cleanup
  }

  async function stopActiveProcessTree(): Promise<void> {
    const child = active
    if (activeCleanup) await activeCleanup
    else if (child) await reapProcessTree(child)
    if (active === child) active = undefined
  }

  async function bindReadyProcessorToTriageHandoff(child: ChildProcess): Promise<void> {
    const handoff = processorHandoff
    if (!handoff || child.exitCode !== null || child.signalCode !== null) return
    const readyHandoff = promoteDistillationTriageHandoff(handoff.handoff, "ready")
    if (!readyHandoff) {
      if (processorHandoff === handoff) processorHandoff = undefined
      return
    }
    if (processorHandoff === handoff) {
      handoff.handoff = readyHandoff
      handoff.processor = child
    }
  }

  function activityForRelease(
    release: Parameters<GatewayReleaseApplier["apply"]>[0]["release"],
    value: unknown,
    authenticationFailure: boolean,
    observations: {
      routeLease: ModelRouteLeaseObservation | null
      processorReceipt: ProcessorActivityReceipt | null
    },
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
    const path = activityPathWithoutQuery(raw.path)
    const method = typeof raw.method === "string" ? raw.method : ""
    if (!projection || !correlationId || !path || !method || !Number.isInteger(status)) return null
    const projectionResources = projection.resources as Array<Record<string, any>>
    const { routeLease, processorReceipt } = observations
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
    const safetyDecisions = (field: string): SafetyDecisionReceipt[] => {
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
      return decoded.every((value) => Check(SafetyDecisionReceiptSchema, value))
        ? decoded as SafetyDecisionReceipt[]
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
    const loggedSafetyDecisions = safetyDecisions("genio.processor.safety_decisions")
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
      application_id: authenticationFailure ? null : stringOrNull("genio.client.id"),
      subject_id: authenticationFailure ? null : stringOrNull("genio.subject.id"),
      acting_client_id: authenticationFailure ? null : stringOrNull("genio.client.id"),
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
      safety_decisions: (() => {
        const merged = [...(processorReceipt?.safety_decisions ?? [])]
        mergeSafetyDecisionReceipts(merged, loggedSafetyDecisions)
        return merged
      })(),
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

  async function observationsForLine(root: string, releaseId: string, line: string): Promise<{
    routeLease: ModelRouteLeaseObservation | null
    processorReceipt: ProcessorActivityReceipt | null
  }> {
    let raw: unknown
    try { raw = JSON.parse(line) } catch { return { routeLease: null, processorReceipt: null } }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { routeLease: null, processorReceipt: null }
    const correlationId = (raw as Record<string, unknown>)["x-request-id"]
    if (typeof correlationId !== "string" || !correlationId) return { routeLease: null, processorReceipt: null }
    await processorObservationPending
    if (observationReleaseId === releaseId) await persistCorrelationReceipt(releaseId, correlationId)
    const stored = await readNativeActivityReceipt(root, correlationId)
    if (stored === null) return { routeLease: null, processorReceipt: null }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("Native activity receipt is invalid")
    const record = stored as Record<string, unknown>
    if (Object.keys(record).length !== 5 || record.schema_version !== 1 || record.release_id !== releaseId ||
      record.correlation_id !== correlationId) throw new Error("Native activity receipt binding is invalid")
    let routeLease: ModelRouteLeaseObservation | null = null
    if (record.route_lease !== null) {
      const observed = record.route_lease as Partial<ModelRouteLeaseObservation>
      if (!observed || observed.event !== "genio.one.model-route-lease" || observed.correlation_id !== correlationId ||
        typeof observed.lease_id !== "string" || typeof observed.routing_policy_id !== "string" ||
        !Number.isSafeInteger(observed.routing_revision) || typeof observed.candidate_set_digest !== "string" ||
        typeof observed.selected_public_model_id !== "string" || typeof observed.selected_public_model !== "string" ||
        typeof observed.connection_id !== "string" || typeof observed.provider_model !== "string" || typeof observed.reused !== "boolean") {
        throw new Error("Native activity route receipt is invalid")
      }
      routeLease = observed as ModelRouteLeaseObservation
    }
    let processorReceipt: ProcessorActivityReceipt | null = null
    if (record.processor_receipt !== null) {
      const observed = record.processor_receipt as ProcessorActivityReceipt
      const request = parseProcessorHttpObservation({ ...observed, event: "genio.one.processor-http-request-completed",
        correlation_id: correlationId, steps: observed?.request_steps })
      const response = parseProcessorHttpObservation({ ...observed, event: "genio.one.processor-http-response-completed",
        correlation_id: correlationId, steps: observed?.response_steps })
      if (!request || !response) throw new Error("Native activity Processor receipt is invalid")
      processorReceipt = { bundle_revision: request.bundle_revision, request_steps: request.steps, response_steps: response.steps,
        data_classifications: request.data_classifications, safety_decisions: request.safety_decisions }
    }
    return { routeLease, processorReceipt }
  }

  async function consumeNativeActivityBatch(
    batch: import("./native-activity-source").NativeActivityBatch,
  ): Promise<number> {
    const release = batch.context.release
    let acknowledged = 0
    for (const line of batch.lines) {
      let observations: Awaited<ReturnType<typeof observationsForLine>>
      try {
        observations = await observationsForLine(batch.root, release.release_id, line)
      } catch (error) {
        writeOperationalEvent("gateway-runtime", "ERROR", "genio.one.gateway-runtime.activity-receipt-persist-failed", {
          release_id: release.release_id,
          line_number: batch.lineOffset + acknowledged + 1,
          ...operationalError(error),
        })
        break
      }
      const consumed = await consumeActivityLogLines(
        [line], 0,
        (value, authenticationFailure) => activityForRelease(release, value, authenticationFailure, observations),
        options.onActivity ? async (event) => {
          await options.onActivity!(event)
          writeOperationalEvent("gateway-runtime", "INFO", "genio.one.gateway-runtime.activity-delivered", {
            release_id: release.release_id, correlation_id: event.correlation_id,
          })
        } : undefined,
        (count) => batch.persistCursor(acknowledged + count),
        ({ reason, lineNumber, error }) => {
          writeOperationalEvent("gateway-runtime", "WARN", "genio.one.gateway-runtime.activity-ignored", {
            release_id: release.release_id, line_number: lineNumber, reason,
            ...(error === undefined ? {} : operationalError(error)),
          })
        },
        ({ lineNumber, error, phase, kind }) => {
          writeOperationalEvent("gateway-runtime", "ERROR", phase === "CURSOR_PERSISTENCE"
            ? "genio.one.gateway-runtime.activity-cursor-persist-failed"
            : kind === "AUTHENTICATION_FAILURE"
              ? "genio.one.gateway-runtime.authentication-failure-audit-delivery-failed"
              : "genio.one.gateway-runtime.activity-delivery-failed", {
            release_id: release.release_id, line_number: lineNumber, ...operationalError(error),
          })
        },
        authenticationFailureForNativeEvent.bind(null, release.release_id),
        options.onAuthenticationFailure ? async (event) => {
          await options.onAuthenticationFailure!(event)
          writeOperationalEvent("gateway-runtime", "INFO", "genio.one.gateway-runtime.authentication-failure-audit-delivered", {
            release_id: release.release_id, correlation_id: event.correlation_id, audit_event_id: event.audit_event_id,
          })
        } : undefined,
        ({ activity }) => {
          if (!activity || observationReleaseId !== release.release_id) return
          routeLeaseByCorrelation.delete(activity.correlation_id)
          processorReceiptByCorrelation.delete(activity.correlation_id)
        },
        batch.lineOffset + acknowledged,
      )
      if (consumed === 0) break
      acknowledged += consumed
    }
    return acknowledged
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
    const checkoutRoot = resolve(import.meta.dirname, "..", "..", "..")
    const processorEnvironment: NodeJS.ProcessEnv = {
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
      GENIO_ONE_DISTILLATION_TRIAGE_TOKEN: "local-distillation-triage",
      GENIO_ONE_DETAIL_CAPTURE_LISTEN: "127.0.0.1:8083",
      ...(options.telemetry
        ? {
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
              `http://127.0.0.1:${options.telemetry.httpPort}/v1/traces`,
          }
        : {}),
    }
    const configuredAdapterRegistry = processorEnvironment.GENIO_ONE_PROCESSOR_ADAPTERS_FILE?.trim()
    if (configuredAdapterRegistry) {
      processorEnvironment.GENIO_ONE_PROCESSOR_ADAPTERS_FILE = resolve(
        import.meta.dirname,
        "..",
        configuredAdapterRegistry,
      )
    }
    let triageHandoff: DistillationTriageHandoff
    try {
      triageHandoff = await releaseLocalDistillationTriageForProcessor(checkoutRoot)
    } catch (error) {
      throw error
    }
    processorHandoff = { handoff: triageHandoff, processor: undefined }
    const launchedProcessor = spawn(
      process.execPath,
      [gatewayServiceEntrypoint("processor")],
      {
        env: processorEnvironment,
        stdio: ["ignore", "pipe", "inherit"],
      },
    )
    processor = launchedProcessor
    launchedProcessor.once("exit", () => {
      if (processorHandoff?.processor === launchedProcessor) {
        processorHandoff.processor = undefined
      }
    })
    const processProcessorStdout = async (chunk: Buffer) => {
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
        const receipt = parseProcessorHttpObservation(observed)
        if (receipt) {
          const current = processorReceiptByCorrelation.get(receipt.correlation_id) ?? {
            bundle_revision: receipt.bundle_revision,
            request_steps: [],
            response_steps: [],
            data_classifications: [],
            safety_decisions: [],
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
            safety_decisions: (() => {
              const merged = [...current.safety_decisions]
              mergeSafetyDecisionReceipts(merged, receipt.safety_decisions)
              return merged
            })(),
          })
          if (observationReleaseId) {
            await persistCorrelationReceipt(observationReleaseId, receipt.correlation_id).catch((error) => {
              writeOperationalEvent("gateway-runtime", "ERROR", "genio.one.gateway-runtime.activity-receipt-persist-failed", {
                release_id: observationReleaseId, correlation_id: receipt.correlation_id, ...operationalError(error),
              })
            })
          }
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
        if (observationReleaseId) {
          await persistCorrelationReceipt(observationReleaseId, observed.correlation_id).catch((error) => {
            writeOperationalEvent("gateway-runtime", "ERROR", "genio.one.gateway-runtime.activity-receipt-persist-failed", {
              release_id: observationReleaseId, correlation_id: observed.correlation_id, ...operationalError(error),
            })
          })
        }
        process.stdout.write(`${line}\n`)
      }
    }
    launchedProcessor.stdout?.on("data", (chunk) => {
      launchedProcessor.stdout?.pause?.()
      processorObservationPending = processProcessorStdout(chunk).catch((error) => {
        writeOperationalEvent("gateway-runtime", "ERROR", "genio.one.gateway-runtime.processor-observation-persist-failed", {
          ...operationalError(error),
        })
      }).finally(() => { launchedProcessor.stdout?.resume?.() })
    })
    await waitForListener(8082, launchedProcessor, options.readinessTimeoutMs ?? 120_000)
    await waitForListener(8083, launchedProcessor, options.readinessTimeoutMs ?? 120_000)
    await bindReadyProcessorToTriageHandoff(launchedProcessor)
  }

  return {
    async apply({ command, release }) {
      await activitySources?.start({ command, release })

      if (release.projections.length === 0) {
        await stopActiveProcessTree()
        active = undefined
        activitySources?.clearCurrent()
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
      observationReleaseId ??= release.release_id
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
      await activitySources?.register({ command, release })
      if (activitySources) {
        writeOperationalEvent("gateway-runtime", "INFO", "genio.one.gateway-runtime.activity-reader-started", {
          release_id: release.release_id, activity_path: activityLogPath,
        })
      }
      observationReleaseId = release.release_id
      await writeFile(join(policyRoot, "current"), `${release.release_id}\n`)
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
      sourceByChild.set(child, release.release_id)
      child.once("exit", () => {
        if (active === child) {
          active = undefined
          void reapProcessTree(child).catch((error) => {
            writeOperationalEvent("gateway-runtime", "WARN", "genio.one.gateway-runtime.aigw-process-group-cleanup-failed", {
              ...operationalError(error),
            })
          })
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
        writeOperationalEvent("gateway-runtime", "INFO", "genio.one.gateway-runtime.release-applied", {
          release_id: release.release_id,
          head_revision: release.head_revision,
          active_routes: release.projections.length,
        })
        await writeFile(join(policyRoot, "lkg"), `${release.release_id}\n`)
      } catch (error) {
        try {
          await reapProcessTree(child)
          await removeRuntimeDirectory()
        } catch (cleanupError) {
          writeOperationalEvent("gateway-runtime", "WARN", "genio.one.gateway-runtime.aigw-process-group-cleanup-failed", {
            ...operationalError(cleanupError),
          })
        }
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
      aigwDownloadAbort?.abort()
      await aigwPreparation?.catch(() => undefined)
      await stopActiveProcessTree()
      await activitySources?.close()
      if (activeRuntimeDirectory) {
        await removeAigwEphemeralRuntimeDirectory(activeRuntimeDirectory).catch(() => undefined)
        activeRuntimeDirectory = undefined
      }
      const processorToStop = processor
      try {
        await stopChild(processorToStop)
      } catch (error) {
        writeOperationalEvent("gateway-runtime", "WARN", "genio.one.gateway-runtime.gateway-service-cleanup-failed", {
          ...operationalError(error),
        })
      }
      await Promise.all([authorizer].map((child) => stopChild(child).catch((error) => {
        writeOperationalEvent("gateway-runtime", "WARN", "genio.one.gateway-runtime.gateway-service-cleanup-failed", {
          ...operationalError(error),
        })
      })))
    },
  }
}
