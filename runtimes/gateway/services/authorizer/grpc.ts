import { isAudioMultipart, transcriptionFields } from "../shared/audio-transcription"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import grpc from "@grpc/grpc-js"
import protoLoader from "@grpc/proto-loader"

import type {
  AuthorizationDecision,
  AuthorizationDecisionEvent,
  AuthorizationInput,
  CompiledAuthorizationBundle,
  CompiledUsagePolicy,
} from "@genioone/protocol/authorization"
import { authorize } from "@genioone/policy/authorize"
import type { AuthorizationBundleSource } from "./bundle-store"
import {
  TRUSTED_RELEASE_HEADERS,
  trustedReleaseHeaderEntries,
} from "../shared/release-handoff"
import {
  ALLOWED_PUBLIC_MODELS_HEADER,
  ALLOWED_MCP_TOOLS_HEADER,
  AI_GATEWAY_MODEL_HEADER,
  BUNDLE_REVISION_HEADER,
  CALLER_IDENTITY_HEADERS,
  CONSUMER_ORGANIZATION_HEADER,
  CORRELATION_HEADER,
  DECISION_ID_HEADER,
  POLICY_VERSION_HEADER,
  ON_BEHALF_OF_SUBJECT_HEADER,
  EXECUTION_GRANT_HEADER,
  REQUEST_ID_HEADER,
  TRUSTED_CAPABILITY_HEADER,
  TRUSTED_AUTHORITY_MODE_HEADER,
  TRUSTED_AGENT_ACTING_CHAIN_HEADER,
  TRUSTED_PRINCIPAL_SUBJECT_HEADER,
  TRUSTED_DELEGATION_ID_HEADER,
  TRUSTED_DELEGATION_REVISION_HEADER,
  TRUSTED_DELEGATION_GENERATION_HEADER,
  TRUSTED_CLIENT_HEADER,
  TRUSTED_CONSUMER_ORGANIZATION_HEADER,
  TRUSTED_CONTEXT_HEADERS,
  TRUSTED_CORRELATION_HEADER,
  TRUSTED_RESOURCE_HEADER,
  TRUSTED_RESOURCE_OWNER_ORGANIZATION_HEADER,
  TRUSTED_RISK_LEVEL_HEADER,
  TRUSTED_REQUIRED_OBLIGATIONS_HEADER,
  TRUSTED_EXECUTION_GRANT_HEADER,
  TRUSTED_SUBJECT_HEADER,
  TRUSTED_SUBJECT_KIND_HEADER,
  TRUSTED_TENANT_HEADER,
  TRUSTED_USE_CASE_HEADER,
  USAGE_ACCOUNTING_KEYS_HEADER,
  USAGE_ADMISSION_ID_HEADER,
  USAGE_CONCURRENCY_LEASES_HEADER,
  USAGE_CURRENCY_ALLOCATIONS_HEADER,
  USAGE_POLICY_REVISIONS_HEADER,
  USE_CASE_HEADER,
  VERIFIED_CLIENT_HEADER,
  VERIFIED_SUBJECT_HEADER,
} from "../shared/enforcement-headers"
import type { GatewayReleaseReference } from "@genioone/protocol/runtime-command"
import {
  contextualGatewayRoutingScope,
  type GatewayRoutingArtifact,
  type GatewayRoutingScope,
} from "../shared/gateway-routing-artifact"
import { MODEL_ROUTE_HANDOFF_HEADERS } from "../shared/model-route-handoff"
import { MCP_OAUTH_HEADER_PREFIX } from "../shared/mcp-oauth-handoff"
import { operationalError, writeOperationalEvent } from "@genioone/telemetry/operational-log"
import {
  admitUsage,
  type UsageAdmissionReason,
  type UsageCounterStore,
} from "../shared/usage-governance"
import { executionActionDigest, type ExecutionGrantConsumer } from "../shared/execution-grant"

/**
 * Headers written by this ext_authz service after native authentication and
 * One Policy authorization have succeeded.  Processor services must only
 * consume this namespace; the untrusted x-genio-* caller namespace is never
 * used as a substitute.
 */
export interface McpOAuthRequestHeader {
  name: string
  value: string
}

export type McpOAuthRequestHeaderResolver = (
  input: AuthorizationInput,
) => Promise<McpOAuthRequestHeader[]>

export interface UsageRejectionObservation {
  input: AuthorizationInput
  authorizationDecision: AuthorizationDecision
  reason: UsageAdmissionReason
  statusCode: 429 | 503
  releaseReference: GatewayReleaseReference
}

export interface RoutingRejectionObservation {
  input: AuthorizationInput
  authorizationDecision: AuthorizationDecision
  reason: "NO_HEALTHY_CONNECTION"
  statusCode: 503
  releaseReference: GatewayReleaseReference
  routing: {
    routing_policy_id: string
    routing_revision: number
    candidate_set_digest: string
    candidate_connection_ids: string[]
  }
}

interface AdmittedUsageHandoff {
  admission_id: string
  accounting_key_ids: string[]
  concurrency_lease_ids: string[]
  matched_policy_revisions: string[]
  currency_allocations: Array<{
    accounting_key_id: string
    allocation_id: string
    currency: string
    window_seconds: number
    window_bucket: number
  }>
}

