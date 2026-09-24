import { providerCredentialSecretName } from "../../../../../../runtimes/gateway/services/shared/provider-credential-reference"
import { createHash, generateKeyPairSync, sign as signPayload } from "node:crypto"
import { isIP } from "node:net"

import {
  MODEL_ROUTE_HANDOFF_HEADERS,
  ROUTE_PUBLIC_MODEL_HEADER,
} from "../../../../../../runtimes/gateway/services/shared/model-route-handoff"
import { PROCESSOR_SAFETY_DECISIONS_HEADER } from "../../../../../../runtimes/gateway/services/shared/safety-decision"
import { mcpOAuthHeaderName } from "../../../../../../runtimes/gateway/services/shared/mcp-oauth-handoff"
import { isModelCandidateEffect } from "../../../../../../runtimes/gateway/services/shared/model-candidate-effect"
import { isEd25519Signature } from "@genioone/protocol/ed25519-signature"

import { PlatformApiError } from "../errors"
import {
  validateCompiledEnforcementChainSemantics,
  validateNativeJwtAuthenticationConfig,
} from "../enforcement/compiler"
import type { NativeJwtAuthenticationConfig } from "../enforcement/contract"
import type { CompiledEnforcementChain } from "../enforcement/contract"
import type { ConnectionRegistration } from "../connections/contract"
import type { ProviderCredentialProfileRevision } from "../provider-credentials/contract"
import type {
  GatewayNativeResource,
  GatewayProjectionPublication,
  GatewayProjectionSnapshot,
  GatewayProjectionRendererOptions,
  GatewayProjectionSigner,
  GatewayServiceReference,
} from "./contract"
import type { GatewayProjectionSource, GatewayProjectionRequest } from "./contract"
import type { GatewayProjector } from "./module"
import { canonicalJson, compareUtf8 } from "@genioone/protocol/canonical"

const AI_GATEWAY_ROUTE_API_VERSION = "aigateway.envoyproxy.io/v1beta1"
const ENVOY_GATEWAY_API_VERSION = "gateway.envoyproxy.io/v1alpha1"
const GATEWAY_API_GROUP = "gateway.networking.k8s.io"
const AI_GATEWAY_GROUP = "aigateway.envoyproxy.io"
const ENVOY_GATEWAY_GROUP = "gateway.envoyproxy.io"
const PROCESSOR_HTTP_PORT = 8182
const UPSTREAM_TLS_ECDH_CURVES = ["X25519", "P-256", "P-384"] as const

const DEFAULT_OPTIONS: Required<
  Pick<
    GatewayProjectionRendererOptions,
    | "namespace"
    | "aigwRootPrefix"
    | "extAuthTimeout"
  >
> & {
  extAuth: GatewayServiceReference
  processor: GatewayServiceReference
  processorGrpc: GatewayServiceReference
} = {
  namespace: "default",
  // AIGatewayRoute v1.1 has no per-route path matcher. The native AI Gateway
  // controller applies this root prefix to the generated HTTPRoute.
  aigwRootPrefix: "/",
  extAuth: {
    name: "genio-one-authorizer",
    port: 8081,
    group: ENVOY_GATEWAY_GROUP,
    kind: "Backend",
  },
  processor: {
    name: "genio-one-processor-http",
    port: PROCESSOR_HTTP_PORT,
    group: ENVOY_GATEWAY_GROUP,
    kind: "Backend",
  },
  processorGrpc: {
    name: "genio-one-processor",
    port: 8082,
    group: ENVOY_GATEWAY_GROUP,
    kind: "Backend",
  },
  extAuthTimeout: "2s",
}

const DEFAULT_LLM_REQUEST_COSTS = [
  { metadataKey: "llm_input_token", type: "InputToken" },
  { metadataKey: "llm_cached_input_token", type: "CachedInputToken" },
  { metadataKey: "llm_output_token", type: "OutputToken" },
  { metadataKey: "llm_reasoning_token", type: "ReasoningToken" },
  { metadataKey: "llm_total_token", type: "TotalToken" },
] as const

export const canonicalGatewayProjectionJson = canonicalJson

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalGatewayProjectionJson(value)).digest("hex")
}

/**
 * Ed25519 signatures are deterministic for a fixed private key and payload.
 * The key is intentionally ephemeral for the in-memory projector; production
 * composition must provide a durable key backed by the platform key store.
 */
export function createEphemeralEd25519Signer(): GatewayProjectionSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" })
  const keyId = createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 32)

  return {
    algorithm: "Ed25519",
    keyId,
    sign(payload) {
      return signPayload(null, Buffer.from(payload), privateKey).toString("base64url")
    },
  }
}

function isKubernetesDnsName(value: string): boolean {
  return (
    value.length <= 253 &&
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(value)
  )
}

function kubernetesName(value: string, label: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!normalized) {
    throw new PlatformApiError("INVALID_KUBERNETES_NAME", 422, `${label} is empty`)
  }
  if (normalized.length <= 253) return normalized
  return normalized.slice(0, 253).replace(/-+$/, "")
}

function normalizePathPrefix(value: string): string {
  if (value === "/") return value
  return value.replace(/\/+$/, "") || "/"
}

function assertPublicationEndpoint(
  endpoint: GatewayProjectionPublication | null | undefined,
): GatewayProjectionPublication {
  if (!endpoint) {
    throw new PlatformApiError(
      "GATEWAY_PUBLICATION_ENDPOINT_REQUIRED",
      422,
      "A Gateway publication endpoint is required before projection",
    )
  }
  if (!isKubernetesDnsName(endpoint.hostname)) {
    throw new PlatformApiError(
      "INVALID_PUBLICATION_HOSTNAME",
      422,
      "Publication hostname must be a DNS hostname accepted by Gateway API",
    )
  }
  if (!endpoint.base_path.startsWith("/") || /[?#\s]/.test(endpoint.base_path)) {
    throw new PlatformApiError(
      "INVALID_PUBLICATION_BASE_PATH",
      422,
      "Publication base path must be an absolute path without query or fragment",
    )
  }
  // The parent reference is a Kubernetes resource name, not a free-form
  // product identifier. Keep the semantic ID in the envelope but fail early
  // if it cannot identify a Gateway resource.
  if (!isKubernetesDnsName(endpoint.gateway_id)) {
    throw new PlatformApiError(
      "INVALID_PUBLICATION_GATEWAY",
      422,
      "Publication gateway_id must be a Kubernetes Gateway name",
    )
  }
  return {
    gateway_id: endpoint.gateway_id,
    hostname: endpoint.hostname.toLowerCase(),
    base_path: normalizePathPrefix(endpoint.base_path),
  }
}

function assertAigwRootPrefix(
  publication: GatewayProjectionPublication,
  configuredRootPrefix: string,
): void {
  if (!configuredRootPrefix.startsWith("/") || /[?#\s]/.test(configuredRootPrefix)) {
    throw new PlatformApiError(
      "INVALID_AIGW_ROOT_PREFIX",
      500,
      "The Envoy AI Gateway root prefix must be an absolute path without query or fragment",
    )
  }
  if (normalizePathPrefix(publication.base_path) !== normalizePathPrefix(configuredRootPrefix)) {
    throw new PlatformApiError(
      "PUBLICATION_BASE_PATH_NOT_SUPPORTED_BY_AIGW",
      422,
      "Envoy AI Gateway v1.1 uses one native root prefix for its generated HTTPRoutes; publication base_path must match it",
    )
  }
}

interface ParsedEndpoint {
  host: string
  port: number
  secure: boolean
  pathPrefix?: string
}

function parseEndpoint(value: string): ParsedEndpoint {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new PlatformApiError("INVALID_CONNECTION_ENDPOINT", 422)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PlatformApiError(
      "UNSUPPORTED_CONNECTION_PROTOCOL",
      422,
      "AI Gateway provider connections must use HTTP or HTTPS",
    )
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!host || (!isIP(host) && !isKubernetesDnsName(host))) {
    throw new PlatformApiError("INVALID_CONNECTION_HOSTNAME", 422)
  }
  const port = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : parsed.protocol === "https:"
      ? 443
      : 80
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new PlatformApiError("INVALID_CONNECTION_PORT", 422)
  }
  const pathPrefix = parsed.pathname.replace(/^\/+|\/+$/g, "") || undefined
  return { host, port, secure: parsed.protocol === "https:", pathPrefix }
}

const SENSITIVE_POLICY_KEY = /(secret|token|password|api[_-]?key|credential|private)/i

/**
 * Configuration is part of the signed bundle, so treating it as arbitrary
 * JSON and recursively deleting keys is unsafe: a new secret-bearing field
 * could be silently dropped while a different field still reaches the
 * runtime. Keep the projection contract deliberately small until a policy
 * action owns a versioned schema of its own.
 */
const SAFE_POLICY_CONFIG_KEYS = new Set([
  "adapter_id",
  "allow",
  "allowed",
  "allowed_models",
  "candidate_effect",
  "candidate_models",
  "checks",
  "classifier_model",
  "default_model",
  "detector",
  "entities",
  "fallback_public_model_name",
  "fallback",
  "fallback_models",
  "fields",
  "flags",
  "expression",
  "id",
  "instructions",
  "language",
  "match",
  "keywords",
  "max_bytes",
  "max_tokens",
  "metadata",
  "mode",
  "model",
  "name",
  "patterns",
  "paths",
  "request_paths",
  "response_paths",
  "redaction",
  "required_obligations",
  "public_model_name",
  "route",
  "rules",
  "schema_version",
  "scope",
  "score_threshold",
  "strategy",
  "threshold",
  "token_prefix",
  "token_ttl_seconds",
  "timeout_ms",
  "ttl_seconds",
  "vault",
  "window_seconds",
])

function policyProjectionError(code: string, path: string): PlatformApiError {
  return new PlatformApiError(code, 422, `Unsupported One Policy projection field at ${path}`)
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw policyProjectionError("UNSAFE_POLICY_CONFIG", path)
  }
}

function safePolicyConfig(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw policyProjectionError("UNSAFE_POLICY_CONFIG", path)
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => safePolicyConfig(item, `${path}[${index}]`))
  }
  if (value === undefined || typeof value !== "object") {
    throw policyProjectionError("UNSAFE_POLICY_CONFIG", path)
  }

  assertRecord(value, path)
  const result: Record<string, unknown> = {}
  for (const [key, entryValue] of Object.entries(value)) {
    const entryPath = `${path}.${key}`
    if (!SAFE_POLICY_CONFIG_KEYS.has(key)) {
      if (SENSITIVE_POLICY_KEY.test(key)) {
        throw policyProjectionError("UNSAFE_POLICY_CONFIG_SECRET", entryPath)
      }
      throw policyProjectionError("UNSAFE_POLICY_CONFIG_KEY", entryPath)
    }
    result[key] = safePolicyConfig(entryValue, entryPath)
  }
  return result
}

function assertAllowedKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw policyProjectionError("UNSAFE_POLICY_CONFIG_KEY", `${path}.${key}`)
  }
}

function safeIdentifierArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw policyProjectionError("UNSAFE_POLICY_CONFIG", path)
  }
  return [...value]
}

function safePolicyAction(
  action: unknown,
  path: string,
): Record<string, unknown> {
  assertRecord(action, path)
  assertAllowedKeys(action, ["action", "effect", "config"], path)
  if (typeof action.action !== "string" || action.action.trim().length === 0) {
    throw policyProjectionError("UNSAFE_POLICY_CONFIG", `${path}.action`)
  }
  const safe: Record<string, unknown> = { action: action.action }
  if (action.effect !== undefined) {
    if (!isModelCandidateEffect(action.effect)) {
      throw policyProjectionError("UNSAFE_POLICY_CONFIG", `${path}.effect`)
    }
    safe.effect = action.effect
  }
  if (action.config !== undefined) safe.config = safePolicyConfig(action.config, `${path}.config`)
  return safe
}

function safePolicyStep(step: unknown, index: number): Record<string, unknown> {
  const path = `one_policy_chain.steps[${index}]`
  assertRecord(step, path)
  if (typeof step.kind !== "string" || typeof step.step_id !== "string" || step.step_id.length === 0) {
    throw policyProjectionError("UNSAFE_POLICY_CONFIG", path)
  }
  const common = ["step_id", "kind", "depends_on"]
  const safe: Record<string, unknown> = { step_id: step.step_id, kind: step.kind }
  if (step.depends_on !== undefined) {
    safe.depends_on = safeIdentifierArray(step.depends_on, `${path}.depends_on`)
  }

  switch (step.kind) {
    case "AUTHENTICATE":
    case "AUTHORIZE":
    case "ROUTE": {
      assertAllowedKeys(step, [...common, "phase", "implementation", "config"], path)
      if (typeof step.phase !== "string" || typeof step.implementation !== "string") {
        throw policyProjectionError("UNSAFE_POLICY_CONFIG", path)
      }
      if (step.kind === "AUTHENTICATE") {
        try {
          safe.config = validateNativeJwtAuthenticationConfig(step.config)
        } catch (error) {
          if (error instanceof PlatformApiError) throw error
          throw policyProjectionError("UNSAFE_POLICY_CONFIG", `${path}.config`)
        }
        safe.phase = step.phase
        safe.implementation = step.implementation
        return safe
      }
      safe.phase = step.phase
      safe.implementation = step.implementation
      if (step.config !== undefined) safe.config = safePolicyConfig(step.config, `${path}.config`)
      return safe
    }
    case "PROCESS": {
      assertAllowedKeys(step, [...common, "implementation", "hooks"], path)
      if (typeof step.implementation !== "string") throw policyProjectionError("UNSAFE_POLICY_CONFIG", path)
      assertRecord(step.hooks, `${path}.hooks`)
      assertAllowedKeys(step.hooks, ["request", "response"], `${path}.hooks`)
      const hooks: Record<string, unknown> = {}
      if (step.hooks.request !== undefined) hooks.request = safePolicyAction(step.hooks.request, `${path}.hooks.request`)
      if (step.hooks.response !== undefined) hooks.response = safePolicyAction(step.hooks.response, `${path}.hooks.response`)
      safe.implementation = step.implementation
      safe.hooks = hooks
      return safe
    }
    case "OBSERVE": {
      assertAllowedKeys(step, [...common, "implementation", "hooks"], path)
      if (typeof step.implementation !== "string") throw policyProjectionError("UNSAFE_POLICY_CONFIG", path)
      assertRecord(step.hooks, `${path}.hooks`)
      assertAllowedKeys(step.hooks, ["request", "attempt", "response"], `${path}.hooks`)
      const hooks: Record<string, unknown> = {}
      for (const hook of ["request", "attempt", "response"] as const) {
        if (step.hooks[hook] !== undefined) hooks[hook] = safePolicyAction(step.hooks[hook], `${path}.hooks.${hook}`)
      }
      safe.implementation = step.implementation
      safe.hooks = hooks
      return safe
    }
    default:
      throw policyProjectionError("UNSAFE_POLICY_CONFIG", `${path}.kind`)
  }
}

function safeEnforcementChain(
  chain: CompiledEnforcementChain,
): CompiledEnforcementChain {
  const value = chain as unknown as Record<string, unknown>
  assertRecord(value, "one_policy_chain")
  assertAllowedKeys(
    value,
    [
      "chain_id",
      "tenant_id",
      "resource_id",
      "capability_id",
      "eligible_connection_ids",
      "one_policy_revision",
      "steps",
      "request_filter_order",
      "response_filter_order",
    ],
    "one_policy_chain",
  )
  if (
    typeof value.chain_id !== "string" ||
    typeof value.tenant_id !== "string" ||
    typeof value.resource_id !== "string" ||
    typeof value.capability_id !== "string"
  ) {
    throw policyProjectionError("UNSAFE_POLICY_CONFIG", "one_policy_chain.identifiers")
  }
  const eligibleConnectionIds = safeIdentifierArray(
    value.eligible_connection_ids,
    "one_policy_chain.eligible_connection_ids",
  )
  if (new Set(eligibleConnectionIds).size !== eligibleConnectionIds.length) {
    throw policyProjectionError(
      "UNSAFE_POLICY_CONFIG",
      "one_policy_chain.eligible_connection_ids",
    )
  }
  const chainRevision = value.one_policy_revision
  if (typeof chainRevision !== "number" || !Number.isInteger(chainRevision) || chainRevision < 1) {
    throw policyProjectionError("UNSAFE_POLICY_CONFIG", "one_policy_chain.one_policy_revision")
  }
  if (!Array.isArray(value.steps)) throw policyProjectionError("UNSAFE_POLICY_CONFIG", "one_policy_chain.steps")
  const requestFilterOrder = safeIdentifierArray(
    value.request_filter_order,
    "one_policy_chain.request_filter_order",
  )
  const responseFilterOrder = safeIdentifierArray(
    value.response_filter_order,
    "one_policy_chain.response_filter_order",
  )
  return {
    chain_id: value.chain_id,
    tenant_id: value.tenant_id,
    resource_id: value.resource_id,
    capability_id: value.capability_id,
    eligible_connection_ids: eligibleConnectionIds,
    one_policy_revision: chainRevision,
    steps: value.steps.map(safePolicyStep) as CompiledEnforcementChain["steps"],
    request_filter_order: requestFilterOrder,
    response_filter_order: responseFilterOrder,
  }
}

function labels(resourceId: string, revision: number): Record<string, string> {
  return {
    "genio.one/resource": kubernetesName(resourceId, "resource"),
    "genio.one/revision": String(revision),
  }
}

function nativeResource(
  apiVersion: string,
  kind: string,
  name: string,
  namespace: string,
  resourceId: string,
  revision: number,
  spec: Record<string, unknown>,
  annotations?: Record<string, string>,
): GatewayNativeResource {
  return {
    apiVersion,
    kind,
    metadata: {
      name: kubernetesName(name, kind),
      namespace,
      labels: labels(resourceId, revision),
      ...(annotations ? { annotations } : {}),
    },
    spec,
  }
}

/**
 * `SecurityPolicy.jwt` and `SecurityPolicy.extAuth` live on the same route,
 * but Envoy Gateway's process-wide HTTP filter order is owned by EnvoyProxy.
 * Emit the required native ordering beside every authorization projection so
 * a runtime never has to rely on the retired static bundle for identity-before-
 * authorization semantics.
 *
 * The Gateway publication contract intentionally requires `gateway_id` to be
 * the Kubernetes Gateway name. GenioOne's Gateway baseline uses the same name
 * for its infrastructure EnvoyProxy, which keeps this shared resource stable
 * across every Resource published through that Gateway.
 */
function authorizationFilterOrder(
  gatewayId: string,
  namespace: string,
  tenantId: string,
  telemetry?: GatewayServiceReference,
): GatewayNativeResource {
  const accessLogSinks: Array<Record<string, unknown>> = [
    { type: "File", file: { path: "/dev/stdout" } },
  ]
  if (telemetry) {
    accessLogSinks.push({
      type: "OpenTelemetry",
      openTelemetry: {
        backendRefs: [backendReference(telemetry, namespace)],
        resources: {
          "service.name": "genio-one-ai-gateway",
          "genio.tenant.id": tenantId,
          "genio.gateway.id": gatewayId,
        },
      },
    })
  }
  return {
    apiVersion: ENVOY_GATEWAY_API_VERSION,
    kind: "EnvoyProxy",
    metadata: {
      name: kubernetesName(gatewayId, "EnvoyProxy"),
      namespace,
    },
    spec: {
      provider: {
        type: "Kubernetes",
        kubernetes: {
          envoyService: { type: "ClusterIP" },
        },
      },
      filterOrder: [
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
      ],
      telemetry: {
        ...(telemetry ? {
          metrics: {
            prometheus: { disable: true },
            enableRequestResponseSizesStats: true,
            sinks: [{
              type: "OpenTelemetry",
              openTelemetry: {
                backendRefs: [backendReference(telemetry, namespace)],
                reportCountersAsDeltas: true,
                reportHistogramsAsDeltas: true,
                resourceAttributes: {
                  "service.name": "genio-one-ai-gateway",
                  "genio.tenant.id": tenantId,
                  "genio.gateway.id": gatewayId,
                },
              },
            }],
          },
        } : {}),
        ...(telemetry ? {
          tracing: {
            samplingRate: 100,
            provider: {
              type: "OpenTelemetry",
              backendRefs: [backendReference(telemetry, namespace)],
            },
            customTags: {
              "genio.tenant.id": {
                type: "Literal",
                literal: { value: tenantId },
              },
              "genio.gateway.id": {
                type: "Literal",
                literal: { value: gatewayId },
              },
              "genio.correlation.id": {
                type: "RequestHeader",
                requestHeader: {
                  name: "x-request-id",
                  defaultValue: "-",
                },
              },
            },
          },
        } : {}),
        accessLog: {
          settings: [
            {
              type: "Route",
              sinks: accessLogSinks,
              format: {
                type: "JSON",
                json: {
                "genio.event.kind": "ai_gateway_activity",
                "gen_ai.request.model": "%REQ(X-AI-EG-MODEL)%",
                "gen_ai.response.model": "%DYNAMIC_METADATA(io.envoy.ai_gateway:response_model)%",
                "gen_ai.provider.name": "%DYNAMIC_METADATA(io.envoy.ai_gateway:backend_name)%",
                "gen_ai.usage.total_tokens": "%DYNAMIC_METADATA(io.envoy.ai_gateway:llm_total_token)%",
                "gen_ai.usage.input_tokens": "%DYNAMIC_METADATA(io.envoy.ai_gateway:llm_input_token)%",
                "gen_ai.usage.output_tokens": "%DYNAMIC_METADATA(io.envoy.ai_gateway:llm_output_token)%",
                "mcp.method.name": "%DYNAMIC_METADATA(io.envoy.ai_gateway:mcp_method)%",
                "mcp.tool.name": "%DYNAMIC_METADATA(io.envoy.ai_gateway:mcp_tool_name)%",
                "mcp.provider.name": "%DYNAMIC_METADATA(io.envoy.ai_gateway:mcp_backend)%",
                "mcp.session.id": "%DYNAMIC_METADATA(io.envoy.ai_gateway:mcp_session_id)%",
                "genio.subject.id": "%DYNAMIC_METADATA(genio.one.processor:x-genio-trusted-subject-id)%",
                "genio.client.id": "%DYNAMIC_METADATA(genio.one.processor:x-genio-trusted-client-id)%",
                "genio.processor.bundle_revision": "%DYNAMIC_METADATA(genio.one.processor:bundle_revision)%",
                "genio.processor.request_steps": "%DYNAMIC_METADATA(genio.one.processor:request_steps)%",
                "genio.processor.response_steps": "%DYNAMIC_METADATA(genio.one.processor:response_steps)%",
                "genio.processor.data_classifications": "%DYNAMIC_METADATA(genio.one.processor:data_classifications)%",
                "genio.processor.safety_decisions": "%DYNAMIC_METADATA(genio.one.processor:safety_decisions)%",
                start_time: "%START_TIME%",
                method: "%REQ(:METHOD)%",
                path: "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%",
                response_code: "%RESPONSE_CODE%",
                response_flags: "%RESPONSE_FLAGS%",
                response_code_details: "%RESPONSE_CODE_DETAILS%",
                duration: "%DURATION%",
                "x-request-id": "%REQ(X-REQUEST-ID)%",
                authority: "%REQ(:AUTHORITY)%",
                route_name: "%ROUTE_NAME%",
                upstream_cluster: "%UPSTREAM_CLUSTER%",
                upstream_host: "%UPSTREAM_HOST%",
                upstream_hosts_attempted: "%UPSTREAM_HOSTS_ATTEMPTED%",
                upstream_request_attempt_count: "%UPSTREAM_REQUEST_ATTEMPT_COUNT%",
                },
              },
            },
          ],
        },
      },
    },
  }
}

