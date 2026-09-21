import { prepareTranscriptionRequest } from "../shared/audio-transcription"
import { createServer, type Server } from "node:http"

import type { ProcessingContext, ProcessorPolicy } from "./contract"
import { createProcessorChain, SseLineBuffer, type PayloadProcessor } from "./module"
import type { ProcessorPolicySource } from "./policy-store"
import type { TokenVault } from "./token-vault"
import {
  gatewayModelRouteLeaseEvent,
  requestPublicModelName,
  type GatewayModelRouteResolver,
} from "./model-route-lease"
import {
  ALLOWED_PUBLIC_MODELS_HEADER,
  BUNDLE_REVISION_HEADER,
  REQUEST_ID_HEADER,
  SESSION_ID_HEADER,
  TRUSTED_CAPABILITY_HEADER,
  TRUSTED_CLIENT_HEADER,
  TRUSTED_CORRELATION_HEADER,
  TRUSTED_CONSUMER_ORGANIZATION_HEADER,
  TRUSTED_RESOURCE_HEADER,
  TRUSTED_RESOURCE_OWNER_ORGANIZATION_HEADER,
  TRUSTED_REQUIRED_OBLIGATIONS_HEADER,
  TRUSTED_SUBJECT_HEADER,
  TRUSTED_TENANT_HEADER,
  TRUSTED_USE_CASE_HEADER,
  USAGE_ADMISSION_ID_HEADER,
} from "../shared/enforcement-headers"
import {
  gatewayGroupReleaseReferencesEqual,
  trustedReleaseFromHeaders,
} from "../shared/release-handoff"
import {
  ROUTE_CONNECTION_ID_HEADER,
  ROUTE_LEASE_ID_HEADER,
  ROUTE_PUBLIC_MODEL_HEADER,
  ROUTE_LEASE_REUSED_HEADER,
  ROUTE_PROVIDER_MODEL_HEADER,
  ROUTE_PROVIDER_CREDENTIAL_PROFILE_ID_HEADER,
  ROUTE_PROVIDER_CREDENTIAL_PROFILE_REVISION_HEADER,
  ROUTE_PROVIDER_CREDENTIAL_STRATEGY_DIGEST_HEADER,
} from "../shared/model-route-handoff"
import { operationalError, writeOperationalEvent } from "@genioone/telemetry/operational-log"
import { gatewayDetailActivityReference } from "@genioone/telemetry/otlp-detail-capture"
import type { GatewayActivityIngest } from "../shared/gateway-activity"
import { narrowGatewayRoutingScopeByObligations } from "../shared/gateway-routing-artifact"

const PROCESSOR_STEPS_HEADER = "x-genio-processor-steps"
const PROCESSOR_BUNDLE_HEADER = "x-genio-processor-bundle-revision"

interface ProcessorHttpBridgeOptions {
  listen: string
  policySource: ProcessorPolicySource
  tokenVault: TokenVault
  modelRouter?: GatewayModelRouteResolver
  processorFactory?: (policy: ProcessorPolicy, tokenVault: TokenVault) => PayloadProcessor
  onActivity?: (event: GatewayActivityIngest) => Promise<void> | void
}

function required(headers: Headers, name: string): string {
  const value = headers.get(name)?.trim()
  if (!value || value.length > 2_048 || /[\u0000\r\n]/.test(value)) {
    throw new Error(`missing or invalid ${name} header`)
  }
  return value
}

function stringArrayHeader(headers: Headers, name: string): string[] {
  const value = headers.get(name)?.trim()
  if (!value) return []
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`${name} is invalid`)
  }
  return [...new Set(parsed)]
}

function optional(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim()
  if (value === undefined || value === "") return undefined
  if (value.length > 2_048 || /[\u0000\r\n]/.test(value)) {
    throw new Error(`invalid ${name} header`)
  }
  return value
}

function stepsRequireSession(
  steps: readonly { hooks: { request?: { action: string }; response?: { action: string } } }[],
): boolean {
  return steps.some((step) =>
    [step.hooks.request, step.hooks.response].some(
      (hook) => hook?.action === "TOKENIZE" || hook?.action === "RESTORE",
    ),
  )
}