function subjectAuthorityMatches(
  bundle: CompiledAuthorizationBundle,
  input: AuthorizationInput,
  grantSubjectId: string,
): boolean {
  if (grantSubjectId === input.subjectId) return true
  return bundle.rules.some((rule) =>
    rule.disposition === "ALLOW" &&
    !rule.subject_ids.includes("*") &&
    rule.subject_ids.includes(grantSubjectId) &&
    rule.subject_ids.includes(input.subjectId) &&
    (rule.acting_client_ids.includes("*") || rule.acting_client_ids.includes(input.actingClientId)) &&
    rule.resource_id === input.resourceId &&
    rule.capability_id === input.capabilityId
  )
}

function trustedRoutingScope(
  artifact: GatewayRoutingArtifact,
  input: AuthorizationInput,
): GatewayRoutingScope | undefined {
  const scope = artifact.scopes.find((candidate) =>
    candidate.resource_id === input.resourceId && candidate.capability_id === input.capabilityId
  )
  return scope
    ? contextualGatewayRoutingScope(
        scope,
        input.consumerOrganizationId,
        input.useCaseId,
        input.riskLevel,
      )
    : undefined
}

function trustedPricing(
  artifact: GatewayRoutingArtifact,
  input: AuthorizationInput,
  policies: readonly CompiledUsagePolicy[],
): { currency: string; source: string; version: string } | undefined {
  if (!policies.some((policy) => policy.limits.currency_budget)) return undefined
  const scope = trustedRoutingScope(artifact, input)
  const publicModel = scope?.candidates.find((candidate) =>
    candidate.public_model_name === input.requestedPublicModel
  )
  const pricing = publicModel?.mappings.map((mapping) => mapping.pricing)
  if (!pricing?.length || pricing.some((entry) => entry === undefined)) return undefined
  const currencies = new Set(pricing.map((entry) => entry!.currency))
  const sources = new Set(pricing.map((entry) => entry!.source))
  const versions = new Set(pricing.map((entry) => entry!.version))
  if (currencies.size !== 1 || sources.size !== 1 || versions.size !== 1) return undefined
  return {
    currency: [...currencies][0]!,
    source: [...sources][0]!,
    version: [...versions][0]!,
  }
}

function unavailableRouting(
  artifact: GatewayRoutingArtifact,
  input: AuthorizationInput,
): RoutingRejectionObservation["routing"] | undefined {
  const scope = trustedRoutingScope(artifact, input)
  if (!scope) return undefined
  const selected = input.requestedPublicModel
    ? scope.candidates.find((candidate) => candidate.public_model_name === input.requestedPublicModel)
    : scope.candidates.find((candidate) => candidate.public_model_id === scope.default_public_model_id)
  if (!selected || selected.mappings.length > 0) return undefined
  return {
    routing_policy_id: scope.routing_policy_id,
    routing_revision: scope.routing_revision,
    candidate_set_digest: scope.candidate_set_digest,
    candidate_connection_ids: [],
  }
}

const ALLOW_RESPONSE_HEADERS = [
  DECISION_ID_HEADER,
  POLICY_VERSION_HEADER,
  BUNDLE_REVISION_HEADER,
  ALLOWED_PUBLIC_MODELS_HEADER,
  ALLOWED_MCP_TOOLS_HEADER,
  CORRELATION_HEADER,
  USAGE_ADMISSION_ID_HEADER,
  USAGE_ACCOUNTING_KEYS_HEADER,
  USAGE_CONCURRENCY_LEASES_HEADER,
  USAGE_CURRENCY_ALLOCATIONS_HEADER,
  USAGE_POLICY_REVISIONS_HEADER,
  TRUSTED_REQUIRED_OBLIGATIONS_HEADER,
  TRUSTED_SUBJECT_KIND_HEADER,
  TRUSTED_AUTHORITY_MODE_HEADER,
  TRUSTED_AGENT_ACTING_CHAIN_HEADER,
] as const

/**
 * Caller-controlled headers that must not survive native authentication and
 * authorization.
 *
 * Headers produced by this authorizer deliberately remain available to the
 * next ordered extProc step. The processor consumes and removes that complete
 * trusted handoff before the Provider request leaves the Gateway.
 */
const HEADERS_TO_REMOVE = [
  ...CALLER_IDENTITY_HEADERS,
  CORRELATION_HEADER,
  ...MODEL_ROUTE_HANDOFF_HEADERS,
] as const

type StringMap = Record<string, unknown> | Map<unknown, unknown> | undefined

interface EnvoyHttpRequest {
  id?: string
  method?: string
  path?: string
  headers?: StringMap
  body?: string
  raw_body?: Uint8Array
}

interface EnvoyCheckRequest {
  attributes?: {
    request?: { http?: EnvoyHttpRequest }
    context_extensions?: StringMap
  }
}

export interface EnvoyCheckResponse {
  status: { code: number; message: string }
  denied_response?: {
    status: { code: number }
    headers: Array<{
      header: { key: string; value: string }
      append_action: number
    }>
    body: string
  }
  ok_response?: {
    headers: Array<{
      header: { key: string; value: string }
      append_action: number
    }>
    headers_to_remove?: string[]
  }
}

