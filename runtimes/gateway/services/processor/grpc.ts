import { prepareTranscriptionRequest } from "../shared/audio-transcription"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import grpc from "@grpc/grpc-js"
import protoLoader from "@grpc/proto-loader"

import type {
  DataProtectionAction,
  DataProtectionResult,
  ProcessingContext,
  ProcessorPolicy,
} from "./contract"
import { createProcessorChain, SseLineBuffer, type PayloadProcessor } from "./module"
import type { ProcessorPolicySource } from "./policy-store"
import type { TokenVault } from "./token-vault"
import {
  gatewayModelRouteLeaseEvent,
  requestPublicModelName,
  type GatewayModelRouteResolver,
} from "./model-route-lease"
import {
  narrowGatewayRoutingScopeByObligations,
  type GatewayRoutingScope,
} from "../shared/gateway-routing-artifact"
import type { GatewayActivityIngest } from "../shared/gateway-activity"
import {
  mergeDataClassificationReceipts,
  type DataClassificationReceipt,
} from "../shared/data-classification"
import type { CostValuation, InvocationAccounting, UsageQuantity } from "../shared/usage-accounting"
import {
  gatewayDetailActivityReference,
  GatewayDetailBodyBuffer,
  type GatewayDetailCapture,
} from "../../../../packages/telemetry/src/otlp-detail-capture"
import {
  TRUSTED_RELEASE_HEADERS,
  gatewayGroupReleaseReferencesEqual,
  trustedReleaseFromHeaders,
} from "../shared/release-handoff"
import {
  ALLOWED_PUBLIC_MODELS_HEADER,
  ALLOWED_MCP_TOOLS_HEADER,
  AI_GATEWAY_MODEL_HEADER,
  BUNDLE_REVISION_HEADER,
  CALLER_IDENTITY_HEADERS,
  DECISION_ID_HEADER,
  POLICY_VERSION_HEADER,
  SESSION_ID_HEADER,
  TRUSTED_CAPABILITY_HEADER,
  TRUSTED_CLIENT_HEADER,
  TRUSTED_CONSUMER_ORGANIZATION_HEADER,
  TRUSTED_CONTEXT_HEADERS,
  TRUSTED_CORRELATION_HEADER,
  TRUSTED_RESOURCE_HEADER,
  TRUSTED_RESOURCE_OWNER_ORGANIZATION_HEADER,
  TRUSTED_REQUIRED_OBLIGATIONS_HEADER,
  TRUSTED_SUBJECT_HEADER,
  TRUSTED_TENANT_HEADER,
  TRUSTED_USE_CASE_HEADER,
  USAGE_ACCOUNTING_KEYS_HEADER,
  USAGE_ADMISSION_ID_HEADER,
  USAGE_CONCURRENCY_LEASES_HEADER,
  USAGE_CURRENCY_ALLOCATIONS_HEADER,
  USAGE_POLICY_REVISIONS_HEADER,
} from "../shared/enforcement-headers"
import {
  MODEL_ROUTE_HANDOFF_HEADERS,
  ROUTE_CONNECTION_ID_HEADER,
  ROUTE_LEASE_ID_HEADER,
  ROUTE_PUBLIC_MODEL_HEADER,
  ROUTE_LEASE_REUSED_HEADER,
  ROUTE_PROVIDER_MODEL_HEADER,
  ROUTE_PROVIDER_CREDENTIAL_PROFILE_ID_HEADER,
  ROUTE_PROVIDER_CREDENTIAL_PROFILE_REVISION_HEADER,
  ROUTE_PROVIDER_CREDENTIAL_STRATEGY_DIGEST_HEADER,
} from "../shared/model-route-handoff"
import { operationalError, writeOperationalEvent } from "../../../../packages/telemetry/src/operational-log"
import type { UsageCounterStore } from "../shared/usage-governance"

interface HeaderValue {
  key?: string
  value?: string
  raw_value?: Buffer
}

interface ProcessingRequest {
  request_headers?: { headers?: { headers?: HeaderValue[] }; end_of_stream?: boolean }
  response_headers?: { headers?: { headers?: HeaderValue[] }; end_of_stream?: boolean }
  request_body?: { body?: Buffer; end_of_stream?: boolean }
  response_body?: { body?: Buffer; end_of_stream?: boolean }
  observability_mode?: boolean
}

export interface ProcessingCall extends grpc.ServerDuplexStream<ProcessingRequest, unknown> {}

/**
 * Headers used only while the request traverses the enforcement chain.
 * The authorizer removes the legacy/identity namespace first; keeping the
 * same deny-by-default cleanup here prevents a misconfigured filter chain
 * from forwarding policy context to an upstream provider.
 */
const INTERNAL_HEADERS_TO_REMOVE = [
  ...TRUSTED_CONTEXT_HEADERS,
  ...TRUSTED_RELEASE_HEADERS,
  ...MODEL_ROUTE_HANDOFF_HEADERS,
  SESSION_ID_HEADER,
  ...CALLER_IDENTITY_HEADERS,
  ROUTE_PUBLIC_MODEL_HEADER,
  DECISION_ID_HEADER,
  POLICY_VERSION_HEADER,
  BUNDLE_REVISION_HEADER,
  ALLOWED_PUBLIC_MODELS_HEADER,
  ALLOWED_MCP_TOOLS_HEADER,
  USAGE_ADMISSION_ID_HEADER,
  USAGE_ACCOUNTING_KEYS_HEADER,
  USAGE_CONCURRENCY_LEASES_HEADER,
  USAGE_POLICY_REVISIONS_HEADER,
  USAGE_CURRENCY_ALLOCATIONS_HEADER,
] as const