function gatewayConfigName(gatewayId: string): string {
  return kubernetesName(`${gatewayId}-config`, "GatewayConfig")
}

/**
 * Envoy AI Gateway owns GenAI tracing and message-content capture. Keep its
 * process configuration in the native GatewayConfig instead of adding a
 * GenioOne processor step or storing prompt content in the Control Plane.
 */
function gatewayConfigResource(input: {
  gatewayId: string
  namespace: string
  tenantId: string
  telemetry?: GatewayServiceReference
}): GatewayNativeResource {
  const telemetryHost = input.telemetry?.host ??
    (input.telemetry
      ? `${kubernetesName(input.telemetry.name, "backend")}.${input.telemetry.namespace ?? input.namespace}.svc.cluster.local`
      : undefined)
  const env = [
    { name: "AI_GATEWAY_TRACING_SEMCONV", value: "gen_ai" },
    {
      // The GatewayConfig is rendered per tenant gateway.  Pin the tenant on
      // the AIGW resource so detail queries can enforce tenant isolation even
      // when auth response headers are not propagated across an internal hop.
      name: "OTEL_RESOURCE_ATTRIBUTES",
      value: `genio.tenant.id=${input.tenantId}`,
    },
    // `aigw run` consumes these environment variables and translates them to
    // extProc flags.  Kubernetes uses the pinned controller's
    // `requestHeaderAttributes` chart value for the same mapping because its
    // injected extProc receives command-line flags.
    {
      name: "OTEL_AIGW_SPAN_REQUEST_HEADER_ATTRIBUTES",
      value: "x-request-id:genio.correlation.id,x-genio-correlation-id:genio.correlation.id,x-genio-trusted-tenant-id:genio.tenant.id",
    },
    {
      name: "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
      value: "true",
    },
    ...(input.telemetry && telemetryHost
      ? [{
          name: "OTEL_EXPORTER_OTLP_ENDPOINT",
          // The GatewayConfig controls the AIGW extProc's OTLP exporter.
          // Pin HTTP/protobuf explicitly; the OTel SDK default is otherwise
          // exporter-dependent and may select gRPC on port 4317.
          value: `http://${telemetryHost}:${input.telemetry.httpPort ?? 4318}`,
        }, {
          name: "OTEL_TRACES_EXPORTER",
          value: "otlp",
        }, {
          name: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
          // The Go autoexporter treats the signal-specific endpoint as the
          // complete HTTP URL.  Keep the OTLP trace path explicit; otherwise
          // it posts to `/` and the Collector returns 404.
          value: `http://${telemetryHost}:${input.telemetry.httpPort ?? 4318}/v1/traces`,
        }, {
          name: "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
          value: "http/protobuf",
        }, {
          name: "OTEL_EXPORTER_OTLP_PROTOCOL",
          value: "http/protobuf",
        }]
      : []),
  ]
  return {
    apiVersion: AI_GATEWAY_ROUTE_API_VERSION,
    kind: "GatewayConfig",
    metadata: {
      name: gatewayConfigName(input.gatewayId),
      namespace: input.namespace,
      annotations: {
        "genio.one/global-contract-revision": "2",
      },
      labels: {
        "genio.one/shared-component": "ai-gateway-config",
      },
    },
    spec: {
      extProc: {
        kubernetes: { env },
      },
    },
  }
}

/**
 * Keep a caller-supplied correlation ID, or let Envoy generate one when the
 * caller did not provide it.  The same X-Request-ID is then available to
 * extAuth, extProc, native access logs, Activity and Audit without a GenioOne
 * data-plane filter inventing a second correlation mechanism.
 */
function gatewayCorrelationPolicy(
  gatewayId: string,
  namespace: string,
): GatewayNativeResource {
  return {
    apiVersion: ENVOY_GATEWAY_API_VERSION,
    kind: "ClientTrafficPolicy",
    metadata: {
      name: kubernetesName(`${gatewayId}-correlation`, "ClientTrafficPolicy"),
      namespace,
      annotations: { "genio.one/global-contract-revision": "1" },
      labels: {
        "app.kubernetes.io/managed-by": "genio-one-platform",
      },
    },
    spec: {
      targetRefs: [{
        group: GATEWAY_API_GROUP,
        kind: "Gateway",
        name: gatewayId,
      }],
      connection: { bufferLimit: "4Mi" },
      headers: {
        requestID: "PreserveOrGenerate",
      },
    },
  }
}

function backendReference(
  reference: GatewayServiceReference,
  namespace: string,
): Record<string, unknown> {
  return {
    group: reference.group ?? ENVOY_GATEWAY_GROUP,
    kind: reference.kind ?? "Backend",
    name: kubernetesName(reference.name, "backend"),
    namespace: reference.namespace ?? namespace,
    port: reference.port,
  }
}

function backendEndpoint(host: string, port: number): Record<string, unknown> {
  return isIP(host)
    ? { ip: { address: host, port } }
    : { fqdn: { hostname: host, port } }
}

function sidecarBackend(
  reference: GatewayServiceReference,
  namespace: string,
): GatewayNativeResource | undefined {
  if (
    (reference.group ?? ENVOY_GATEWAY_GROUP) !== ENVOY_GATEWAY_GROUP ||
    (reference.kind ?? "Backend") !== "Backend"
  ) {
    return undefined
  }
  const host = reference.host ?? `${kubernetesName(reference.name, "backend")}.${reference.namespace ?? namespace}.svc.cluster.local`
  return {
    apiVersion: ENVOY_GATEWAY_API_VERSION,
    kind: "Backend",
    metadata: {
      name: kubernetesName(reference.name, "backend"),
      namespace: reference.namespace ?? namespace,
      labels: {
        "genio.one/shared-component": kubernetesName(reference.name, "backend"),
      },
    },
    spec: { endpoints: [backendEndpoint(host, reference.port)] },
  }
}

function connectionBackend(
  connection: {
    connection_id: string
    endpoint: string
    mcp_tool_namespace?: string | null
    certificate?: ConnectionRegistration["certificate"]
  },
  resourceId: string,
  namespace: string,
  revision: number,
): { backend: GatewayNativeResource; caBundle?: GatewayNativeResource; parsed: ParsedEndpoint; name: string } {
  const parsed = parseEndpoint(connection.endpoint)
  const name = kubernetesName(
    connection.mcp_tool_namespace ?? `${resourceId}-${connection.connection_id}-backend`,
    "backend",
  )
  const caBundleName = connection.certificate?.mode === "CUSTOM_CA"
    ? kubernetesName(`${name}-ca`, "certificate bundle")
    : undefined
  const tls = parsed.secure
    ? {
        ecdhCurves: [...UPSTREAM_TLS_ECDH_CURVES],
        sni: isIP(parsed.host) ? undefined : parsed.host,
        ...(connection.certificate?.mode === "CUSTOM_CA" && caBundleName
          ? { caCertificateRefs: [{ group: "", kind: "ConfigMap", name: caBundleName }] }
          : { wellKnownCACertificates: "System" }),
      }
    : undefined
  const caBundle = connection.certificate?.mode === "CUSTOM_CA" && caBundleName && connection.certificate.certificate_pem
    ? {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: caBundleName,
          namespace,
          labels: labels(resourceId, revision),
        },
        data: { "ca.crt": connection.certificate.certificate_pem },
      } as unknown as GatewayNativeResource
    : undefined
  return {
    name,
    parsed,
    backend: nativeResource(
      ENVOY_GATEWAY_API_VERSION,
      "Backend",
      name,
      namespace,
      resourceId,
      revision,
      {
        endpoints: [backendEndpoint(parsed.host, parsed.port)],
        ...(tls ? { tls: Object.fromEntries(Object.entries(tls).filter(([, value]) => value !== undefined)) } : {}),
      },
    ),
    ...(caBundle ? { caBundle } : {}),
  }
}

function providerSchemaPrefix(parsed: ParsedEndpoint): Record<string, string> {
  return parsed.pathPrefix ? { prefix: parsed.pathPrefix } : {}
}