function mapEntries(value: StringMap): Array<[string, string]> {
  if (value instanceof Map) {
    return [...value.entries()].map(([key, entry]) => {
      if (typeof key !== "string" || typeof entry !== "string") {
        throw new Error("authorization header map contains a malformed entry")
      }
      return [key, entry]
    })
  }
  if (!value || typeof value !== "object") return []
  return Object.entries(value).map(([key, entry]) => {
    if (typeof entry !== "string") {
      throw new Error(`authorization header ${key} is malformed`)
    }
    return [key, entry]
  })
}

function headerMap(value: StringMap): Map<string, string> {
  const headers = new Map<string, string>()
  for (const [rawKey, rawValue] of mapEntries(value)) {
    const key = rawKey.toLowerCase()
    const entry = rawValue.trim()
    const previous = headers.get(key)
    if (previous !== undefined) {
      throw new Error(
        previous === entry ? `repeated ${key} header` : `conflicting ${key} headers`,
      )
    }
    headers.set(key, entry)
  }
  return headers
}

function required(map: Map<string, string>, name: string): string {
  const value = map.get(name)?.trim()
  if (!value) throw new Error(`missing trusted ${name}`)
  if (value.length > 2_048 || /[\u0000\r\n]/.test(value)) {
    throw new Error(`invalid trusted ${name}`)
  }
  return value
}

function optional(map: Map<string, string>, name: string): string | undefined {
  const value = map.get(name)?.trim()
  if (value === undefined || value.length === 0) return undefined
  if (value.length > 2_048 || /[\u0000\r\n]/.test(value)) {
    throw new Error(`invalid ${name}`)
  }
  return value
}

function requiredContext(request: EnvoyCheckRequest, name: string): string {
  return required(headerMap(request.attributes?.context_extensions), name)
}

const MAX_AUTHORIZATION_BODY_BYTES = 4_194_304

function requestHeaders(request: EnvoyCheckRequest): Map<string, string> {
  return headerMap(request.attributes?.request?.http?.headers)
}

function parsedRequestBody(request: EnvoyCheckRequest): Record<string, unknown> | undefined {
  const http = request.attributes?.request?.http
  const raw = http?.raw_body && http.raw_body.byteLength > 0
    ? Buffer.from(http.raw_body).toString("utf8")
    : http?.body
  if (!raw) return undefined
  if (Buffer.byteLength(raw, "utf8") > MAX_AUTHORIZATION_BODY_BYTES) {
    throw new Error("authorization request body exceeds the configured limit")
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("authorization request body is not valid JSON")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("authorization request body must be an object")
  }
  return value as Record<string, unknown>
}

function rawRequestBody(request: EnvoyCheckRequest): string {
  const http = request.attributes?.request?.http
  const raw = http?.raw_body && http.raw_body.byteLength > 0
    ? Buffer.from(http.raw_body).toString(isAudioMultipart(requestHeaders(request).get("content-type") ?? "") ? "base64" : "utf8")
    : http?.body ?? ""
  if ((http?.raw_body?.byteLength || Buffer.byteLength(raw, "utf8")) > MAX_AUTHORIZATION_BODY_BYTES) throw new Error("authorization request body exceeds the configured limit")
  return raw
}

function requestedPublicModel(
  body: Record<string, unknown> | undefined,
  required: boolean,
): string | undefined {
  const model = body?.model
  if (typeof model !== "string" || !model.trim()) {
    if (!required) return undefined
    throw new Error("authorization request body is missing model")
  }
  const normalized = model.trim()
  if (normalized.length > 256 || /[\u0000\r\n]/.test(normalized)) {
    throw new Error("authorization request model is invalid")
  }
  return normalized
}

function mcpRequestMetadata(
  body: Record<string, unknown> | undefined,
): Pick<AuthorizationInput, "mcpMethod" | "mcpTool"> {
  const method = body?.method
  if (typeof method !== "string" || !method.trim() || method.length > 256 || /[\u0000\r\n]/.test(method)) {
    throw new Error("authorization request body is missing MCP method")
  }
  const params = body?.params
  const tool = method === "tools/call" && params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>).name
    : undefined
  if (tool !== undefined && (typeof tool !== "string" || !tool.trim() || tool.length > 256 || /[\u0000\r\n]/.test(tool))) {
    throw new Error("authorization request MCP tool is invalid")
  }
  if (method === "tools/call" && typeof tool !== "string") {
    throw new Error("authorization request MCP tool is missing")
  }
  return {
    mcpMethod: method.trim(),
    ...(typeof tool === "string" ? { mcpTool: tool.trim() } : {}),
  }
}

function mcpTransportMetadata(
  body: Record<string, unknown> | undefined,
  requestMethod: string,
): Pick<AuthorizationInput, "mcpMethod" | "mcpTool"> {
  if (requestMethod === "GET") return { mcpMethod: "transport/get" }
  if (requestMethod === "DELETE") return { mcpMethod: "transport/delete" }
  if (requestMethod !== "POST") throw new Error("authorization MCP transport method is invalid")
  return mcpRequestMetadata(body)
}