function headerMap(values: HeaderValue[] | undefined): Map<string, string> {
  const headers = new Map<string, string>()
  for (const header of values ?? []) {
    if (!header.key) throw new Error("malformed header without a key")
    const key = header.key.toLowerCase()
    const rawValue = header.raw_value?.length ? header.raw_value.toString("utf8") : undefined
    const textValue = header.value ?? ""
    if (rawValue !== undefined && textValue && rawValue !== textValue) {
      throw new Error(`conflicting ${key} header values`)
    }
    const value = rawValue ?? textValue
    const previous = headers.get(key)
    if (previous !== undefined) {
      throw new Error(
        previous === value ? `repeated ${key} header` : `conflicting ${key} headers`,
      )
    }
    headers.set(key, value)
  }
  return headers
}

function stringArrayHeader(headers: Map<string, string>, name: string): string[] {
  const value = optional(headers, name)
  if (!value) return []
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`${name} is invalid`)
  }
  return [...new Set(parsed)]
}

function currencyAllocationsHeader(
  headers: Map<string, string>,
): Array<{
  accounting_key_id: string
  allocation_id: string
  currency: string
  window_seconds: number
  window_bucket: number
}> {
  const value = optional(headers, USAGE_CURRENCY_ALLOCATIONS_HEADER)
  if (!value) return []
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) throw new Error(`${USAGE_CURRENCY_ALLOCATIONS_HEADER} is invalid`)
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${USAGE_CURRENCY_ALLOCATIONS_HEADER} is invalid`)
    }
    const allocation = entry as Record<string, unknown>
    if (
      typeof allocation.accounting_key_id !== "string" || !allocation.accounting_key_id ||
      typeof allocation.allocation_id !== "string" || !allocation.allocation_id ||
      typeof allocation.currency !== "string" || !/^[A-Z]{3}$/.test(allocation.currency) ||
      !Number.isSafeInteger(allocation.window_seconds) || Number(allocation.window_seconds) < 1 ||
      !Number.isSafeInteger(allocation.window_bucket) || Number(allocation.window_bucket) < 0
    ) throw new Error(`${USAGE_CURRENCY_ALLOCATIONS_HEADER} is invalid`)
    return {
      accounting_key_id: allocation.accounting_key_id,
      allocation_id: allocation.allocation_id,
      currency: allocation.currency,
      window_seconds: Number(allocation.window_seconds),
      window_bucket: Number(allocation.window_bucket),
    }
  })
}

function required(headers: Map<string, string>, name: string): string {
  const value = headers.get(name)?.trim()
  if (!value) throw new Error(`missing trusted ${name} header`)
  if (value.length > 2_048 || /[\u0000\r\n]/.test(value)) {
    throw new Error(`invalid trusted ${name} header`)
  }
  return value
}

function optional(headers: Map<string, string>, name: string): string | undefined {
  const raw = headers.get(name)
  if (raw === undefined) return undefined
  const value = raw.trim()
  if (!value || value.length > 2_048 || /[\u0000\r\n]/.test(value)) {
    throw new Error(`invalid ${name} header`)
  }
  return value
}

function positiveIntegerHeader(headers: Map<string, string>, name: string): number {
  const value = required(headers, name)
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`invalid trusted ${name} header`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid trusted ${name} header`)
  return parsed
}

function sha256Header(headers: Map<string, string>, name: string): string {
  const value = required(headers, name)
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`invalid trusted ${name} header`)
  return value
}

function processorStepsRequireSession(
  steps: readonly { hooks: { request?: { action: string }; response?: { action: string } } }[],
): boolean {
  return steps.some((step) =>
    [step.hooks.request, step.hooks.response].some(
      (hook) => hook?.action === "TOKENIZE" || hook?.action === "RESTORE",
    ),
  )
}

interface ExecutedProcessorStep {
  step_id: string
  action: string
}

interface ProcessorExecutionReceipt {
  bundleRevision: string
  requestSteps: ExecutedProcessorStep[]
  responseSteps: ExecutedProcessorStep[]
  dataClassifications: DataClassificationReceipt[]
}

const PROCESSOR_METADATA_NAMESPACE = "genio.one.processor"

function dynamicMetadata(receipt: ProcessorExecutionReceipt) {
  return {
    fields: {
      [PROCESSOR_METADATA_NAMESPACE]: {
        // google.protobuf.Value is loaded from the well-known type descriptor,
        // whose JavaScript field names stay camelCase even though the local
        // ext_proc messages use keepCase. Snake-case here serializes an empty
        // Value and silently drops the receipt on the wire.
        structValue: {
          fields: {
            bundle_revision: { stringValue: receipt.bundleRevision },
            ...(receipt.requestSteps.length > 0
              ? { request_steps: { stringValue: JSON.stringify(receipt.requestSteps) } }
              : {}),
            ...(receipt.responseSteps.length > 0
              ? { response_steps: { stringValue: JSON.stringify(receipt.responseSteps) } }
              : {}),
            ...(receipt.dataClassifications.length > 0
              ? { data_classifications: { stringValue: JSON.stringify(receipt.dataClassifications) } }
              : {}),
          },
        },
      },
    },
  }
}

function continueHeaders(
  receipt: ProcessorExecutionReceipt,
  preserveModelHeader = false,
) {
  const headersToRemove = preserveModelHeader
    ? INTERNAL_HEADERS_TO_REMOVE.filter((header) => header !== AI_GATEWAY_MODEL_HEADER)
    : INTERNAL_HEADERS_TO_REMOVE
  return {
    request_headers: {
      response: {
        status: 0,
        // Internal context is for the ext_proc chain only. Do not leak it
        // to an upstream provider after this processor has consumed it.
        header_mutation: {
          remove_headers: [...headersToRemove],
        },
      },
    },
    dynamic_metadata: dynamicMetadata(receipt),
  }
}