function aiServiceBackend(
  connection: {
    connection_id: string
    provider_credential_profile?: {
      profile_id: string
      revision: number
      strategy_digest: string
    } | null
  },
  backendName: string,
  parsed: ParsedEndpoint,
  providerProfile: { provider_type: string },
  resourceId: string,
  namespace: string,
  revision: number,
): GatewayNativeResource {
  if (!["GENERIC_OPENAI_COMPATIBLE", "OPENAI", "OMLX", "OLLAMA", "GCP_VERTEX_AI"].includes(providerProfile.provider_type)) {
    throw new PlatformApiError("UNSUPPORTED_AI_PROVIDER_PROFILE", 422)
  }
  const name = kubernetesName(`${resourceId}-${connection.connection_id}-ai`, "ai service backend")
  return nativeResource(
    AI_GATEWAY_ROUTE_API_VERSION,
    "AIServiceBackend",
    name,
    namespace,
    resourceId,
    revision,
    {
      schema: {
        name: providerProfile.provider_type === "GCP_VERTEX_AI" ? "GCPVertexAI" : "OpenAI",
        ...providerSchemaPrefix(parsed),
      },
      backendRef: {
        name: backendName,
        kind: "Backend",
        group: ENVOY_GATEWAY_GROUP,
        namespace,
      },
    },
    {
      "genio.one/connection-id": connection.connection_id,
      "genio.one/provider-id": providerProfile.provider_type,
      ...(connection.provider_credential_profile ? {
        "genio.one/provider-credential-profile-id": connection.provider_credential_profile.profile_id,
        "genio.one/provider-credential-profile-revision": String(connection.provider_credential_profile.revision),
        "genio.one/provider-credential-strategy-digest": connection.provider_credential_profile.strategy_digest,
      } : {}),
    },
  )
}

function backendSecurityPolicy(
  connection: ConnectionRegistration,
  profile: ProviderCredentialProfileRevision | undefined,
  aiServiceBackendName: string,
  resourceId: string,
  namespace: string,
  revision: number,
): GatewayNativeResource | undefined {
  const credentialRef = profile?.strategy.kind === "STATIC_SECRET_REFERENCE"
    ? profile.strategy.secret_ref
    : profile?.strategy.kind === "OIDC_FEDERATION"
      ? profile.strategy.source.client_secret_ref
      : connection.credential_ref
  const gcpApplicationDefault = profile?.strategy.kind === "RUNTIME_IDENTITY"
    ? profile.strategy.parameters
    : undefined
  if (!credentialRef && !gcpApplicationDefault) return undefined
  const name = kubernetesName(`${resourceId}-${connection.connection_id}-credentials`, "backend security policy")
  const gcpWorkloadIdentity = profile?.strategy.kind === "OIDC_FEDERATION"
    ? {
        project_name: profile.strategy.exchange.project_name,
        region: profile.strategy.exchange.region,
        project_id: profile.strategy.exchange.project_id,
        workload_identity_pool_name: profile.strategy.exchange.workload_identity_pool_name,
        workload_identity_provider_name: profile.strategy.exchange.workload_identity_provider_name,
        service_account_name: profile.strategy.exchange.service_account_name,
        oidc_issuer: profile.strategy.source.issuer,
        oidc_client_id: profile.strategy.source.client_id,
        oidc_audience: profile.strategy.source.audience,
      }
    : undefined
  const spec = gcpWorkloadIdentity
    ? {
        targetRefs: [
          {
            group: AI_GATEWAY_GROUP,
            kind: "AIServiceBackend",
            name: aiServiceBackendName,
          },
        ],
        type: "GCPCredentials",
        gcpCredentials: {
          projectName: gcpWorkloadIdentity.project_name,
          region: gcpWorkloadIdentity.region,
          workloadIdentityFederationConfig: {
            projectID: gcpWorkloadIdentity.project_id,
            workloadIdentityPoolName: gcpWorkloadIdentity.workload_identity_pool_name,
            workloadIdentityProviderName: gcpWorkloadIdentity.workload_identity_provider_name,
            ...(gcpWorkloadIdentity.service_account_name
              ? {
                  serviceAccountImpersonation: {
                    serviceAccountName: gcpWorkloadIdentity.service_account_name,
                  },
                }
              : {}),
            oidcExchangeToken: {
              oidc: {
                provider: { issuer: gcpWorkloadIdentity.oidc_issuer },
                clientID: gcpWorkloadIdentity.oidc_client_id,
                clientSecret: {
                  name: kubernetesName(credentialRef!, "credential secret"),
                  namespace,
                },
              },
              ...(gcpWorkloadIdentity.oidc_audience ? { aud: gcpWorkloadIdentity.oidc_audience } : {}),
            },
          },
        },
      }
    : gcpApplicationDefault
      ? {
          targetRefs: [
            {
              group: AI_GATEWAY_GROUP,
              kind: "AIServiceBackend",
              name: aiServiceBackendName,
            },
          ],
          type: "GCPCredentials",
          gcpCredentials: {
            projectName: gcpApplicationDefault.project_name,
            region: gcpApplicationDefault.region,
            ...(profile?.credential_configured ? { credentialsFile: { secretRef: { name: providerCredentialSecretName(profile.tenant_id, profile.profile_id, profile.revision), namespace } } } : {}),
          },
        }
      : {
        targetRefs: [
          {
            group: AI_GATEWAY_GROUP,
            kind: "AIServiceBackend",
            name: aiServiceBackendName,
          },
        ],
        type: "APIKey",
        apiKey: {
          secretRef: {
            name: kubernetesName(credentialRef!, "credential secret"),
            kind: "Secret",
          },
        },
      }
  const resource = nativeResource(
    AI_GATEWAY_ROUTE_API_VERSION,
    "BackendSecurityPolicy",
    name,
    namespace,
    resourceId,
    revision,
    spec,
  )
  if (profile?.credential_configured) {
    resource.metadata.annotations = { ...resource.metadata.annotations, "genio.one/credential-material-profile": profile.profile_id, "genio.one/credential-material-revision": String(profile.revision) }
  }
  return resource
}

function boundProviderCredentialProfile(
  snapshot: GatewayProjectionSnapshot,
  connection: ConnectionRegistration,
): ProviderCredentialProfileRevision | undefined {
  const binding = connection.provider_credential_profile
  if (!binding) return undefined
  if (
    connection.downstream_identity.mode !== "SERVICE" ||
    connection.downstream_identity.authentication !== "PROVIDER_CREDENTIAL_PROFILE"
  ) {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_IDENTITY_MISMATCH", 422)
  }
  const profile = snapshot.provider_credential_profiles?.find((candidate) =>
    candidate.profile_id === binding.profile_id && candidate.revision === binding.revision)
  if (
    !profile ||
    profile.state !== "ACTIVE" ||
    profile.strategy_digest !== binding.strategy_digest
  ) {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_SNAPSHOT_MISMATCH", 422)
  }
  return profile
}

function routeRule(
  model: { model_id: string; model_name: string },
  mappings: Array<{
    public_model_id: string
    connection_id: string
    provider_model: string
  }>,
  aiServiceBackendByConnection: Map<string, string>,
  routingPriorityByConnection: ReadonlyMap<string, number>,
): Record<string, unknown> {
  const backendRefs = mappings
    .filter((mapping) => mapping.public_model_id === model.model_id)
    .sort((left, right) =>
      (routingPriorityByConnection.get(left.connection_id) ?? 0) -
        (routingPriorityByConnection.get(right.connection_id) ?? 0) ||
      compareUtf8(left.connection_id, right.connection_id),
    )
    .map((mapping) => {
      const backendName = aiServiceBackendByConnection.get(mapping.connection_id)
      if (!backendName) throw new PlatformApiError("MODEL_CONNECTION_NOT_PROJECTED", 422)
      return {
        name: backendName,
        modelNameOverride: mapping.provider_model,
        priority: routingPriorityByConnection.get(mapping.connection_id) ?? 0,
      }
    })
  if (backendRefs.length === 0) {
    throw new PlatformApiError("MODEL_CONNECTION_MAPPING_REQUIRED", 422)
  }
  return {
    matches: [
      {
        headers: [
          {
            type: "Exact",
            name: "x-ai-eg-model",
            value: model.model_name,
          },
        ],
      },
    ],
    backendRefs,
  }
}

type ApiMappingRule = NonNullable<GatewayProjectionSnapshot["connections"][number]["request_mapping"]>["rules"][number]

function effectiveApiRules(
  rules: readonly ApiMappingRule[],
  operationId: string,
  location: ApiMappingRule["location"],
): ApiMappingRule[] {
  const effective = new Map<string, ApiMappingRule>()
  for (const rule of rules) {
    if (rule.location === location && rule.operation_id === null) effective.set(rule.name, rule)
  }
  for (const rule of rules) {
    if (rule.location === location && rule.operation_id === operationId) effective.set(rule.name, rule)
  }
  return [...effective.values()].sort((left, right) => compareUtf8(left.name, right.name))
}

function apiHeaderFilter(rules: readonly ApiMappingRule[]): Record<string, unknown> | null {
  const set = rules
    .filter((rule) => rule.action === "SET")
    .map((rule) => ({ name: rule.name, value: rule.value! }))
  const remove = rules
    .filter((rule) => rule.action === "REMOVE")
    .map((rule) => rule.name)
  if (!set.length && !remove.length) return null
  return {
    type: "RequestHeaderModifier",
    requestHeaderModifier: {
      ...(set.length ? { set } : {}),
      ...(remove.length ? { remove } : {}),
    },
  }
}

function apiOperationMatch(
  publicPath: string,
  operation: { method: string; path: string },
): Record<string, unknown> {
  const joined = `${publicPath === "/" ? "" : publicPath}${operation.path}` || "/"
  const templateIndex = joined.indexOf("{")
  return {
    method: operation.method,
    path: templateIndex < 0
      ? { type: "Exact", value: joined }
      : { type: "PathPrefix", value: joined.slice(0, templateIndex).replace(/\/$/, "") || "/" },
  }
}

function apiOperationRewrite(
  upstreamPathPrefix: string | undefined,
  operationPath: string,
): Record<string, unknown> {
  const upstreamBase = upstreamPathPrefix ? `/${upstreamPathPrefix}` : ""
  const templateIndex = operationPath.indexOf("{")
  if (templateIndex < 0) {
    return {
      type: "ReplaceFullPath",
      replaceFullPath: `${upstreamBase}${operationPath}` || "/",
    }
  }
  const operationPrefix = operationPath.slice(0, templateIndex).replace(/\/$/, "")
  return {
    type: "ReplacePrefixMatch",
    replacePrefixMatch: `${upstreamBase}${operationPrefix}` || "/",
  }
}