function a2aRequestMetadata(
  request: EnvoyCheckRequest,
): Pick<AuthorizationInput, "a2aOperation" | "targetAgentSubjectId"> {
  const operation = requiredContext(request, "a2a_operation")
  if (operation !== "SEND_MESSAGE" && operation !== "SEND_STREAMING_MESSAGE") {
    throw new Error("authorization A2A operation is invalid")
  }
  return {
    a2aOperation: operation,
    targetAgentSubjectId: requiredContext(request, "target_agent_subject_id"),
  }
}

/**
 * Build the authorization input from Envoy's ext_authz attributes.
 *
 * Route-scoped values are delivered through context_extensions by the trusted
 * Envoy filter configuration.  Identity values must have been emitted by the
 * native authentication filter under an allowlisted header name.  In
 * particular, the similarly named caller headers are deliberately ignored.
 */
function authorizationInputFromCheckRequest(
  request: EnvoyCheckRequest,
  now = Math.floor(Date.now() / 1000),
  multipartFields?: Record<string, string>,
): AuthorizationInput {
  const headers = requestHeaders(request)
  for (const header of [...TRUSTED_CONTEXT_HEADERS, ...TRUSTED_RELEASE_HEADERS]) {
    if (headers.has(header)) {
      throw new Error(`caller supplied reserved ${header}`)
    }
  }
  if (headers.has(AI_GATEWAY_MODEL_HEADER)) {
    throw new Error(`caller supplied reserved ${AI_GATEWAY_MODEL_HEADER}`)
  }
  if ([...headers.keys()].some((name) => name.startsWith(MCP_OAUTH_HEADER_PREFIX))) {
    throw new Error("caller supplied reserved MCP OAuth header")
  }
  const protocol = headerMap(request.attributes?.context_extensions).get("request_protocol") ?? "LLM"
  if (protocol !== "LLM" && protocol !== "MCP" && protocol !== "API" && protocol !== "A2A") {
    throw new Error("authorization request protocol is invalid")
  }
  const body = multipartFields ?? parsedRequestBody(request)
  const requestMethod = request.attributes?.request?.http?.method || headers.get(":method") || "POST"
  const requestPath = request.attributes?.request?.http?.path || headers.get(":path") || "/"
  return {
    requestProtocol: protocol,
    tenantId: requiredContext(request, "tenant_id"),
    subjectId: required(headers, VERIFIED_SUBJECT_HEADER),
    actingClientId: required(headers, VERIFIED_CLIENT_HEADER),
    resourceId: requiredContext(request, "resource_id"),
    capabilityId: requiredContext(request, "capability_id"),
    requestedPublicModel: requestedPublicModel(body, protocol === "LLM"),
    ...(protocol === "MCP" ? mcpTransportMetadata(body, requestMethod.toUpperCase()) : {}),
    ...(protocol === "A2A" ? a2aRequestMetadata(request) : {}),
    consumerOrganizationId: optional(headers, CONSUMER_ORGANIZATION_HEADER),
    useCaseId: optional(headers, USE_CASE_HEADER),
    principalSubjectId: optional(headers, ON_BEHALF_OF_SUBJECT_HEADER),
    executionGrantId: optional(headers, EXECUTION_GRANT_HEADER),
    actionDigest: executionActionDigest({ method: requestMethod, path: requestPath, body: rawRequestBody(request) }),
    correlationId: required(headers, REQUEST_ID_HEADER),
    requestMethod,
    requestPath,
    now,
  }
}

function safeHeaderValue(value: string): string {
  if (!value || value.length > 16_384 || /[\u0000\r\n]/.test(value)) {
    throw new Error("authorization decision contains an invalid response header")
  }
  return value
}

function headerOption(key: string, value: string) {
  return {
    // All context headers are validated UTF-8 identifiers.  ext_authz's
    // response contract supports the string representation, which keeps the
    // verified handoff visible to the following native/Lua filter on older
    // Envoy builds as well as current ones.
    header: { key, value: safeHeaderValue(value) },
    // OVERWRITE_IF_EXISTS_OR_ADD from envoy.config.core.v3.HeaderValueOption.
    append_action: 2,
  }
}