function continueWithoutMutation(
  direction: "request_body" | "response_body",
  receipt: ProcessorExecutionReceipt,
) {
  return {
    [direction]: {
      response: {
        status: 0,
      },
    },
    dynamic_metadata: dynamicMetadata(receipt),
  }
}

function continueResponseHeaders(
  receipt: ProcessorExecutionReceipt,
  correlationId: string,
) {
  return {
    response_headers: {
      response: {
        status: 0,
        header_mutation: {
          set_headers: [{
            header: {
              key: "x-genio-correlation-id",
              raw_value: Buffer.from(correlationId),
            },
            append_action: 2,
          }],
        },
      },
    },
    dynamic_metadata: dynamicMetadata(receipt),
  }
}

function continueBody(
  direction: "request_body" | "response_body",
  body: Uint8Array,
  receipt: ProcessorExecutionReceipt,
  selectedPublicModelName?: string,
) {
  const requestRouteMutation = direction === "request_body" && selectedPublicModelName
    ? {
        header_mutation: {
          set_headers: [{
            header: { key: "x-ai-eg-model", value: selectedPublicModelName },
            append_action: 2,
          }],
        },
        clear_route_cache: true,
      }
    : {}
  return {
    [direction]: {
      response: {
        status: 0,
        // ExtProc owns HTTP framing after a body mutation.  In particular,
        // content-length is a protected header unless the filter is explicitly
        // configured with allow_content_length_header.  Do not send a mutation
        // for it here: Envoy removes/recomputes the framing while applying the
        // body replacement, avoiding a rejected_header_mutations local 500.
        ...requestRouteMutation,
        body_mutation: { body },
      },
    },
    dynamic_metadata: dynamicMetadata(receipt),
  }
}

function blocked(matches: string[], receipt: ProcessorExecutionReceipt) {
  return {
    immediate_response: {
      status: { code: 403 },
      headers: {
        set_headers: [
          {
            header: { key: "content-type", raw_value: Buffer.from("application/json") },
            append_action: 2,
          },
        ],
      },
      body: Buffer.from(JSON.stringify({ code: "DATA_PROTECTION_BLOCKED", matches })),
      details: "genio_one_data_protection_blocked",
    },
    dynamic_metadata: dynamicMetadata(receipt),
  }
}

function processingError(error: unknown): Error & { code: grpc.status } {
  return Object.assign(
    new Error("processor request rejected", {
      cause: error instanceof Error ? error : undefined,
    }),
    { code: grpc.status.FAILED_PRECONDITION },
  )
}

export interface ExternalProcessorOptions {
  policySource: ProcessorPolicySource
  tokenVault: TokenVault
  modelRouter?: GatewayModelRouteResolver
  processorFactory?: (policy: ProcessorPolicy, tokenVault: TokenVault) => PayloadProcessor
  onActivity?: (event: GatewayActivityIngest) => void | Promise<void>
  detailCapture?: GatewayDetailCapture
  captureOnly?: boolean
  usageCounterStore?: Pick<UsageCounterStore, "releaseConcurrency" | "settleCurrency">
  onAccounting?: (event: {
    invocation: InvocationAccounting
    quantities: UsageQuantity[]
    valuations: Array<Omit<CostValuation, "charge_id">>
    currency_settlements: Array<Parameters<UsageCounterStore["settleCurrency"]>[0]>
  }) => void | Promise<void>
}

/**
 * Register the ext_proc stream handler. Envoy can send headers and body
 * chunks back-to-back; each body transform may perform async token-vault I/O.
 * Keep one promise chain per stream so responses retain the same order as
 * requests and SSE chunks cannot overtake each other.
 */