function apiQueryMappingLua(
  mapping: NonNullable<GatewayProjectionSnapshot["connections"][number]["request_mapping"]>,
  operations: NonNullable<GatewayProjectionSnapshot["resource"]["api"]>["operations"],
  publicPath: string,
): string {
  const byOperation = new Map(operations.map((operation) => [operation.operation_id, operation]))
  const rules = mapping.rules.flatMap((rule) => {
    if (rule.location !== "QUERY" || rule.action === "PASSTHROUGH") return []
    const operation = rule.operation_id === null ? null : byOperation.get(rule.operation_id)
    if (rule.operation_id !== null && !operation) {
      throw new PlatformApiError("API_REQUEST_MAPPING_OPERATION_NOT_FOUND", 422)
    }
    const joined = operation
      ? `${publicPath === "/" ? "" : publicPath}${operation.path}` || "/"
      : null
    const templateIndex = joined?.indexOf("{") ?? -1
    return [{
      method: operation?.method ?? null,
      path: joined === null ? null : templateIndex < 0 ? joined : joined.slice(0, templateIndex).replace(/\/$/, "") || "/",
      prefix: joined !== null && templateIndex >= 0,
      name: rule.name,
      action: rule.action,
      value: rule.value,
    }]
  })
  if (!rules.length) return ""
  const luaRules = rules.map((rule) => `{method=${rule.method === null ? "nil" : JSON.stringify(rule.method)},path=${rule.path === null ? "nil" : JSON.stringify(rule.path)},prefix=${rule.prefix ? "true" : "false"},name=${JSON.stringify(rule.name)},action=${JSON.stringify(rule.action)},value=${rule.value === null ? "nil" : JSON.stringify(rule.value)}}`).join(",")
  return `
local api_query_rules = {${luaRules}}

local function api_percent_encode(value)
  return string.gsub(value, "([^%w%-_%.~])", function(char)
    return string.format("%%%02X", string.byte(char))
  end)
end

local function apply_api_query_rule(headers, rule)
  local request_path = headers:get(":path") or "/"
  local path_only, query = string.match(request_path, "^([^?]*)%??(.*)$")
  local method = headers:get(":method") or "GET"
  if rule.method ~= nil and method ~= rule.method then return end
  if rule.path ~= nil then
    if rule.prefix and string.sub(path_only, 1, string.len(rule.path)) ~= rule.path then return end
    if not rule.prefix and path_only ~= rule.path then return end
  end
  local encoded_name = api_percent_encode(rule.name)
  local kept = {}
  for part in string.gmatch(query, "([^&]+)") do
    local name = string.match(part, "^([^=]*)") or ""
    if name ~= encoded_name then table.insert(kept, part) end
  end
  if rule.action == "SET" then
    table.insert(kept, encoded_name .. "=" .. api_percent_encode(rule.value))
  end
  headers:replace(":path", path_only .. (#kept > 0 and "?" .. table.concat(kept, "&") or ""))
end

local function apply_api_query_mapping(handle)
  for _, rule in ipairs(api_query_rules) do apply_api_query_rule(handle:headers(), rule) end
end
`
}

function authorizationPolicy(
  routeName: string,
  reference: GatewayServiceReference,
  jwtConfig: NativeJwtAuthenticationConfig,
  tenantId: string,
  resourceId: string,
  capabilityId: string,
  requestProtocol: "LLM" | "MCP" | "API" | "A2A",
  a2a: { operation: "SEND_MESSAGE" | "SEND_STREAMING_MESSAGE"; target_agent_subject_id: string } | undefined,
  chainId: string,
  namespace: string,
  revision: number,
  options: Required<Pick<GatewayProjectionRendererOptions, "extAuthTimeout">> &
    Pick<GatewayProjectionRendererOptions, "jwtRemoteJwksUri">,
): GatewayNativeResource {
  return nativeResource(
    ENVOY_GATEWAY_API_VERSION,
    "SecurityPolicy",
    `${routeName}-authorization`,
    namespace,
    resourceId,
    revision,
    {
      targetRefs: [
        {
          group: GATEWAY_API_GROUP,
          kind: "HTTPRoute",
          name: routeName,
        },
      ],
      jwt: {
        // Native JWT authentication establishes the verified identity before
        // One Policy extAuth is called.  The claim-derived headers below are
        // overwritten by Envoy's JWT filter; caller-supplied x-genio-* headers
        // are never accepted as identity input.
        optional: false,
        providers: [
          {
            name: jwtConfig.provider,
            issuer: jwtConfig.issuer,
            audiences: jwtConfig.audiences,
            remoteJWKS: {
              uri: options.jwtRemoteJwksUri ?? jwtConfig.remote_jwks_uri,
            },
            claimToHeaders: [
              { claim: jwtConfig.subject_claim, header: "x-genio-verified-subject" },
              { claim: jwtConfig.client_claim, header: "x-genio-verified-client" },
            ],
          },
        ],
      },
      extAuth: authorizationExtAuth(
        reference,
        tenantId,
        resourceId,
        capabilityId,
        requestProtocol,
        a2a,
        chainId,
        namespace,
        options,
      ),
    },
  )
}

function validateApiOAuthProjection(
  api: NonNullable<GatewayProjectionSnapshot["resource"]["api"]>,
  jwt: NativeJwtAuthenticationConfig | undefined,
): void {
  if (api.inbound_security.type !== "OAUTH2") return
  const issuer = api.inbound_security.issuer.trim().replace(/\/$/, "")
  const jwksUrl = api.inbound_security.jwks_url.trim()
  const audience = api.inbound_security.audience.trim()
  if (
    !jwt ||
    (issuer !== "" && jwt.issuer.replace(/\/$/, "") !== issuer) ||
    (jwksUrl !== "" && jwt.remote_jwks_uri !== jwksUrl) ||
    (audience !== "" && !jwt.audiences.includes(audience))
  ) {
    throw new PlatformApiError("API_OAUTH_ENFORCEMENT_MISMATCH", 422)
  }
}

function authorizationExtAuth(
  reference: GatewayServiceReference,
  tenantId: string,
  resourceId: string,
  capabilityId: string,
  requestProtocol: "LLM" | "MCP" | "API" | "A2A",
  a2a: { operation: "SEND_MESSAGE" | "SEND_STREAMING_MESSAGE"; target_agent_subject_id: string } | undefined,
  chainId: string,
  namespace: string,
  options: Required<Pick<GatewayProjectionRendererOptions, "extAuthTimeout">>,
): Record<string, unknown> {
  return {
    // LLM model and MCP method/tool live in their respective request bodies.
    // A bounded body is sent only to the local authorizer; AIGW remains the
    // owner of protocol parsing, translation and routing.
    bodyToExtAuth: { maxRequestBytes: 4_194_304 },
    // Compiler-owned context never comes from caller-supplied x-genio-* headers.
    contextExtensions: [
      { name: "tenant_id", type: "Value", value: tenantId },
      { name: "resource_id", type: "Value", value: resourceId },
      { name: "capability_id", type: "Value", value: capabilityId },
      { name: "request_protocol", type: "Value", value: requestProtocol },
      ...(a2a ? [
        { name: "a2a_operation", type: "Value", value: a2a.operation },
        { name: "target_agent_subject_id", type: "Value", value: a2a.target_agent_subject_id },
      ] : []),
      { name: "enforcement_chain_id", type: "Value", value: chainId },
    ],
    // Native authentication overwrites the verified identity headers. Reserved
    // trusted headers are included only so the authorizer can reject spoofing.
    headersToExtAuth: [
      "content-type",
      "x-genio-verified-subject",
      "x-genio-verified-client",
      "x-request-id",
      "x-genio-correlation-id",
      "x-genio-organization-id",
      "x-genio-use-case-id",
      "x-genio-on-behalf-of-subject-id",
      "x-genio-execution-grant-id",
      "x-genio-trusted-tenant-id",
      "x-genio-trusted-subject-id",
      "x-genio-trusted-client-id",
      "x-genio-trusted-resource-id",
      "x-genio-trusted-capability-id",
      "x-genio-trusted-correlation-id",
    ],
    grpc: {
      backendRefs: [backendReference(reference, namespace)],
    },
    timeout: options.extAuthTimeout,
    failOpen: false,
    includeRouteMetadata: true,
    statusOnError: 503,
  }
}

interface ProcessorBridgeProjection {
  policy: GatewayNativeResource
  backend?: GatewayNativeResource
  grpcBackend?: GatewayNativeResource
  route?: GatewayNativeResource
}