function allowResponse(
  input: AuthorizationInput,
  decision: AuthorizationDecision,
  releaseReference: GatewayReleaseReference,
  oauthHeaders: readonly McpOAuthRequestHeader[],
  usageAdmission?: AdmittedUsageHandoff,
  requiredObligations: readonly string[] = [],
): EnvoyCheckResponse {
  const headers = [
    headerOption(DECISION_ID_HEADER, decision.decisionId),
    headerOption(POLICY_VERSION_HEADER, decision.policyVersion),
    headerOption(BUNDLE_REVISION_HEADER, decision.bundleRevision),
  ]
  if (decision.allowedPublicModels.length > 0) {
    headers.push(
      headerOption(
        ALLOWED_PUBLIC_MODELS_HEADER,
        decision.allowedPublicModels.map(safeHeaderValue).join(","),
      ),
    )
  }
  if (decision.allowedMcpTools.length > 0) {
    headers.push(
      headerOption(ALLOWED_MCP_TOOLS_HEADER, JSON.stringify(decision.allowedMcpTools)),
    )
  }
  if (usageAdmission) {
    headers.push(
      headerOption(USAGE_ADMISSION_ID_HEADER, usageAdmission.admission_id),
      headerOption(USAGE_ACCOUNTING_KEYS_HEADER, JSON.stringify(usageAdmission.accounting_key_ids)),
      headerOption(USAGE_CONCURRENCY_LEASES_HEADER, JSON.stringify(usageAdmission.concurrency_lease_ids)),
      headerOption(USAGE_POLICY_REVISIONS_HEADER, JSON.stringify(usageAdmission.matched_policy_revisions)),
      headerOption(USAGE_CURRENCY_ALLOCATIONS_HEADER, JSON.stringify(usageAdmission.currency_allocations)),
    )
  }
  headers.push(
    headerOption(CORRELATION_HEADER, input.correlationId),
    // OVERWRITE_IF_EXISTS_OR_ADD is important here.  A caller can send a
    // lookalike trusted header before ext_authz; the allow response must
    // replace it with the compiler context and verified identity used for the
    // actual decision.
    headerOption(TRUSTED_TENANT_HEADER, input.tenantId),
    headerOption(TRUSTED_SUBJECT_HEADER, input.subjectId),
    headerOption(TRUSTED_CLIENT_HEADER, input.actingClientId),
    headerOption(TRUSTED_RESOURCE_HEADER, input.resourceId),
    headerOption(TRUSTED_CAPABILITY_HEADER, input.capabilityId),
    headerOption(TRUSTED_CORRELATION_HEADER, input.correlationId),
    ...trustedReleaseHeaderEntries(releaseReference).map(([key, value]) =>
      headerOption(key, value),
    ),
  )
  if (input.subjectKind && input.authorityMode) {
    headers.push(
      headerOption(TRUSTED_SUBJECT_KIND_HEADER, input.subjectKind),
      headerOption(TRUSTED_AUTHORITY_MODE_HEADER, input.authorityMode),
    )
  }
  if (input.authorityMode === "DELEGATED" && input.principalSubjectId && input.delegationId) {
    headers.push(
      headerOption(TRUSTED_PRINCIPAL_SUBJECT_HEADER, input.principalSubjectId),
      headerOption(TRUSTED_DELEGATION_ID_HEADER, input.delegationId),
      headerOption(TRUSTED_DELEGATION_REVISION_HEADER, String(input.delegationRevision)),
      headerOption(TRUSTED_DELEGATION_GENERATION_HEADER, String(input.delegationRevocationGeneration)),
    )
  }
  if (decision.agentActingChain) {
    headers.push(
      headerOption(TRUSTED_AGENT_ACTING_CHAIN_HEADER, JSON.stringify(decision.agentActingChain)),
    )
  }
  if (input.consumerOrganizationId && input.useCaseId) {
    headers.push(
      headerOption(TRUSTED_CONSUMER_ORGANIZATION_HEADER, input.consumerOrganizationId),
      headerOption(TRUSTED_USE_CASE_HEADER, input.useCaseId),
      headerOption(TRUSTED_RISK_LEVEL_HEADER, input.riskLevel ?? "LOW"),
    )
  }
  if (input.resourceOwnerOrganizationId) {
    headers.push(
      headerOption(TRUSTED_RESOURCE_OWNER_ORGANIZATION_HEADER, input.resourceOwnerOrganizationId),
    )
  }
  if (requiredObligations.length > 0) {
    headers.push(
      headerOption(TRUSTED_REQUIRED_OBLIGATIONS_HEADER, JSON.stringify(requiredObligations)),
    )
  }
  if (input.executionGrantId && requiredObligations.includes("execution.confirmation")) {
    headers.push(headerOption(TRUSTED_EXECUTION_GRANT_HEADER, input.executionGrantId))
  }
  for (const header of oauthHeaders) {
    const name = header.name.trim().toLowerCase()
    if (
      !name.startsWith(MCP_OAUTH_HEADER_PREFIX) ||
      !/^[a-z0-9-]+$/.test(name) ||
      name.length > 128
    ) {
      throw new Error("credential broker returned an invalid header name")
    }
    headers.push(headerOption(name, header.value))
  }
  return {
    status: { code: grpc.status.OK, message: "allowed" },
    ok_response: { headers, headers_to_remove: [...HEADERS_TO_REMOVE] },
  }
}

function deniedResponse(
  statusCode: number,
  httpCode: number,
  reason: string,
  details = "",
): EnvoyCheckResponse {
  return {
    status: { code: statusCode, message: reason },
    denied_response: {
      status: { code: httpCode },
      headers: [
        {
          header: { key: "content-type", value: "application/json" },
          append_action: 2,
        },
      ],
      body: JSON.stringify({ code: reason, ...(details ? { details } : {}) }),
    },
  }
}