function errorResponse(status: number, code: string): Response {
  return Response.json({ code }, { status })
}

/**
 * HTTP bridge used by the Envoy Lua filter that runs before the native AIGW
 * request translator. Lua owns no policy semantics: it transports the body
 * and trusted extAuth context to this service, while the signed processor
 * bundle remains the only executable policy source.
 */
export function startProcessorHttpBridge(
  options: ProcessorHttpBridgeOptions,
): Server {
  const separator = options.listen.lastIndexOf(":")
  const hostname = options.listen.slice(0, separator)
  const port = Number.parseInt(options.listen.slice(separator + 1), 10)
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("GENIO_ONE_AI_PROCESSOR_HTTP_LISTEN must be host:port")
  }

  const handle = async (request: Request): Promise<Response> => {
      const url = new URL(request.url)
      // Envoy Gateway prefixes direct cluster calls with the generated
      // HTTPRoute backend path. The bridge contract is the final path segment;
      // accept only that exact suffix and keep every other route fail-closed.
      const direction = url.pathname.endsWith("/v1/process/request")
        ? "request"
        : url.pathname.endsWith("/v1/process/response")
          ? "response"
          : undefined
      if (request.method !== "POST" || !direction) {
        writeOperationalEvent("processor", "WARN", "genio.one.processor-http-route-not-found", {
          method: request.method,
          pathname: url.pathname,
        })
        return errorResponse(404, "PROCESSOR_ROUTE_NOT_FOUND")
      }
      try {
        const correlationId = required(request.headers, REQUEST_ID_HEADER)
        const trustedCorrelation = required(request.headers, TRUSTED_CORRELATION_HEADER)
        if (trustedCorrelation !== correlationId) {
          throw new Error("trusted correlation does not match x-request-id")
        }
        const sessionId = optional(request.headers, SESSION_ID_HEADER)
        const context: ProcessingContext = {
          tenantId: required(request.headers, TRUSTED_TENANT_HEADER),
          subjectId: required(request.headers, TRUSTED_SUBJECT_HEADER),
          clientId: required(request.headers, TRUSTED_CLIENT_HEADER),
          resourceId: required(request.headers, TRUSTED_RESOURCE_HEADER),
          capabilityId: required(request.headers, TRUSTED_CAPABILITY_HEADER),
          sessionId: sessionId ?? `request:${correlationId}`,
          correlationId,
        }
        const bundleRevision = required(request.headers, BUNDLE_REVISION_HEADER)
        const authorizedRelease = trustedReleaseFromHeaders((name) =>
          required(request.headers, name),
        )
        const snapshot = await options.policySource.current()
        if (snapshot.bundleRevision !== bundleRevision) {
          throw new Error("processor policy release does not match authorization revision")
        }
        if (!gatewayGroupReleaseReferencesEqual(snapshot.releaseReference, authorizedRelease)) {
          throw new Error("processor policy release does not match authorization release")
        }
        const steps = snapshot.stepsFor(context.resourceId, context.capabilityId) ?? []
        const baseRoutingScope = snapshot.routingScopeFor(context.resourceId, context.capabilityId)
        const routingScope = baseRoutingScope
          ? narrowGatewayRoutingScopeByObligations(
              baseRoutingScope,
              stringArrayHeader(request.headers, TRUSTED_REQUIRED_OBLIGATIONS_HEADER),
            )
          : undefined
        if (!routingScope && steps.length === 0) {
          throw new Error("processor policy and routing scope are unavailable")
        }
        if (
          !sessionId &&
          (routingScope?.route_mode === "SESSION_LEASE" || stepsRequireSession(steps))
        ) {
          throw new Error(`missing ${SESSION_ID_HEADER} header`)
        }
        const contentType = request.headers.get("content-type") ?? ""
        const originalMethod = request.headers.get("x-genio-original-method") ?? "POST"
        const originalPath = request.headers.get("x-genio-original-path") ?? "/"
        const isEventStream = contentType.includes("text/event-stream")
        const processor: PayloadProcessor = steps.length > 0
          ? createProcessorChain(
              steps,
              options.tokenVault,
              snapshot.bundleRevision,
              options.processorFactory,
            )
          : {
              protectJson: async (_context: ProcessingContext, body: Uint8Array) => ({
                disposition: "CONTINUE" as const,
                body,
                matches: [],
              }),
              protectSseLine: async (_context: ProcessingContext, line: string) => ({
                disposition: "CONTINUE" as const,
                body: Buffer.from(line),
                matches: [],
              }),
              restoreJson: async (_context: ProcessingContext, body: Uint8Array) => ({
                disposition: "CONTINUE" as const,
                body,
                matches: [],
              }),
              restoreSseLine: async (_context: ProcessingContext, line: string) => ({
                disposition: "CONTINUE" as const,
                body: Buffer.from(line),
                matches: [],
              }),
            }
        const originalBody = new Uint8Array(await request.arrayBuffer())
        const prepared = direction === "request"
          ? await prepareTranscriptionRequest(originalBody, contentType, steps.some((step) => Boolean(step.hooks.request)))
          : { body: originalBody, restore: (body: Uint8Array) => body }
        const body = prepared.body
        const requestedPublicModelName = direction === "request" && routingScope
          ? requestPublicModelName(body)
          : undefined
        const result = isEventStream
          ? await new SseLineBuffer().push(body, true, (line) =>
              direction === "request"
                ? processor.protectSseLine(context, line)
                : processor.restoreSseLine(context, line),
            )
          : direction === "request"
            ? await processor.protectJson(context, body)
            : await processor.restoreJson(context, body)
        let outputBody = result.body
        const routeHeaders: Record<string, string> = {}
        if (
          result.disposition === "CONTINUE" &&
          direction === "request" &&
          routingScope?.route_mode === "SESSION_LEASE"
        ) {
          if (!options.modelRouter) throw new Error("session model router is unavailable")
          const allowedPublicModels = (request.headers.get(ALLOWED_PUBLIC_MODELS_HEADER) ?? "")
            .split(",")
            .map((value: string) => value.trim())
            .filter(Boolean)
          const resolution = await options.modelRouter.resolve({
            context,
            scope: routingScope,
            body: result.body,
            requestedPublicModelName,
            allowedPublicModels,
          })
          outputBody = new Uint8Array(resolution.body)
          routeHeaders[ROUTE_LEASE_ID_HEADER] = resolution.lease.lease_id
          routeHeaders[ROUTE_LEASE_REUSED_HEADER] = String(resolution.reused)
          routeHeaders[ROUTE_CONNECTION_ID_HEADER] = resolution.lease.connection_id
          routeHeaders[ROUTE_PROVIDER_MODEL_HEADER] = resolution.lease.provider_model
          routeHeaders[ROUTE_PUBLIC_MODEL_HEADER] = resolution.lease.selected_public_model_name
          if (resolution.lease.provider_credential_profile_id) {
            routeHeaders[ROUTE_PROVIDER_CREDENTIAL_PROFILE_ID_HEADER] = resolution.lease.provider_credential_profile_id
            routeHeaders[ROUTE_PROVIDER_CREDENTIAL_PROFILE_REVISION_HEADER] = String(resolution.lease.provider_credential_profile_revision)
            routeHeaders[ROUTE_PROVIDER_CREDENTIAL_STRATEGY_DIGEST_HEADER] = resolution.lease.provider_credential_strategy_digest!
          }
          process.stdout.write(`${JSON.stringify(gatewayModelRouteLeaseEvent(context, resolution))}\n`)
        }
        outputBody = prepared.restore(outputBody)
        const executedSteps = ("executedSteps" in result ? result.executedSteps : undefined)
          ?.map((step) => ({
          step_id: step.stepId,
          action: step.action,
          })) ?? []
        process.stdout.write(`${JSON.stringify({
          event: `genio.one.processor-http-${direction}-completed`,
          correlation_id: correlationId,
          bundle_revision: snapshot.bundleRevision,
          disposition: result.disposition,
          output_body_bytes: outputBody.byteLength,
          steps: executedSteps,
          match_names: result.matches,
          data_classifications: result.dataClassifications ?? [],
        })}\n`)
        if (result.disposition === "BLOCK") {
          if (options.onActivity) {
            const occurredAt = Math.floor(Date.now() / 1_000)
            const event: GatewayActivityIngest = {
              correlation_id: context.correlationId,
              resource_id: context.resourceId,
              capability_id: context.capabilityId,
              application_id: null,
              subject_id: context.subjectId,
              acting_client_id: context.clientId,
              session_id: context.sessionId ?? null,
              entitlement_id: null,
              usage_admission_id: optional(request.headers, USAGE_ADMISSION_ID_HEADER) ?? null,
              usage_admission_disposition: request.headers.has(USAGE_ADMISSION_ID_HEADER) ? "ADMIT" : "NOT_APPLICABLE",
              usage_admission_reason: null,
              consumer_organization_id: optional(request.headers, TRUSTED_CONSUMER_ORGANIZATION_HEADER) ?? null,
              resource_owner_organization_id: optional(request.headers, TRUSTED_RESOURCE_OWNER_ORGANIZATION_HEADER) ?? null,
              use_case_id: optional(request.headers, TRUSTED_USE_CASE_HEADER) ?? null,
              enforcement_point_id: "AI_GATEWAY",
              route: "MANAGED",
              method: originalMethod,
              path: originalPath,
              status_code: 403,
              outcome: "BLOCKED",
              error_code: "DATA_PROTECTION_BLOCKED",
              latency_millis: null,
              upstream_attempted: false,
              requested_model_id: requestedPublicModelName ?? null,
              effective_model_id: null,
              provider_id: null,
              connection_id: null,
              mcp_method: null,
              mcp_tool: null,
              mcp_backend: null,
              processor_bundle_revision: snapshot.bundleRevision,
              processor_request_steps: executedSteps,
              processor_response_steps: [],
              data_classifications: result.dataClassifications ?? [],
              input_tokens: null,
              output_tokens: null,
              total_tokens: null,
              route_mode: null,
              route_lease_id: null,
              route_lease_reused: null,
              routing_policy_id: null,
              routing_revision: null,
              candidate_set_digest: null,
              ...gatewayDetailActivityReference(
                snapshot.captureMessageContent,
                context.correlationId,
                occurredAt,
              ),
              occurred_at: occurredAt,
            }
            void Promise.resolve(options.onActivity(event)).catch((error) => {
              writeOperationalEvent("processor", "ERROR", "genio.one.activity-observation-failed", {
                correlation_id: context.correlationId,
                ...operationalError(error),
              })
            })
          }
          return Response.json(
            { code: "DATA_PROTECTION_BLOCKED", matches: result.matches },
            {
              status: 403,
              headers: {
                [PROCESSOR_BUNDLE_HEADER]: snapshot.bundleRevision,
                [PROCESSOR_STEPS_HEADER]: JSON.stringify(executedSteps),
              },
            },
          )
        }
        return new Response(Buffer.from(outputBody), {
          status: 200,
          headers: {
            "content-type": contentType || "application/octet-stream",
            [PROCESSOR_BUNDLE_HEADER]: snapshot.bundleRevision,
            [PROCESSOR_STEPS_HEADER]: JSON.stringify(executedSteps),
            ...routeHeaders,
          },
        })
      } catch (error) {
        writeOperationalEvent("processor", "ERROR", "genio.one.processor-http-rejected", {
          ...operationalError(error),
        })
        return errorResponse(503, "PROCESSOR_REQUEST_REJECTED")
      }
  }
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
        else headers.set(name, value)
      }
      const request = new Request(
        `http://${incoming.headers.host ?? "processor"}${incoming.url ?? "/"}`,
        {
          method: incoming.method ?? "GET",
          headers,
          body: incoming.method === "GET" || incoming.method === "HEAD"
            ? undefined
            : Buffer.concat(chunks),
        },
      )
      const response = await handle(request)
      outgoing.statusCode = response.status
      response.headers.forEach((value, name) => outgoing.setHeader(name, value))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    })().catch((error) => {
      writeOperationalEvent("processor", "ERROR", "genio.one.processor-http-server-error", {
        ...operationalError(error),
      })
      if (!outgoing.headersSent) outgoing.statusCode = 503
      outgoing.end(JSON.stringify({ code: "PROCESSOR_REQUEST_REJECTED" }))
    })
  })
  server.listen(port, hostname)
  return server
}