export function createExternalProcessorHandler(options: ExternalProcessorOptions) {
  return (call: ProcessingCall): void => {
    let context: ProcessingContext | undefined
    let processor: PayloadProcessor | undefined
    let requestContentType = ""
    let responseContentType = ""
    let allowedPublicModels: string[] = []
    let routingScope: GatewayRoutingScope | undefined
    let routeResolved = false
    let requestedPublicModel: string | undefined
    let requestMethod = "POST"
    let requestPath = "/"
    let responseStatus = 200
    let startedAt = Date.now()
    let requestProcessingConfigured = false
    let responseProcessingConfigured = false
    let captureContext: ProcessingContext | undefined
    let captureRequestContentType: string | null = null
    let captureResponseContentType: string | null = null
    let detailCaptureEnabled = false
    const captureRequestBody = new GatewayDetailBodyBuffer()
    const captureResponseBody = new GatewayDetailBodyBuffer()
    let captureWritten = false
    let routeLease: {
    leaseId: string
    reused: boolean
    connectionId: string
    providerModel: string
    providerCredentialProfileId?: string
    providerCredentialProfileRevision?: number
    providerCredentialStrategyDigest?: string
    publicModelName?: string
  } | undefined
    let executionReceipt: ProcessorExecutionReceipt | undefined
    const requestSse = new SseLineBuffer()
    const responseSse = new SseLineBuffer()
    const responseJsonChunks: Buffer[] = []
    let bypassLocalResponse = false
    let failed = false
    let queue = Promise.resolve()
    let usageLeaseIds: string[] = []
    let usageAdmissionId: string | undefined
    let usageAccountingKeys: string[] = []
    let usagePolicyRevisions: string[] = []
    let usageCurrencyAllocations: Array<{
      accounting_key_id: string
      allocation_id: string
      currency: string
      window_seconds: number
      window_bucket: number
    }> = []
    let consumerOrganizationId: string | undefined
    let resourceOwnerOrganizationId: string | undefined
    let useCaseId: string | undefined
    let usageLeasesReleased = false

    const releaseUsageLeases = async () => {
      if (usageLeasesReleased) return
      usageLeasesReleased = true
      if (!options.usageCounterStore) return
      await Promise.all(usageLeaseIds.map((lease_id) =>
        options.usageCounterStore!.releaseConcurrency({ lease_id }),
      ))
    }

    const fail = (error: unknown) => {
      if (failed) return
      failed = true
      writeOperationalEvent("processor", "ERROR", "genio.one.processor-stream-rejected", {
        correlation_id: context?.correlationId ?? null,
        capture_only: options.captureOnly ?? false,
        request_method: requestMethod,
        request_path: requestPath,
        response_status: responseStatus,
        ...operationalError(error),
      })
      void releaseUsageLeases().catch((releaseError) => {
        writeOperationalEvent("processor", "ERROR", "genio.one.usage-lease-release-failed", {
          correlation_id: context?.correlationId ?? null,
          ...operationalError(releaseError),
        })
      })
      call.destroy(processingError(error))
    }

    const writeCapture = async () => {
      if (captureWritten || !captureContext || !options.detailCapture) return
      captureWritten = true
      await options.detailCapture.capture({
        tenantId: captureContext.tenantId,
        correlationId: captureContext.correlationId,
        requestBody: captureRequestBody.body(),
        requestBodyTruncated: captureRequestBody.truncated(),
        requestContentType: captureRequestContentType,
        responseBody: captureResponseBody.body(),
        responseBodyTruncated: captureResponseBody.truncated(),
        responseContentType: captureResponseContentType,
      })
    }

    const observe = async (message: ProcessingRequest) => {
      if (message.request_headers) {
        const headers = headerMap(message.request_headers.headers?.headers)
        const correlationId = optional(headers, TRUSTED_CORRELATION_HEADER)
        if (!correlationId && options.captureOnly) return
        if (!correlationId) throw new Error(`missing trusted ${TRUSTED_CORRELATION_HEADER} header`)
        const snapshot = await options.policySource.current()
        detailCaptureEnabled = snapshot.captureMessageContent
        if (!snapshot.captureMessageContent) return
        const authorizedRelease = trustedReleaseFromHeaders((name) => required(headers, name))
        if (!gatewayGroupReleaseReferencesEqual(snapshot.releaseReference, authorizedRelease)) {
          throw new Error("detail capture release does not match authorization release")
        }
        captureContext = {
          tenantId: required(headers, TRUSTED_TENANT_HEADER),
          subjectId: required(headers, TRUSTED_SUBJECT_HEADER),
          clientId: required(headers, TRUSTED_CLIENT_HEADER),
          resourceId: required(headers, TRUSTED_RESOURCE_HEADER),
          capabilityId: required(headers, TRUSTED_CAPABILITY_HEADER),
          sessionId: optional(headers, SESSION_ID_HEADER) ?? `request:${correlationId}`,
          correlationId,
        }
        captureRequestContentType = headers.get("content-type") ?? null
        return
      }
      if (!captureContext) return
      if (message.request_body) {
        captureRequestBody.append(message.request_body.body ?? Buffer.alloc(0))
        return
      }
      if (message.response_headers) {
        const headers = headerMap(message.response_headers.headers?.headers)
        captureResponseContentType = headers.get("content-type") ?? null
        if (message.response_headers.end_of_stream) await writeCapture()
        return
      }
      if (message.response_body) {
        captureResponseBody.append(message.response_body.body ?? Buffer.alloc(0))
        if (message.response_body.end_of_stream) await writeCapture()
      }
    }

    const continueCapture = (message: ProcessingRequest) => {
      if (message.request_headers) return { request_headers: { response: { status: 0 } } }
      if (message.response_headers) return { response_headers: { response: { status: 0 } } }
      if (message.request_body) return { request_body: { response: { status: 0 } } }
      if (message.response_body) return { response_body: { response: { status: 0 } } }
      throw new Error("detail capture message has no supported request variant")
    }

    const handle = async (message: ProcessingRequest): Promise<void> => {
      if (message.observability_mode || options.captureOnly) {
        await observe(message)
        if (options.captureOnly && !message.observability_mode) {
          call.write(continueCapture(message))
        }
        return
      }
      const variants = [
        message.request_headers,
        message.response_headers,
        message.request_body,
        message.response_body,
      ].filter(Boolean)
      if (variants.length !== 1) {
        throw new Error(
          variants.length === 0
            ? "ext_proc message has no request variant"
            : "ext_proc message has multiple request variants",
        )
      }
      if (message.request_headers) {
        if (context) throw new Error("request headers must be processed only once")
        const headers = headerMap(message.request_headers.headers?.headers)
        requestMethod = headers.get(":method") ?? "POST"
        requestPath = headers.get(":path") ?? "/"
        startedAt = Date.now()
        const correlationId = required(headers, TRUSTED_CORRELATION_HEADER)
        const sessionId = optional(headers, SESSION_ID_HEADER)
        usageLeaseIds = stringArrayHeader(headers, USAGE_CONCURRENCY_LEASES_HEADER)
        usageAdmissionId = optional(headers, USAGE_ADMISSION_ID_HEADER)
        usageAccountingKeys = stringArrayHeader(headers, USAGE_ACCOUNTING_KEYS_HEADER)
        usagePolicyRevisions = stringArrayHeader(headers, USAGE_POLICY_REVISIONS_HEADER)
        usageCurrencyAllocations = currencyAllocationsHeader(headers)
        consumerOrganizationId = optional(headers, TRUSTED_CONSUMER_ORGANIZATION_HEADER)
        resourceOwnerOrganizationId = optional(headers, TRUSTED_RESOURCE_OWNER_ORGANIZATION_HEADER)
        useCaseId = optional(headers, TRUSTED_USE_CASE_HEADER)
        if (usageAccountingKeys.length > 0) {
          consumerOrganizationId = required(headers, TRUSTED_CONSUMER_ORGANIZATION_HEADER)
          resourceOwnerOrganizationId = required(headers, TRUSTED_RESOURCE_OWNER_ORGANIZATION_HEADER)
          useCaseId = required(headers, TRUSTED_USE_CASE_HEADER)
        }
        context = {
          // These values must have been written by ext_authz.  The similarly
          // named caller x-genio-* headers are intentionally never consulted.
          tenantId: required(headers, TRUSTED_TENANT_HEADER),
          subjectId: required(headers, TRUSTED_SUBJECT_HEADER),
          clientId: required(headers, TRUSTED_CLIENT_HEADER),
          resourceId: required(headers, TRUSTED_RESOURCE_HEADER),
          capabilityId: required(headers, TRUSTED_CAPABILITY_HEADER),
          // Stateless deterministic routing does not require a caller session.
          // Keep a request-scoped internal value so non-vault processors can
          // share one context shape; session routing and reversible token
          // operations are checked explicitly below and still fail closed.
          sessionId: sessionId ?? `request:${correlationId}`,
          correlationId,
        }
        const bundleRevision = required(headers, BUNDLE_REVISION_HEADER)
        const authorizedRelease = trustedReleaseFromHeaders((name) =>
          required(headers, name),
        )
        const snapshot = await options.policySource.current()
        detailCaptureEnabled = snapshot.captureMessageContent
        if (snapshot.bundleRevision !== bundleRevision) {
          throw new Error("processor policy release does not match authorization revision")
        }
        if (!gatewayGroupReleaseReferencesEqual(snapshot.releaseReference, authorizedRelease)) {
          throw new Error("processor policy release does not match authorization release")
        }
        const steps = snapshot.stepsFor(context.resourceId, context.capabilityId) ?? []
        requestProcessingConfigured = steps.some((step) => Boolean(step.hooks.request))
        responseProcessingConfigured = steps.some((step) => Boolean(step.hooks.response))
        if (steps.length > 0) {
          process.stdout.write(`${JSON.stringify({
            event: "genio.one.processor-chain-started",
            correlation_id: context.correlationId,
            resource_id: context.resourceId,
            capability_id: context.capabilityId,
            request_end_of_stream: Boolean(message.request_headers.end_of_stream),
            step_count: steps.length,
          })}\n`)
        }
        executionReceipt = {
          bundleRevision: snapshot.bundleRevision,
          // The route orders ext_proc after the fail-closed Lua request bridge.
          // Reaching ext_proc request headers therefore acknowledges that the
          // same signed scope's request hooks completed. Carry them forward so
          // the response receipt does not erase the earlier Lua metadata.
          requestSteps: steps.flatMap((step) => step.hooks.request
            ? [{
                step_id: step.step_id,
                action: step.hooks.request.action as DataProtectionAction,
              }]
            : []),
          responseSteps: [],
          dataClassifications: [],
        }
        const baseRoutingScope = snapshot.routingScopeFor(context.resourceId, context.capabilityId)
        routingScope = baseRoutingScope
          ? narrowGatewayRoutingScopeByObligations(
              baseRoutingScope,
              stringArrayHeader(headers, TRUSTED_REQUIRED_OBLIGATIONS_HEADER),
            )
          : undefined
        if (!routingScope && steps.length === 0) {
          throw new Error("processor policy and routing scope are unavailable")
        }
        if (
          !sessionId &&
          (
            routingScope?.route_mode === "SESSION_LEASE" ||
            processorStepsRequireSession(steps)
          )
        ) {
          throw new Error(`missing ${SESSION_ID_HEADER} header`)
        }
        const routeLeaseId = optional(headers, ROUTE_LEASE_ID_HEADER)
        if (routeLeaseId) {
          const reused = required(headers, ROUTE_LEASE_REUSED_HEADER)
          if (reused !== "true" && reused !== "false") {
            throw new Error("model route lease reused evidence is invalid")
          }
          const hasProviderCredentialBinding = [
            ROUTE_PROVIDER_CREDENTIAL_PROFILE_ID_HEADER,
            ROUTE_PROVIDER_CREDENTIAL_PROFILE_REVISION_HEADER,
            ROUTE_PROVIDER_CREDENTIAL_STRATEGY_DIGEST_HEADER,
          ].some((name) => headers.has(name))
          routeLease = {
            leaseId: routeLeaseId,
            reused: reused === "true",
            connectionId: required(headers, ROUTE_CONNECTION_ID_HEADER),
            providerModel: required(headers, ROUTE_PROVIDER_MODEL_HEADER),
            ...(hasProviderCredentialBinding ? {
              providerCredentialProfileId: required(headers, ROUTE_PROVIDER_CREDENTIAL_PROFILE_ID_HEADER),
              providerCredentialProfileRevision: positiveIntegerHeader(
                headers,
                ROUTE_PROVIDER_CREDENTIAL_PROFILE_REVISION_HEADER,
              ),
              providerCredentialStrategyDigest: sha256Header(
                headers,
                ROUTE_PROVIDER_CREDENTIAL_STRATEGY_DIGEST_HEADER,
              ),
            } : {}),
          }
        } else if (MODEL_ROUTE_HANDOFF_HEADERS.some((name) => headers.has(name))) {
          throw new Error("model route lease evidence is incomplete")
        }
        processor = steps.length > 0
          ? createProcessorChain(
              steps,
              options.tokenVault,
              snapshot.bundleRevision,
              options.processorFactory,
            )
          : {
              protectJson: async (_context, body) => ({ disposition: "CONTINUE", body, matches: [] }),
              protectSseLine: async (_context, line) => ({
                disposition: "CONTINUE",
                body: Buffer.from(line),
                matches: [],
              }),
              restoreJson: async (_context, body) => ({ disposition: "CONTINUE", body, matches: [] }),
              restoreSseLine: async (_context, line) => ({
                disposition: "CONTINUE",
                body: Buffer.from(line),
                matches: [],
              }),
            }
        allowedPublicModels = (headers.get(ALLOWED_PUBLIC_MODELS_HEADER) ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
        // A deterministic route does not create a lease or emit route
        // handoff headers. When authorization narrowed the request to one
        // public model, retain that trusted alias so the completion receipt
        // can resolve its Resource-owned Connection for usage/cost enrichment.
        if (!requestedPublicModel && allowedPublicModels.length === 1) {
          requestedPublicModel = allowedPublicModels[0]
        }
        requestContentType = headers.get("content-type") ?? ""
        call.write(continueHeaders(
          executionReceipt,
          routingScope?.route_mode === "SESSION_LEASE",
        ))
        return
      }
      if (message.response_headers) {
        if (!context || !processor || !executionReceipt) {
          const headers = headerMap(message.response_headers.headers?.headers)
          const status = Number.parseInt(headers.get(":status") ?? "", 10)
          if (!Number.isInteger(status) || status < 400) {
            throw new Error("request headers must be processed before response headers")
          }
          // A preceding fail-closed Lua request hook may create a local 4xx/5xx
          // before ext_proc receives request headers. Preserve that decision;
          // it has already stopped the provider hop and carries its own receipt.
          bypassLocalResponse = true
          call.write({ response_headers: { response: { status: 0 } } })
          return
        }
        if (routingScope?.route_mode === "SESSION_LEASE" && !routeLease) {
          throw new Error("session model route lease evidence is missing")
        }
        const headers = headerMap(message.response_headers.headers?.headers)
        responseContentType = headers.get("content-type") ?? ""
        const parsedStatus = Number.parseInt(headers.get(":status") ?? "200", 10)
        responseStatus = Number.isInteger(parsedStatus) ? parsedStatus : 200
        call.write(continueResponseHeaders(executionReceipt, context.correlationId))
        return
      }
      if (message.response_body && bypassLocalResponse) {
        call.write({
          response_body: {
            response: {
              status: 0,
              body_mutation: { body: message.response_body.body ?? Buffer.alloc(0) },
            },
          },
        })
        return
      }
      if (!context || !processor || !executionReceipt) {
        throw new Error("request headers must be processed before body")
      }
      if (message.request_body) {
        const originalBody = message.request_body.body ?? Buffer.alloc(0)
        const prepared = await prepareTranscriptionRequest(originalBody, requestContentType, requestProcessingConfigured)
        const body = prepared.body
        const requestedPublicModelName = routingScope
          ? requestPublicModelName(body)
          : undefined
        requestedPublicModel = requestedPublicModelName
        process.stdout.write(`${JSON.stringify({
          event: "genio.one.processor-request-body-received",
          correlation_id: context.correlationId,
          body_bytes: body.byteLength,
          end_of_stream: Boolean(message.request_body.end_of_stream),
        })}\n`)
        const result = requestContentType.includes("text/event-stream")
          ? await requestSse.push(body, Boolean(message.request_body.end_of_stream), (line) =>
              processor!.protectSseLine(context!, line),
            )
          : await processor.protectJson(context, body)
        let outputBody = result.body
        if (
          result.disposition === "CONTINUE" &&
          routingScope?.route_mode === "SESSION_LEASE"
        ) {
          if (routeResolved) throw new Error("session route body must be processed only once")
          if (!options.modelRouter) throw new Error("session model router is unavailable")
          const resolution = await options.modelRouter.resolve({
            context,
            scope: routingScope,
            body: result.body,
            requestedPublicModelName,
            allowedPublicModels,
          })
          routeResolved = true
          routeLease = {
            leaseId: resolution.lease.lease_id,
            reused: resolution.reused,
            connectionId: resolution.lease.connection_id,
            providerModel: resolution.lease.provider_model,
            publicModelName: resolution.lease.selected_public_model_name,
          }
          outputBody = Buffer.from(resolution.body)
          process.stdout.write(`${JSON.stringify(gatewayModelRouteLeaseEvent(context, resolution))}\n`)
        }
        if (result.disposition !== "BLOCK") outputBody = Buffer.from(prepared.restore(outputBody))
        for (const step of result.executedSteps ?? []) {
          if (!executionReceipt.requestSteps.some((existing) =>
            existing.step_id === step.stepId && existing.action === step.action
          )) {
            executionReceipt.requestSteps.push({ step_id: step.stepId, action: step.action })
          }
        }
        mergeDataClassificationReceipts(
          executionReceipt.dataClassifications,
          result.dataClassifications ?? [],
        )
        process.stdout.write(`${JSON.stringify({
          event: "genio.one.processor-request-chain-completed",
          correlation_id: context.correlationId,
          disposition: result.disposition,
          output_body_bytes: outputBody.byteLength,
          request_steps: executionReceipt.requestSteps,
          match_names: result.matches,
          data_classifications: executionReceipt.dataClassifications,
        })}\n`)
        call.write(
          result.disposition === "BLOCK"
            ? blocked(result.matches, executionReceipt)
            : continueBody(
                "request_body",
                outputBody,
                executionReceipt,
                routeLease?.publicModelName,
              ),
        )
        return
      }
      if (message.response_body) {
        const body = message.response_body.body ?? Buffer.alloc(0)
        const endOfStream = Boolean(message.response_body.end_of_stream)
        let result: DataProtectionResult
        if (responseContentType.includes("text/event-stream")) {
          result = await responseSse.push(body, endOfStream, (line) =>
              processor!.restoreSseLine(context!, line),
            )
        } else {
          responseJsonChunks.push(Buffer.from(body))
          result = endOfStream
            ? await processor.restoreJson(context, Buffer.concat(responseJsonChunks))
            : {
                disposition: "CONTINUE" as const,
                body: Buffer.alloc(0),
                matches: [],
              }
        }
        for (const step of result.executedSteps ?? []) {
          if (!executionReceipt.responseSteps.some((existing) =>
            existing.step_id === step.stepId && existing.action === step.action
          )) {
            executionReceipt.responseSteps.push({ step_id: step.stepId, action: step.action })
          }
        }
        call.write(
          result.disposition === "BLOCK"
            ? blocked(result.matches, executionReceipt)
            : responseProcessingConfigured
              ? continueBody("response_body", result.body, executionReceipt)
              : continueWithoutMutation("response_body", executionReceipt),
        )
        if (endOfStream && (options.onActivity || options.onAccounting)) {
          const occurredAt = Math.floor(Date.now() / 1_000)
          let response: Record<string, any> | undefined
          if (!responseContentType.includes("text/event-stream")) {
            try {
              response = JSON.parse(Buffer.from(result.body).toString("utf8")) as Record<string, any>
            } catch {
              response = undefined
            }
          }
          const usage = response?.usage && typeof response.usage === "object"
            ? response.usage as Record<string, unknown>
            : undefined
          const selectedCandidate = routingScope?.candidates.find(
            (candidate) => candidate.public_model_name === requestedPublicModel,
          )
          const selectedMapping = routeLease
            ? selectedCandidate?.mappings.find((mapping) => mapping.connection_id === routeLease?.connectionId)
            : selectedCandidate?.mappings[0]
          const inputTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined
          const outputTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined
          const estimatedCostMicros = selectedMapping?.pricing && inputTokens !== undefined && outputTokens !== undefined
            ? Math.round(
                inputTokens * selectedMapping.pricing.input_cost_per_token_micros +
                outputTokens * selectedMapping.pricing.output_cost_per_token_micros,
              )
            : undefined
          if (options.onAccounting && consumerOrganizationId && resourceOwnerOrganizationId && useCaseId) {
            for (const accountingKeyId of usageAccountingKeys) {
              const invocationId = `invocation-${createHash("sha256")
                .update(context.correlationId)
                .update("\0")
                .update(accountingKeyId)
                .digest("hex")}`
              const quantities = [
                [usage?.prompt_tokens, "INPUT_TOKENS"],
                [usage?.completion_tokens, "OUTPUT_TOKENS"],
                [usage?.total_tokens, "TOTAL_TOKENS"],
              ].flatMap(([quantity, unit]) =>
                typeof quantity === "number" && Number.isFinite(quantity) && quantity >= 0
                  ? [{
                      quantity_id: `quantity-${createHash("sha256").update(invocationId).update("\0").update(String(unit)).digest("hex")}`,
                      invocation_id: invocationId,
                      quantity,
                      unit: String(unit),
                      trusted_source: "PROVIDER_RESPONSE",
                      observed_at: occurredAt,
                    }]
                  : [],
              )
              const invocation: InvocationAccounting = {
                invocation_id: invocationId,
                correlation_id: context.correlationId,
                tenant_id: context.tenantId,
                subject_id: context.subjectId,
                consumer_organization_id: consumerOrganizationId,
                resource_owner_organization_id: resourceOwnerOrganizationId,
                resource_id: context.resourceId,
                capability_id: context.capabilityId,
                use_case_id: useCaseId,
                usage_policy_revisions: usagePolicyRevisions,
                release_revision: executionReceipt.bundleRevision,
                accounting_key_id: accountingKeyId,
                created_at: occurredAt,
              }
              const valuations: Array<Omit<CostValuation, "charge_id">> = selectedMapping?.pricing && estimatedCostMicros !== undefined
                ? [{
                    valuation_id: `valuation-${createHash("sha256").update(invocationId).update("\0ESTIMATED\0").update(selectedMapping.pricing.version).digest("hex")}`,
                    status: "ESTIMATED",
                    currency: selectedMapping.pricing.currency,
                    amount_micros: estimatedCostMicros,
                    pricing_source: selectedMapping.pricing.source,
                    pricing_version: selectedMapping.pricing.version,
                    valued_at: occurredAt,
                }]
                : []
              const currencySettlements = estimatedCostMicros === undefined
                ? []
                : usageCurrencyAllocations
                    .filter((allocation) =>
                      allocation.accounting_key_id === accountingKeyId &&
                      allocation.currency === selectedMapping?.pricing?.currency
                    )
                    .map((allocation) => ({
                      settlement_id: invocationId,
                      accounting_key_id: allocation.accounting_key_id,
                      allocation_id: allocation.allocation_id,
                      window_seconds: allocation.window_seconds,
                      window_bucket: allocation.window_bucket,
                      amount_micros: estimatedCostMicros,
                    }))
              if (estimatedCostMicros !== undefined && options.usageCounterStore) {
                void Promise.all(currencySettlements.map((settlement) =>
                  options.usageCounterStore!.settleCurrency(settlement)))
                  .catch((error) => {
                    writeOperationalEvent("processor", "ERROR", "genio.one.currency-settlement-failed", {
                      correlation_id: context?.correlationId ?? null,
                      accounting_key_id: accountingKeyId,
                      ...operationalError(error),
                    })
                  })
              }
              void Promise.resolve(options.onAccounting({
                invocation,
                quantities,
                valuations,
                currency_settlements: currencySettlements,
              })).catch((error) => {
                writeOperationalEvent("processor", "ERROR", "genio.one.accounting-observation-failed", {
                  correlation_id: context?.correlationId ?? null,
                  accounting_key_id: accountingKeyId,
                  ...operationalError(error),
                })
              })
            }
          }
          const event: GatewayActivityIngest = {
            correlation_id: context.correlationId,
            resource_id: context.resourceId,
            capability_id: context.capabilityId,
            application_id: null,
            subject_id: context.subjectId,
            acting_client_id: context.clientId,
            session_id: context.sessionId ?? null,
            entitlement_id: null,
            usage_admission_id: usageAdmissionId ?? null,
            usage_admission_disposition: usageAdmissionId ? "ADMIT" : "NOT_APPLICABLE",
            usage_admission_reason: null,
            consumer_organization_id: consumerOrganizationId ?? null,
            resource_owner_organization_id: resourceOwnerOrganizationId ?? null,
            use_case_id: useCaseId ?? null,
            enforcement_point_id: "AI_GATEWAY",
            route: "MANAGED",
            method: requestMethod,
            path: requestPath,
            status_code: responseStatus,
            outcome: responseStatus >= 200 && responseStatus < 400 ? "COMPLETED" : "FAILED",
            error_code: responseStatus >= 400 ? `HTTP_${responseStatus}` : null,
            latency_millis: Math.max(0, Date.now() - startedAt),
            upstream_attempted: true,
            requested_model_id: requestedPublicModel ?? null,
            effective_model_id: typeof response?.model === "string"
              ? response.model
              : routeLease?.providerModel ?? selectedMapping?.provider_model ?? null,
            provider_id: null,
            connection_id: routeLease?.connectionId ?? selectedMapping?.connection_id ?? null,
            mcp_method: null,
            mcp_tool: null,
            mcp_backend: null,
            processor_bundle_revision: executionReceipt.bundleRevision,
            processor_request_steps: executionReceipt.requestSteps,
            processor_response_steps: executionReceipt.responseSteps,
            data_classifications: executionReceipt.dataClassifications,
            input_tokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null,
            output_tokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null,
            total_tokens: typeof usage?.total_tokens === "number" ? usage.total_tokens : null,
            route_mode: routingScope?.route_mode ?? null,
            route_lease_id: routeLease?.leaseId ?? null,
            route_lease_reused: routeLease?.reused ?? null,
            provider_credential_profile_id: routeLease?.providerCredentialProfileId ?? selectedMapping?.provider_credential_profile_id ?? null,
            provider_credential_profile_revision: routeLease?.providerCredentialProfileRevision ?? selectedMapping?.provider_credential_profile_revision ?? null,
            provider_credential_strategy_digest: routeLease?.providerCredentialStrategyDigest ?? selectedMapping?.provider_credential_strategy_digest ?? null,
            routing_policy_id: routingScope?.routing_policy_id ?? null,
            routing_revision: routingScope?.routing_revision ?? null,
            candidate_set_digest: routingScope?.candidate_set_digest ?? null,
            candidate_connection_ids: routingScope
              ? [...new Set(routingScope.candidates.flatMap((candidate) => candidate.mappings.map((mapping) => mapping.connection_id)))]
              : [],
            ...gatewayDetailActivityReference(
              detailCaptureEnabled,
              context.correlationId,
              occurredAt,
            ),
            occurred_at: occurredAt,
          }
          if (options.onActivity) void Promise.resolve(options.onActivity(event)).catch((error) => {
            writeOperationalEvent("processor", "ERROR", "genio.one.activity-observation-failed", {
              correlation_id: context?.correlationId ?? null,
              ...operationalError(error),
            })
          })
        }
      }
    }

    call.on("data", (message) => {
      queue = queue
        .then(async () => {
          if (!failed) await handle(message)
        })
        .catch(fail)
    })
    call.on("end", () => {
      queue
        .then(async () => {
          if (captureContext && !captureWritten) await writeCapture()
          await releaseUsageLeases()
          if (!failed) call.end()
        })
        .catch(fail)
    })
    for (const event of ["cancelled", "error", "close"]) {
      call.on(event, () => {
        void releaseUsageLeases().catch((releaseError) => {
          writeOperationalEvent("processor", "ERROR", "genio.one.usage-lease-release-failed", {
            correlation_id: context?.correlationId ?? null,
            ...operationalError(releaseError),
          })
        })
      })
    }
  }
}

export function createExternalProcessorServer(options: ExternalProcessorOptions): grpc.Server {
  const protoPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "proto/external_processor_minimal.proto",
  )
  readFileSync(protoPath)
  const definition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
  })
  const descriptor = grpc.loadPackageDefinition(definition) as Record<string, any>
  const service = descriptor.envoy.service.ext_proc.v3.ExternalProcessor.service
  const server = new grpc.Server()
  server.addService(service, { Process: createExternalProcessorHandler(options) })
  return server
}