function mcpToolsListResponse(
  request: EnvoyCheckRequest,
  decision: AuthorizationDecision,
): EnvoyCheckResponse {
  const requestId = parsedRequestBody(request)?.id
  return {
    status: { code: grpc.status.PERMISSION_DENIED, message: "MCP_TOOL_SURFACE" },
    denied_response: {
      status: { code: 200 },
      headers: [{
        header: { key: "content-type", value: "application/json" },
        append_action: 2,
      }],
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: typeof requestId === "string" || typeof requestId === "number" ? requestId : null,
        result: {
          tools: decision.allowedMcpTools.map((name) => ({
            name,
            description: "Published MCP tool",
            inputSchema: { type: "object", additionalProperties: true },
          })),
        },
      }),
    },
  }
}

function failureResponse(): EnvoyCheckResponse {
  return deniedResponse(
    grpc.status.UNAUTHENTICATED,
    401,
    "UNVERIFIED_IDENTITY_CONTEXT",
  )
}

export type ExternalAuthorizationHandler = grpc.handleUnaryCall<
  EnvoyCheckRequest,
  EnvoyCheckResponse
>

/**
 * Formal Envoy v3 ext_authz gRPC Check implementation. Every malformed or
 * unavailable authorization input returns a denial response instead of
 * throwing an UNKNOWN error or accidentally allowing the request.
 */