function extensionPolicy(
  chain: CompiledEnforcementChain,
  processorReference: GatewayServiceReference,
  processorGrpcReference: GatewayServiceReference,
  routeName: string,
  gatewayId: string,
  resourceId: string,
  namespace: string,
  revision: number,
  requireRoutingBody: boolean,
  requestPreludeLua = "",
  targetRouteNames: readonly string[] = [routeName],
): ProcessorBridgeProjection | undefined {
  const processSteps = chain.steps
    .filter((step) => step.kind === "PROCESS")
  if (processSteps.length === 0 && !requireRoutingBody && !requestPreludeLua) return undefined

  const processorRequestEnabled = requireRoutingBody ||
    processSteps.some((step) => Boolean(step.hooks.request))
  // LLM projections always carry the bidirectional Processor seam so a later
  // immutable One Policy revision can add response hooks without rebuilding
  // the Resource publication topology.
  const responseEnabled = requireRoutingBody ||
    processSteps.some((step) => Boolean(step.hooks.response))
  const requestEnabled = processorRequestEnabled || Boolean(requestPreludeLua) || responseEnabled
  if (!processorRequestEnabled && !responseEnabled) {
    return {
      policy: nativeResource(
        ENVOY_GATEWAY_API_VERSION,
        "EnvoyExtensionPolicy",
        `${routeName}-processing`,
        namespace,
        resourceId,
        revision,
        {
          targetRefs: targetRouteNames.map((targetRouteName) => ({
            group: GATEWAY_API_GROUP,
            kind: "HTTPRoute",
            name: targetRouteName,
          })),
          lua: [{
            type: "Inline",
            inline: `${requestPreludeLua}\nfunction envoy_on_request(handle)\n  apply_api_query_mapping(handle)\nend\n`,
          }],
        },
        { "genio.one/process-steps": "" },
      ),
    }
  }
  const contextHeaders = [
    "x-genio-trusted-tenant-id",
    "x-genio-trusted-subject-id",
    "x-genio-trusted-client-id",
    "x-genio-trusted-resource-id",
    "x-genio-trusted-capability-id",
    "x-genio-trusted-correlation-id",
    "x-genio-trusted-consumer-organization-id",
    "x-genio-trusted-use-case-id",
    "x-genio-trusted-resource-owner-organization-id",
    "x-genio-trusted-release-id",
    "x-genio-trusted-release-gateway-id",
    "x-genio-trusted-release-head-revision",
    "x-genio-trusted-release-package-digest",
    "x-genio-trusted-release-projection-count",
    "x-genio-bundle-revision",
    "x-genio-session-id",
    "x-genio-allowed-public-models",
    "x-genio-usage-admission-id",
    "x-genio-usage-accounting-keys",
    "x-genio-usage-concurrency-leases",
    "x-genio-usage-policy-revisions",
    "x-genio-usage-currency-allocations",
    "x-request-id",
  ]
  const internalHeaders = contextHeaders.filter((header) => header !== "x-request-id")
  const bridgeRouteName = kubernetesName(`${routeName}-processor-bridge`, "HTTPRoute")
  const processorBackend = sidecarBackend(processorReference, namespace)
  if (!processorBackend) throw new Error("processor HTTP Backend could not be projected")
  const processorGrpcBackend = sidecarBackend(processorGrpcReference, namespace)
  if (!processorGrpcBackend) throw new Error("processor gRPC Backend could not be projected")
  const processorCluster = `httproute/${namespace}/${bridgeRouteName}/rule/0`
  const luaArray = (values: readonly string[]) =>
    `{${values.map((value) => JSON.stringify(value)).join(",")}}`
  const lua = `
local cluster = ${JSON.stringify(processorCluster)}
local namespace = "genio.one.processor"
local safety_decisions_header = ${JSON.stringify(PROCESSOR_SAFETY_DECISIONS_HEADER)}
local context_headers = ${luaArray(contextHeaders)}
local internal_headers = ${luaArray([...internalHeaders, ...MODEL_ROUTE_HANDOFF_HEADERS, PROCESSOR_SAFETY_DECISIONS_HEADER])}
local route_headers = ${luaArray(MODEL_ROUTE_HANDOFF_HEADERS)}

local function fail(handle, status, body)
  handle:respond({[":status"] = status, ["content-type"] = "application/json"}, body)
end

local function request_headers(handle, path)
  local source = handle:headers()
  local outgoing = {
    [":method"] = "POST",
    [":path"] = path,
    [":authority"] = cluster,
    ["content-type"] = source:get("content-type") or "application/json",
    ["x-genio-original-method"] = source:get(":method") or "POST",
    ["x-genio-original-path"] = source:get(":path") or "/"
  }
  local metadata = handle:streamInfo():dynamicMetadata()
  for _, name in ipairs(context_headers) do
    local value = source:get(name)
    if value ~= nil and value ~= "" then
      outgoing[name] = value
      metadata:set(namespace, name, value)
    end
  end
  return outgoing
end

local function response_headers(handle, path)
  local outgoing = {
    [":method"] = "POST",
    [":path"] = path,
    [":authority"] = cluster,
    ["content-type"] = handle:headers():get("content-type") or "application/json"
  }
  local values = handle:streamInfo():dynamicMetadata():get(namespace) or {}
  for _, name in ipairs(context_headers) do
    local value = values[name]
    if value ~= nil and value ~= "" then outgoing[name] = value end
  end
  local safety_decisions = values["safety_decisions"]
  if safety_decisions ~= nil and safety_decisions ~= "" then
    outgoing[safety_decisions_header] = safety_decisions
  end
  return outgoing
end

local function record_receipt(handle, headers, direction)
  local metadata = handle:streamInfo():dynamicMetadata()
  local revision = headers["x-genio-processor-bundle-revision"]
  local steps = headers["x-genio-processor-steps"]
  local safety_decisions = headers[safety_decisions_header]
  if revision ~= nil then metadata:set(namespace, "bundle_revision", revision) end
  if steps ~= nil then metadata:set(namespace, direction .. "_steps", steps) end
  if safety_decisions ~= nil and safety_decisions ~= "" then
    metadata:set(namespace, "safety_decisions", safety_decisions)
    if direction == "request" then handle:headers():replace(safety_decisions_header, safety_decisions) end
  end
  if direction == "request" then
    for _, name in ipairs(route_headers) do
      local value = headers[name]
      if value ~= nil and value ~= "" then
        handle:headers():replace(name, value)
        metadata:set(namespace, name, value)
      end
    end
    local public_model = headers[${JSON.stringify(ROUTE_PUBLIC_MODEL_HEADER)}]
    if public_model ~= nil and public_model ~= "" then
      handle:headers():replace("x-ai-eg-model", public_model)
      handle:headers():remove(${JSON.stringify(ROUTE_PUBLIC_MODEL_HEADER)})
    end
  end
end

${requestPreludeLua}

${requestEnabled ? `function envoy_on_request(handle)
  ${requestPreludeLua ? "apply_api_query_mapping(handle)" : ""}
  handle:headers():remove(safety_decisions_header)
  ${processorRequestEnabled ? `
  local original_body = handle:body(true)
  local correlation = handle:headers():get("x-genio-trusted-correlation-id")
  handle:headers():remove("x-genio-correlation-id")
  if correlation ~= nil and correlation ~= "" then
    handle:headers():add("x-genio-correlation-id", correlation)
  end
  local value = original_body:getBytes(0, original_body:length())
  local headers, transformed = handle:httpCall(
    cluster,
    request_headers(handle, "/v1/process/request"),
    value,
    35000
  )
  if headers[":status"] ~= "200" then
    record_receipt(handle, headers, "request")
    fail(handle, headers[":status"] or "503", transformed or "{\\"code\\":\\"PROCESSOR_UNAVAILABLE\\"}")
    return
  end
  record_receipt(handle, headers, "request")
  transformed = transformed or ""
  -- httpCall yields the Lua coroutine. Reacquire stream objects after it.
  handle:body(true):setBytes(transformed)
  handle:headers():replace("content-length", tostring(#transformed))
  -- ext_proc consumes and removes internal handoff headers after Lua. Keeping
  -- them until that filter runs lets the same stream carry verified context
  -- into incremental response processing.
  ` : ""}
end` : ""}
`

  return {
    backend: processorBackend,
    grpcBackend: processorGrpcBackend,
    route: nativeResource(
      "gateway.networking.k8s.io/v1",
      "HTTPRoute",
      bridgeRouteName,
      namespace,
      resourceId,
      revision,
      {
        parentRefs: [{ group: GATEWAY_API_GROUP, kind: "Gateway", name: gatewayId }],
        hostnames: [`${bridgeRouteName}.internal.invalid`],
        rules: [{
          matches: [{ path: { type: "PathPrefix", value: "/v1/process/" } }],
          backendRefs: [backendReference(processorReference, namespace)],
        }],
      },
    ),
    policy: nativeResource(
      ENVOY_GATEWAY_API_VERSION,
      "EnvoyExtensionPolicy",
      `${routeName}-processing`,
      namespace,
      resourceId,
      revision,
      {
        targetRefs: targetRouteNames.map((targetRouteName) => ({
            group: GATEWAY_API_GROUP,
            kind: "HTTPRoute",
            name: targetRouteName,
          })),
        ...(requestEnabled ? { lua: [{ type: "Inline", inline: lua }] } : {}),
        ...(responseEnabled ? {
          extProc: [{
            failOpen: false,
            metadata: {
              writableNamespaces: ["genio.one.processor"],
            },
            backendRefs: [backendReference(processorGrpcReference, namespace)],
            messageTimeout: "35s",
            processingMode: {
              allowModeOverride: true,
              request: {},
              response: { body: "Streamed" },
            },
          }],
        } : {}),
      },
      {
        "genio.one/process-steps": processSteps.map((step) => step.step_id).join(","),
      },
    ),
  }
}

export interface GatewayProjectorMemoryOptions
  extends GatewayProjectionRendererOptions {
  /** Reads the server-created immutable Publication review snapshot. */
  source: GatewayProjectionSource
}