function createExternalAuthorizerHandler(
  bundleSource: AuthorizationBundleSource,
  onDecision?: (event: AuthorizationDecisionEvent) => void | Promise<void>,
  resolveMcpOAuthHeaders?: McpOAuthRequestHeaderResolver,
  usageStore?: UsageCounterStore,
  onUsageRejection?: (event: UsageRejectionObservation) => void | Promise<void>,
  onRoutingRejection?: (event: RoutingRejectionObservation) => void | Promise<void>,
  executionGrantConsumer?: ExecutionGrantConsumer,
): ExternalAuthorizationHandler {
  return async (call, callback) => {
    let input: AuthorizationInput
    try {
      const http = call.request.attributes?.request?.http
      const contentType = requestHeaders(call.request).get("content-type") ?? ""
      const fields = isAudioMultipart(contentType)
        ? await transcriptionFields(http?.raw_body?.byteLength ? http.raw_body : Buffer.from(http?.body ?? ""), contentType)
        : undefined
      if (fields && requestHeaders(call.request).has(EXECUTION_GRANT_HEADER)) throw new Error("ASR_EXECUTION_GRANTS_UNSUPPORTED")
      input = authorizationInputFromCheckRequest(call.request, undefined, fields)
    } catch (error) {
      writeOperationalEvent("authorizer", "ERROR", "identity-context-rejected", {
        ...operationalError(error),
      })
      callback(null, failureResponse())
      return
    }

    void bundleSource
      .current()
      .then(async ({ bundle, releaseReference, routingArtifact }) => {
        const subjectContext = bundle.subject_contexts?.find((context) =>
          context.subject_id === input.subjectId
        )
        if ((bundle.subject_contexts?.length ?? 0) > 0 && !subjectContext) {
          callback(null, deniedResponse(grpc.status.PERMISSION_DENIED, 403, "SUBJECT_CONTEXT_UNAVAILABLE"))
          return
        }
        if (subjectContext) {
          input.subjectKind = subjectContext.kind
          input.authorityMode = subjectContext.kind === "AGENT" ? "SELF" : "DIRECT"
        }
        let delegationDenied = false
        if (input.principalSubjectId) {
          input.authorityMode = "DELEGATED"
          const delegation = (bundle.agent_delegations ?? [])
            .filter((value) =>
              value.principal_subject_id === input.principalSubjectId &&
              subjectAuthorityMatches(bundle, input, value.agent_subject_id) &&
              value.resource_id === input.resourceId &&
              value.capability_ids.includes(input.capabilityId) &&
              value.acting_client_ids.includes(input.actingClientId)
            )
            .sort((left, right) => right.revision - left.revision)[0]
          if (delegation) {
            input.delegationId = delegation.delegation_id
            input.delegationRevision = delegation.revision
            input.delegationRevocationGeneration = delegation.revocation_generation
          }
          delegationDenied = input.subjectKind !== "AGENT" ||
            !delegation ||
            delegation.state !== "ACTIVE" ||
            delegation.starts_at > input.now ||
            delegation.expires_at <= input.now
        }
        const basePolicies = (bundle.usage_policies ?? []).filter((policy) =>
          (policy.selectors.subject_id === undefined || policy.selectors.subject_id === input.subjectId) &&
          (policy.selectors.resource_id === undefined || policy.selectors.resource_id === input.resourceId) &&
          (policy.selectors.capability_id === undefined || policy.selectors.capability_id === input.capabilityId),
        )
        const selectedOrganization = input.consumerOrganizationId
        const selectedUseCase = input.useCaseId
        if ((selectedOrganization === undefined) !== (selectedUseCase === undefined)) {
          callback(null, deniedResponse(grpc.status.PERMISSION_DENIED, 403, "USAGE_CONTEXT_INCOMPLETE"))
          return
        }
        if (basePolicies.length > 0 && (!selectedOrganization || !selectedUseCase)) {
          callback(null, deniedResponse(grpc.status.PERMISSION_DENIED, 403, "USAGE_CONTEXT_REQUIRED"))
          return
        }
        if (selectedOrganization && selectedUseCase) {
          const selectedContext = (bundle.usage_contexts ?? []).find((context) =>
            context.subject_id === input.subjectId &&
            context.consumer_organization_id === selectedOrganization &&
            context.use_case_id === selectedUseCase
          )
          if (!selectedContext) {
            callback(null, deniedResponse(grpc.status.PERMISSION_DENIED, 403, "USAGE_CONTEXT_NOT_ALLOWED"))
            return
          }
          input.riskLevel = selectedContext.risk_level ?? "LOW"
        }
        const resourceOwner = bundle.resource_owners?.find((owner) =>
          owner.resource_id === input.resourceId
        )
        if (resourceOwner) input.resourceOwnerOrganizationId = resourceOwner.organization_id
        let decision = authorize(bundle, input)
        if (delegationDenied) {
          decision = {
            ...decision,
            disposition: "DENY",
            reason: "DELEGATION_NOT_ALLOWED",
            allowedPublicModels: [],
            allowedMcpTools: [],
          }
        }
        const routingScope = trustedRoutingScope(routingArtifact, input)
        const requiredObligations = [...new Set([
          ...decision.requiredObligations,
          ...(routingScope?.required_obligation_kinds ?? []),
        ])].sort()
        let executionGrantToConsume: { execution_grant_id: string; expires_at: number } | undefined
        if (decision.disposition === "ALLOW" && requiredObligations.includes("execution.confirmation")) {
          const grant = bundle.execution_grants?.find((value) =>
            value.execution_grant_id === input.executionGrantId &&
            subjectAuthorityMatches(bundle, input, value.subject_id) &&
            value.acting_client_id === input.actingClientId &&
            value.resource_id === input.resourceId &&
            value.capability_id === input.capabilityId &&
            value.action_digest === input.actionDigest &&
            value.issued_at <= input.now && value.expires_at > input.now
          )
          let reason: "EXECUTION_GRANT_REQUIRED" | "EXECUTION_GRANT_INVALID" | "EXECUTION_GRANT_STORE_UNAVAILABLE" | null = null
          if (!input.executionGrantId) reason = "EXECUTION_GRANT_REQUIRED"
          else if (!grant) reason = "EXECUTION_GRANT_INVALID"
          else if (!executionGrantConsumer) reason = "EXECUTION_GRANT_STORE_UNAVAILABLE"
          else executionGrantToConsume = grant
          if (reason) decision = { ...decision, disposition: "DENY", reason, allowedPublicModels: [], allowedMcpTools: [] }
        }
        const observeDecision = () => {
          void Promise.resolve(onDecision?.({
            event: "genio.one.authorization-decision",
            input,
            decision,
          })).catch((error) => {
            writeOperationalEvent("authorizer", "ERROR", "decision-observation-failed", {
              ...operationalError(error),
            })
          })
        }
        if (decision.disposition === "DENY") {
          observeDecision()
          const unavailable = decision.reason === "EXECUTION_GRANT_STORE_UNAVAILABLE"
          callback(
            null,
            deniedResponse(
              unavailable ? grpc.status.UNAVAILABLE : grpc.status.PERMISSION_DENIED,
              unavailable ? 503 : 403,
              decision.reason,
              decision.decisionId,
            ),
          )
          return
        }
        if (input.requestProtocol === "MCP" && input.mcpMethod === "tools/list") {
          observeDecision()
          callback(null, mcpToolsListResponse(call.request, decision))
          return
        }
        const observeUsageRejection = (reason: UsageAdmissionReason, statusCode: 429 | 503) => {
          void Promise.resolve(onUsageRejection?.({
            input,
            authorizationDecision: decision,
            reason,
            statusCode,
            releaseReference,
          })).catch((error) => {
            writeOperationalEvent("authorizer", "ERROR", "usage-rejection-observation-failed", {
              ...operationalError(error),
            })
          })
        }
        const unavailable = unavailableRouting(routingArtifact, input)
        if (unavailable) {
          observeDecision()
          void Promise.resolve(onRoutingRejection?.({
            input,
            authorizationDecision: decision,
            reason: "NO_HEALTHY_CONNECTION",
            statusCode: 503,
            releaseReference,
            routing: unavailable,
          })).catch((error) => {
            writeOperationalEvent("authorizer", "ERROR", "routing-rejection-observation-failed", {
              ...operationalError(error),
            })
          })
          callback(null, deniedResponse(
            grpc.status.UNAVAILABLE,
            503,
            "NO_HEALTHY_CONNECTION",
            decision.decisionId,
          ))
          return
        }
        let usageAdmission: AdmittedUsageHandoff | undefined
        if (basePolicies.length > 0) {
          if (!resourceOwner) {
            observeDecision()
            callback(null, deniedResponse(grpc.status.UNAVAILABLE, 503, "USAGE_CONTEXT_UNAVAILABLE"))
            return
          }
          input.resourceOwnerOrganizationId = resourceOwner.organization_id
          if (!usageStore) {
            observeDecision()
            observeUsageRejection("STORE_UNAVAILABLE", 503)
            callback(null, deniedResponse(grpc.status.UNAVAILABLE, 503, "STORE_UNAVAILABLE"))
            return
          }
          const pricing = trustedPricing(routingArtifact, input, basePolicies)
          const admission = await admitUsage({
            context: {
              tenant_id: input.tenantId,
              subject_id: input.subjectId,
              consumer_organization_id: selectedOrganization!,
              resource_owner_organization_id: resourceOwner.organization_id,
              resource_id: input.resourceId,
              capability_id: input.capabilityId,
              use_case_id: selectedUseCase!,
              correlation_id: input.correlationId,
              ...(pricing ? { pricing } : {}),
              now: input.now,
            },
            policies: basePolicies,
            store: usageStore,
          })
          if (admission.disposition === "REJECT") {
            observeDecision()
            const unavailable = admission.reason === "STORE_UNAVAILABLE"
            observeUsageRejection(admission.reason, unavailable ? 503 : 429)
            callback(null, deniedResponse(
              unavailable ? grpc.status.UNAVAILABLE : grpc.status.RESOURCE_EXHAUSTED,
              unavailable ? 503 : 429,
              admission.reason,
            ))
            return
          }
          usageAdmission = admission
        }
        let oauthHeaders: McpOAuthRequestHeader[] = []
        try {
          oauthHeaders = input.mcpMethod && resolveMcpOAuthHeaders
            ? await resolveMcpOAuthHeaders(input)
            : []
        } catch {
          observeDecision()
          callback(
            null,
            deniedResponse(
              grpc.status.UNAVAILABLE,
              503,
              "MCP_OAUTH_CREDENTIAL_UNAVAILABLE",
            ),
          )
          return
        }
        if (executionGrantToConsume) {
          try {
            const consumed = await executionGrantConsumer!.consume({
              tenant_id: input.tenantId,
              execution_grant_id: executionGrantToConsume.execution_grant_id,
              correlation_id: input.correlationId,
              expires_at: executionGrantToConsume.expires_at,
              now: input.now,
            })
            if (consumed === "ALREADY_CONSUMED") {
              decision = { ...decision, disposition: "DENY", reason: "EXECUTION_GRANT_INVALID", allowedPublicModels: [], allowedMcpTools: [] }
            }
          } catch {
            decision = { ...decision, disposition: "DENY", reason: "EXECUTION_GRANT_STORE_UNAVAILABLE", allowedPublicModels: [], allowedMcpTools: [] }
          }
          if (decision.disposition === "DENY") {
            observeDecision()
            const unavailable = decision.reason === "EXECUTION_GRANT_STORE_UNAVAILABLE"
            callback(null, deniedResponse(
              unavailable ? grpc.status.UNAVAILABLE : grpc.status.PERMISSION_DENIED,
              unavailable ? 503 : 403,
              decision.reason,
              decision.decisionId,
            ))
            return
          }
        }
        try {
          observeDecision()
          callback(null, allowResponse(
            input,
            decision,
            releaseReference,
            oauthHeaders,
            usageAdmission,
            requiredObligations,
          ))
        } catch {
          callback(
            null,
            deniedResponse(
              grpc.status.INTERNAL,
              500,
              "AUTHORIZATION_RESPONSE_INVALID",
            ),
          )
        }
      })
      .catch(() => {
        callback(
          null,
          deniedResponse(
            grpc.status.UNAVAILABLE,
            503,
            "POLICY_BUNDLE_UNAVAILABLE",
          ),
        )
      })
  }
}

function protoPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "proto/external_auth_minimal.proto",
  )
}

/** Create the gRPC server consumed by Envoy's ext_authz filter. */
export function createExternalAuthorizerServer(
  bundleSource: AuthorizationBundleSource,
  onDecision?: (event: AuthorizationDecisionEvent) => void | Promise<void>,
  resolveMcpOAuthHeaders?: McpOAuthRequestHeaderResolver,
  usageStore?: UsageCounterStore,
  onUsageRejection?: (event: UsageRejectionObservation) => void | Promise<void>,
  onRoutingRejection?: (event: RoutingRejectionObservation) => void | Promise<void>,
  executionGrantConsumer?: ExecutionGrantConsumer,
): grpc.Server {
  const path = protoPath()
  readFileSync(path)
  const definition = protoLoader.loadSync(path, {
    keepCase: true,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
  })
  const descriptor = grpc.loadPackageDefinition(definition) as Record<string, any>
  const service = descriptor.envoy.service.auth.v3.Authorization.service
  const server = new grpc.Server()
  server.addService(service, {
    Check: createExternalAuthorizerHandler(
      bundleSource,
      onDecision,
      resolveMcpOAuthHeaders,
      usageStore,
      onUsageRejection,
      onRoutingRejection,
      executionGrantConsumer,
    ),
  })
  return server
}

/**
 * Keep the allowlist visible to configuration/tests without allowing callers
 * to add arbitrary response headers.
 */
export const fixedAllowResponseHeaders = [
  ...ALLOW_RESPONSE_HEADERS,
  ...TRUSTED_CONTEXT_HEADERS,
  ...TRUSTED_RELEASE_HEADERS,
]