export function createInMemoryGatewayProjector(
  options: GatewayProjectorMemoryOptions,
): GatewayProjector {
  const rendererOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    aigwRootPrefix: options.aigwRootPrefix ?? DEFAULT_OPTIONS.aigwRootPrefix,
    extAuth: { ...DEFAULT_OPTIONS.extAuth, ...options.extAuth },
    processor: { ...DEFAULT_OPTIONS.processor, ...options.processor },
    processorGrpc: { ...DEFAULT_OPTIONS.processorGrpc, ...options.processorGrpc },
    telemetry: options.telemetry ? { ...options.telemetry } : undefined,
  }
  const allowEphemeralSigner =
    rendererOptions.allowEphemeralSigner ?? process.env.NODE_ENV !== "production"
  const signer =
    rendererOptions.signer ??
    (allowEphemeralSigner ? createEphemeralEd25519Signer() : undefined)
  if (!signer) {
    throw new PlatformApiError(
      "GATEWAY_PROJECTION_SIGNER_REQUIRED",
      500,
      "A durable Gateway projection signer is required outside explicit test mode",
    )
  }
  if (signer.algorithm !== "Ed25519" || !signer.keyId) {
    throw new PlatformApiError("INVALID_GATEWAY_PROJECTION_SIGNER", 500)
  }

  return {
    async compile(input: { tenantId: string; value: GatewayProjectionRequest }) {
      const snapshot = await options.source.getSnapshot({
        tenantId: input.tenantId,
        publicationId: input.value.publication_id,
      })
      if (!snapshot) throw new PlatformApiError("PUBLICATION_NOT_FOUND", 404)
      if (
        snapshot.tenant_id !== input.tenantId ||
        snapshot.publication_id !== input.value.publication_id
      ) {
        throw new PlatformApiError("PUBLICATION_TENANT_MISMATCH", 422)
      }

      const resource = snapshot.resource
      if (resource.kind !== "LLM" && resource.kind !== "MCP" && resource.kind !== "API") {
        throw new PlatformApiError("AI_GATEWAY_PROJECTION_RESOURCE_UNSUPPORTED", 422)
      }
      const routeCapabilities = resource.kind === "MCP"
        ? resource.capabilities.filter((capability) => !capability.capability_id.startsWith("mcp-tool-"))
        : resource.capabilities
      if (
        routeCapabilities.length !== 1 ||
        routeCapabilities[0]?.capability_id !== snapshot.capability_id
      ) {
        throw new PlatformApiError(
          "AI_GATEWAY_PUBLICATION_CAPABILITY_UNSUPPORTED",
          422,
          "A Gateway Resource requires exactly one route Capability",
        )
      }
      if (
        resource.kind === "API" &&
        (resource.api?.operations.length !== 1 ||
          resource.api.operations[0]?.operation_id !== snapshot.capability_id)
      ) {
        throw new PlatformApiError(
          "API_GATEWAY_OPERATION_FANOUT_PENDING",
          422,
          "The first API Gateway slice publishes one OpenAPI operation per Resource",
        )
      }

      const chain = snapshot.one_policy_chain
      if (chain.tenant_id !== input.tenantId) {
        throw new PlatformApiError("ENFORCEMENT_TENANT_MISMATCH", 422)
      }
      if (chain.resource_id !== snapshot.resource_id) {
        throw new PlatformApiError("ENFORCEMENT_RESOURCE_MISMATCH", 422)
      }
      if (chain.capability_id !== snapshot.capability_id) {
        throw new PlatformApiError("ENFORCEMENT_CAPABILITY_MISMATCH", 422)
      }
      if (chain.one_policy_revision !== snapshot.policy_revision) {
        throw new PlatformApiError("ENFORCEMENT_POLICY_REVISION_MISMATCH", 422)
      }
      const safeChain = safeEnforcementChain(chain)
      validateCompiledEnforcementChainSemantics(safeChain)

      const endpoint = snapshot.publication_endpoint as
        | GatewayProjectionSnapshot["publication_endpoint"]
        | undefined
      const publication = assertPublicationEndpoint(
        endpoint
          ? {
              gateway_id: endpoint.gateway_id,
              hostname: endpoint.hostname,
              base_path: endpoint.base_path,
            }
          : undefined,
      )
      if (resource.kind === "LLM") {
        assertAigwRootPrefix(publication, rendererOptions.aigwRootPrefix)
      }
      const namespace = rendererOptions.namespace
      const routeName = kubernetesName(
        `${snapshot.resource_id}-${snapshot.capability_id}`,
        "route",
      )

      const allConnections = snapshot.connections
      const eligibleConnectionIds = new Set(safeChain.eligible_connection_ids)
      if (allConnections.length === 0) {
        throw new PlatformApiError("RESOURCE_CONNECTION_REQUIRED", 422)
      }
      if (
        new Set(allConnections.map((connection) => connection.connection_id)).size !==
        allConnections.length
      ) {
        throw new PlatformApiError("DUPLICATE_PROJECTION_CONNECTION", 422)
      }
      if (
        allConnections.some(
          (connection) => !eligibleConnectionIds.has(connection.connection_id),
        ) ||
        allConnections.length !== eligibleConnectionIds.size
      ) {
        throw new PlatformApiError("ENFORCEMENT_CONNECTION_CANDIDATES_MISMATCH", 422)
      }
      if (allConnections.some((connection) =>
        connection.status !== "READY" ||
        connection.lifecycle !== "ENABLED" ||
        connection.verification_state !== "VERIFIED" ||
        connection.health_state !== "HEALTHY" ||
        connection.health_observed_at === null ||
        connection.health_source_revision === null ||
        ["EXPIRED", "NOT_YET_VALID", "INVALID"].includes(connection.certificate?.status ?? "")
      )) {
        throw new PlatformApiError("CONNECTION_NOT_READY", 409)
      }
      const requiredObligations = [...new Set(safeChain.steps.flatMap((step) =>
        step.kind === "PROCESS"
          ? [step.hooks.request?.action, step.hooks.response?.action].filter((value): value is string => typeof value === "string")
          : [],
      ))]
      const compatibleConnections = allConnections.filter((connection) =>
        requiredObligations.every((obligation) => connection.supported_obligations.includes(obligation)),
      )
      if (requiredObligations.length > 0 && compatibleConnections.length === 0) {
        throw new PlatformApiError(
          "CONNECTION_MANDATORY_OBLIGATION_UNSUPPORTED",
          409,
          "No projected Connection satisfies the mandatory One Policy obligations",
        )
      }
      const candidateConnections = requiredObligations.length > 0 ? compatibleConnections : allConnections
      const candidateConnectionIds = new Set(candidateConnections.map((connection) => connection.connection_id))
      const routingPriorityByConnection = new Map(candidateConnections.map((connection) => [
        connection.connection_id,
        connection.routing_priority,
      ]))

      const requestedModels = resource.kind === "LLM"
        ? snapshot.models.filter(
            (model) => model.visibility === "PUBLIC" && model.lifecycle === "PUBLISHED",
          )
        : []
      if (resource.kind === "LLM" && requestedModels.length === 0) {
        throw new PlatformApiError("PUBLIC_MODEL_REQUIRED", 422)
      }
      if (resource.kind === "LLM" && requestedModels.length > 15) {
        throw new PlatformApiError("TOO_MANY_AI_GATEWAY_ROUTE_RULES", 422)
      }
      const requestedModelIds = new Set(requestedModels.map((model) => model.model_id))
      const requestedMappings = snapshot.model_mappings.filter((mapping) =>
        requestedModelIds.has(mapping.public_model_id),
      )
      if (
        requestedMappings.some((mapping) => !eligibleConnectionIds.has(mapping.connection_id))
      ) {
        throw new PlatformApiError("MODEL_CONNECTION_NOT_PROJECTED", 422)
      }
      const modelMappings = requestedMappings.filter((mapping) =>
        candidateConnectionIds.has(mapping.connection_id),
      )
      for (const model of requestedModels) {
        for (const connectionId of candidateConnectionIds) {
          if (!modelMappings.some(
            (mapping) =>
              mapping.public_model_id === model.model_id &&
              mapping.connection_id === connectionId,
          )) {
            throw new PlatformApiError("MODEL_CONNECTION_MAPPING_REQUIRED", 422)
          }
        }
      }
      const mappingKeys = modelMappings.map(
        (mapping) => `${mapping.public_model_id}:${mapping.connection_id}`,
      )
      if (new Set(mappingKeys).size !== mappingKeys.length) {
        throw new PlatformApiError("DUPLICATE_MODEL_CONNECTION_MAPPING", 422)
      }
      if (new Set(requestedModels.map((model) => model.model_name)).size !== requestedModels.length) {
        throw new PlatformApiError("DUPLICATE_PUBLIC_MODEL_NAME", 422)
      }

      const connectionBackends: GatewayNativeResource[] = []
      const certificateBundles: GatewayNativeResource[] = []
      const aiServiceBackends: GatewayNativeResource[] = []
      const credentialPolicies: GatewayNativeResource[] = []
      const aiServiceBackendByConnection = new Map<string, string>()
      const mcpBackendRefs: Array<Record<string, unknown>> = []
      let apiBackendReference: Record<string, unknown> | null = null
      let apiEndpoint: ParsedEndpoint | null = null
      for (const connection of [...candidateConnections].sort((left, right) =>
        compareUtf8(left.connection_id, right.connection_id),
      )) {
        const providerCredentialProfile = boundProviderCredentialProfile(snapshot, connection)
        const projected = connectionBackend(
          connection,
          snapshot.resource_id,
          namespace,
          snapshot.endpoint_revision,
        )
        connectionBackends.push(projected.backend)
        if (projected.caBundle) certificateBundles.push(projected.caBundle)
        if (resource.kind === "LLM") {
          const ai = aiServiceBackend(
            connection,
            projected.name,
            projected.parsed,
            { provider_type: connection.provider_type ?? "" },
            snapshot.resource_id,
            namespace,
            snapshot.endpoint_revision,
          )
          aiServiceBackends.push(ai)
          aiServiceBackendByConnection.set(connection.connection_id, ai.metadata.name)
          const securityPolicy = backendSecurityPolicy(
            connection,
            providerCredentialProfile,
            ai.metadata.name,
            snapshot.resource_id,
            namespace,
            snapshot.endpoint_revision,
          )
          if (securityPolicy) credentialPolicies.push(securityPolicy)
        } else if (resource.kind === "MCP") {
          if (connection.connection_kind !== "MCP") {
            throw new PlatformApiError("MCP_CONNECTION_IDENTITY_UNSUPPORTED", 422)
          }
          const mcpCredentialRef = providerCredentialProfile
            ? providerCredentialProfile.strategy.kind === "STATIC_SECRET_REFERENCE"
              ? providerCredentialProfile.strategy.secret_ref
              : null
            : connection.credential_ref
          if (connection.downstream_identity.mode === "SERVICE" && !mcpCredentialRef) {
            throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_ADAPTER_UNSUPPORTED", 422)
          }
          const backendSecurity = connection.downstream_identity.mode === "SERVICE"
            ? {
                apiKey: {
                  secretRef: {
                    name: kubernetesName(mcpCredentialRef!, "credential secret"),
                  },
                },
              }
            : undefined
          const passthroughHeaders = connection.downstream_identity.mode === "USER_PASSTHROUGH"
            ? connection.downstream_identity.forward_headers ?? []
            : ["USER_OAUTH", "USER_PASSWORD"].includes(connection.downstream_identity.mode)
              ? [{
                  name: mcpOAuthHeaderName(connection.connection_id),
                  backendHeader: "Authorization",
                }]
              : []
          if (
            !connection.mcp_tool_selection_operation_id ||
            connection.mcp_selected_tools.length === 0
          ) {
            throw new PlatformApiError("MCP_TOOL_SELECTION_REQUIRED", 422)
          }
          mcpBackendRefs.push({
            name: projected.name,
            kind: "Backend",
            group: ENVOY_GATEWAY_GROUP,
            ...(projected.parsed.pathPrefix ? { path: `/${projected.parsed.pathPrefix}` } : {}),
            ...(backendSecurity ? { securityPolicy: backendSecurity } : {}),
            toolSelector: { include: connection.mcp_selected_tools },
            forwardHeaders: [{ name: "x-request-id" }, ...passthroughHeaders],
          })
        } else {
          if (connection.connection_kind !== "API" || !connection.request_mapping) {
            throw new PlatformApiError("API_CONNECTION_MAPPING_REQUIRED", 422)
          }
          if (apiBackendReference) {
            throw new PlatformApiError("API_CONNECTION_CARDINALITY_UNSUPPORTED", 422)
          }
          apiBackendReference = {
            name: projected.name,
            kind: "Backend",
            group: ENVOY_GATEWAY_GROUP,
            namespace,
          }
          apiEndpoint = projected.parsed
        }
      }

      const apiMetadata = resource.kind === "API" ? resource.api : null
      const authenticateStep = safeChain.steps.find((step) => step.kind === "AUTHENTICATE")
      const jwtConfig = authenticateStep
        ? validateNativeJwtAuthenticationConfig(authenticateStep.config)
        : undefined
      if (apiMetadata) validateApiOAuthProjection(apiMetadata, jwtConfig)
      if (apiMetadata?.a2a) {
        const operation = apiMetadata.operations[0]
        const expectedPath = apiMetadata.a2a.operation === "SEND_MESSAGE" ? "/message:send" : "/message:stream"
        if (operation?.method !== "POST" || operation.path !== expectedPath) {
          throw new PlatformApiError("A2A_OPERATION_MAPPING_INVALID", 422)
        }
      }
      const authorizeStep = safeChain.steps.find((step) => step.kind === "AUTHORIZE")
      const mcpSecurityPolicy = resource.kind === "MCP" && authorizeStep && jwtConfig
        ? {
            oauth: {
              issuer: jwtConfig.issuer,
              audiences: jwtConfig.audiences,
              jwks: {
                remoteJWKS: {
                  uri: rendererOptions.jwtRemoteJwksUri ?? jwtConfig.remote_jwks_uri,
                },
              },
              protectedResourceMetadata: {
                resource: `https://${publication.hostname}${publication.base_path}`,
                scopesSupported: ["genioone-invocation"],
              },
              claimToHeaders: [
                { claim: jwtConfig.subject_claim, header: "x-genio-verified-subject" },
                { claim: jwtConfig.client_claim, header: "x-genio-verified-client" },
              ],
            },
            extAuth: authorizationExtAuth(
              rendererOptions.extAuth,
              input.tenantId,
              snapshot.resource_id,
              snapshot.capability_id,
              "MCP",
              undefined,
              safeChain.chain_id,
              namespace,
              rendererOptions,
            ),
          }
        : undefined
      const sortedModels = [...requestedModels].sort((left, right) =>
        compareUtf8(left.model_name, right.model_name),
      )
      const llmInternalRouteName = kubernetesName(`${routeName}-aigw`, "AIGatewayRoute")
      // `.localhost` is reserved for loopback traffic and is accepted by
      // local OpenAI-compatible providers such as Ollama, whose DNS-rebinding
      // protection rejects arbitrary internal hostnames before AIGW can reach
      // the provider. The listener itself is still not exposed by deployment.
      const llmInternalHostname = `${llmInternalRouteName}.internal.localhost`
      const llmInternalReference: GatewayServiceReference = {
        name: "genio-one-aigw-internal",
        port: 1976,
        group: "",
        kind: "Service",
      }
      const llmInternalBackend = resource.kind === "LLM"
        ? sidecarBackend(llmInternalReference, namespace)
        : undefined
      if (resource.kind === "API" && (!apiMetadata || !apiBackendReference || !apiEndpoint)) {
        throw new PlatformApiError("API_PUBLICATION_INPUTS_INCOMPLETE", 422)
      }
      const apiConnection = resource.kind === "API" ? candidateConnections[0] : undefined
      const apiMapping = apiConnection?.request_mapping ?? null
      if (apiMetadata && apiMapping) {
        const operationIds = new Set(apiMetadata.operations.map((operation) => operation.operation_id))
        if (apiMapping.rules.some((rule) => rule.operation_id !== null && !operationIds.has(rule.operation_id))) {
          throw new PlatformApiError("API_REQUEST_MAPPING_OPERATION_NOT_FOUND", 422)
        }
      }
      const queryMappingLua = apiMetadata && apiMapping
        ? apiQueryMappingLua(apiMapping, apiMetadata.operations, publication.base_path)
        : ""
      const requestPreludeLua = resource.kind === "API" ? queryMappingLua : ""
      const routeResources = resource.kind === "LLM"
        ? [
          nativeResource(
            AI_GATEWAY_ROUTE_API_VERSION,
            "AIGatewayRoute",
            llmInternalRouteName,
            namespace,
            snapshot.resource_id,
            snapshot.endpoint_revision,
            {
              hostnames: [llmInternalHostname],
              parentRefs: [
                {
                  name: publication.gateway_id,
                  kind: "Gateway",
                  group: GATEWAY_API_GROUP,
                  namespace,
                  sectionName: "internal",
                },
              ],
              rules: sortedModels.map((model) =>
                routeRule(model, modelMappings, aiServiceBackendByConnection, routingPriorityByConnection),
              ),
              llmRequestCosts: DEFAULT_LLM_REQUEST_COSTS,
            },
            {
              // AIGatewayRoute v1.1 has no per-route path field. The path is
              // enforced by the controller's native rootPrefix; compilation
              // above fails closed when the publication does not match it.
              "genio.one/generated-httproute-name": llmInternalRouteName,
            },
          ),
          nativeResource(
            "gateway.envoyproxy.io/v1alpha1",
            "BackendTrafficPolicy",
            kubernetesName(`${llmInternalRouteName}-retry`, "BackendTrafficPolicy"),
            namespace,
            snapshot.resource_id,
            snapshot.endpoint_revision,
            {
              targetRefs: [{
                group: GATEWAY_API_GROUP,
                kind: "HTTPRoute",
                name: llmInternalRouteName,
              }],
              retry: {
                numRetries: candidateConnections.length,
                retryOn: {
                  triggers: ["connect-failure", "reset"],
                },
              },
            },
          ),
          nativeResource(
            "gateway.networking.k8s.io/v1",
            "HTTPRoute",
            routeName,
            namespace,
            snapshot.resource_id,
            snapshot.endpoint_revision,
            {
              hostnames: [publication.hostname],
              parentRefs: [{
                name: publication.gateway_id,
                kind: "Gateway",
                group: GATEWAY_API_GROUP,
                namespace,
                sectionName: "http",
              }],
              rules: [{
                matches: [{ path: { type: "PathPrefix", value: publication.base_path } }],
                timeouts: requestedModels.some((model) => model.capabilities.includes("TRANSCRIPTION"))
                  ? { request: "120s", backendRequest: "120s" }
                  : { request: "60s", backendRequest: "60s" },
                filters: [
                  {
                    type: "URLRewrite",
                    urlRewrite: { hostname: llmInternalHostname },
                  },
                  {
                    type: "RequestHeaderModifier",
                    requestHeaderModifier: { remove: ["authorization"] },
                  },
                ],
                backendRefs: [backendReference(llmInternalReference, namespace)],
              }],
            },
          ),
          ...(llmInternalBackend ? [llmInternalBackend] : []),
        ]
        : resource.kind === "MCP" ? [nativeResource(
            AI_GATEWAY_ROUTE_API_VERSION,
            "MCPRoute",
            routeName,
            namespace,
            snapshot.resource_id,
            snapshot.endpoint_revision,
            {
              hostnames: [publication.hostname],
              parentRefs: [{
                name: publication.gateway_id,
                kind: "Gateway",
                group: GATEWAY_API_GROUP,
                namespace,
                sectionName: "http",
              }],
              path: publication.base_path,
              backendRefs: mcpBackendRefs,
              ...(mcpSecurityPolicy ? { securityPolicy: mcpSecurityPolicy } : {}),
            },
            {},
          )] : [nativeResource(
            "gateway.networking.k8s.io/v1",
            "HTTPRoute",
            routeName,
            namespace,
            snapshot.resource_id,
            snapshot.endpoint_revision,
            {
              hostnames: [publication.hostname],
              parentRefs: [{
                name: publication.gateway_id,
                kind: "Gateway",
                group: GATEWAY_API_GROUP,
                namespace,
                sectionName: "http",
              }],
              rules: apiMetadata!.operations.map((operation) => {
                const filters: Record<string, unknown>[] = [{
                  type: "URLRewrite",
                  urlRewrite: {
                    path: apiOperationRewrite(apiEndpoint!.pathPrefix, operation.path),
                  },
                }]
                const headerFilter = apiHeaderFilter(
                  effectiveApiRules(apiMapping!.rules, operation.operation_id, "HEADER"),
                )
                if (headerFilter) filters.push(headerFilter)
                return {
                  matches: [apiOperationMatch(publication.base_path, operation)],
                  filters,
                  backendRefs: [apiBackendReference!],
                }
              }),
            },
          )]

      const securityPolicy = (resource.kind === "LLM" || resource.kind === "API") && authorizeStep && jwtConfig
        ? authorizationPolicy(
            routeName,
            rendererOptions.extAuth,
            jwtConfig,
            input.tenantId,
            snapshot.resource_id,
            snapshot.capability_id,
            apiMetadata?.a2a ? "A2A" : resource.kind,
            apiMetadata?.a2a,
            safeChain.chain_id,
            namespace,
            snapshot.endpoint_revision,
            rendererOptions,
          )
        : undefined
      const processingPolicy = extensionPolicy(
        safeChain,
        rendererOptions.processor,
        rendererOptions.processorGrpc,
        routeName,
        publication.gateway_id,
        snapshot.resource_id,
        namespace,
        snapshot.endpoint_revision,
        resource.kind === "LLM",
        requestPreludeLua,
        resource.kind === "MCP"
          ? [kubernetesName(`ai-eg-mcp-main-${routeName}`, "generated MCP main HTTPRoute")]
          : [routeName],
      )
      const sidecarBackends = [
        ...(authorizeStep
          ? [
              sidecarBackend(
                rendererOptions.extAuth,
                namespace,
              ),
            ]
          : []),
        ...(rendererOptions.telemetry
          ? [sidecarBackend(rendererOptions.telemetry, namespace)]
          : []),
      ].filter((resource): resource is GatewayNativeResource => Boolean(resource))

      const resources = [
        gatewayCorrelationPolicy(publication.gateway_id, namespace),
        ...((resource.kind === "LLM" || resource.kind === "MCP") ? [gatewayConfigResource({
          gatewayId: publication.gateway_id,
          namespace,
          tenantId: snapshot.tenant_id,
          telemetry: rendererOptions.telemetry,
        })] : []),
        ...connectionBackends,
        ...certificateBundles,
        ...aiServiceBackends,
        ...credentialPolicies,
        ...routeResources,
        ...(authorizeStep && jwtConfig
          ? [authorizationFilterOrder(
              publication.gateway_id,
              namespace,
              snapshot.tenant_id,
              rendererOptions.telemetry,
            )]
          : []),
        ...(securityPolicy ? [securityPolicy] : []),
        ...sidecarBackends,
        ...(processingPolicy
          ? [
              processingPolicy.backend,
              processingPolicy.grpcBackend,
              processingPolicy.route,
              processingPolicy.policy,
            ].filter((value): value is GatewayNativeResource => Boolean(value))
          : []),
      ].sort((left, right) => {
        const kindOrder = `${left.kind}:${left.metadata.name}`
        const rightKindOrder = `${right.kind}:${right.metadata.name}`
        return compareUtf8(kindOrder, rightKindOrder)
      })

      const unsigned = {
        schema_version: "genio.one.gateway.v1" as const,
        operation: "APPLY" as const,
        projection_id: `${routeName}-projection-${snapshot.endpoint_revision}`,
        tenant_id: input.tenantId,
        publication_id: snapshot.publication_id,
        resource_id: snapshot.resource_id,
        capability_id: snapshot.capability_id,
        endpoint_revision: snapshot.endpoint_revision,
        policy_revision: snapshot.policy_revision,
        revision: snapshot.endpoint_revision,
        publication_endpoint: publication,
        policy_bundle: {
          enforcement_chain: safeChain,
        },
        resources,
      }
      const projectionDigest = digest(unsigned)
      const signaturePayload = canonicalGatewayProjectionJson({ ...unsigned, digest: projectionDigest })
      const signatureValue = await signer.sign(new TextEncoder().encode(signaturePayload))
      const signature = {
        algorithm: "Ed25519" as const,
        key_id: signer.keyId,
        value: signatureValue,
      }
      if (!isEd25519Signature(signature)) {
        throw new PlatformApiError("GATEWAY_PROJECTION_SIGNATURE_FAILED", 500)
      }
      return {
        ...unsigned,
        digest: projectionDigest,
        signature,
      }
    },
  }
}
