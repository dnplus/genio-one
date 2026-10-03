import { observationContext } from "./operation-observability"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { flushOtel, observabilityOrigin, recordHttpObservation, traceIdentity } from "./otlp-observability"

const sensitiveRequestOmitted = JSON.stringify({ availability: "OMITTED_SENSITIVE_REQUEST" })
const httpRequestOmitted = JSON.stringify({ availability: "OMITTED_HTTP_REQUEST" })
const httpResponseOmitted = JSON.stringify({ availability: "OMITTED_HTTP_RESPONSE" })
const sensitiveResponseOmitted = JSON.stringify({ availability: "OMITTED_SENSITIVE_RESPONSE" })

type SensitivePayloadControl = boolean | ((request: FastifyRequest, reply: FastifyReply) => boolean)

declare module "fastify" {
  interface FastifyContextConfig {
    sensitiveRequest?: SensitivePayloadControl
    sensitiveResponse?: SensitivePayloadControl
  }
}

function isSensitive(control: SensitivePayloadControl | undefined, request: FastifyRequest, reply: FastifyReply): boolean {
  return typeof control === "function" ? control(request, reply) : control === true
}

export function registerHttpObservability(app: FastifyInstance, service: string) {
  const origin = observabilityOrigin()
  if (!origin) return
  const requests = new WeakMap<object, ReturnType<typeof traceIdentity> & { startedAt: bigint; responseBody?: string }>()
  app.addHook("onRequest", (request, reply, done) => {
    const identity = traceIdentity(request.headers.traceparent)
    requests.set(request, { ...identity, startedAt: BigInt(Date.now()) * 1_000_000n })
    reply.header("traceparent", `00-${identity.traceId}-${identity.spanId}-01`)
    const params = request.params as { tenant_id?: string } | undefined
    const correlation = request.headers["x-genio-correlation-id"] ?? request.headers["x-request-id"]
    observationContext.run({ traceId: identity.traceId, spanId: identity.spanId, correlationId: typeof correlation === "string" ? correlation : String(request.id), tenantId: params?.tenant_id ?? process.env.GENIO_ONE_TENANT_ID ?? "unassigned" }, done)
  })
  app.addHook("onSend", async (request, reply, payload) => {
    const state = requests.get(request)
    if (state && isSensitive(request.routeOptions.config.sensitiveResponse, request, reply)) state.responseBody = sensitiveResponseOmitted
    else if (state) state.responseBody = httpResponseOmitted
    return payload
  })
  app.addHook("onResponse", async (request, reply) => {
    const state = requests.get(request)
    if (!state) return
    const principal = (request as unknown as { principal?: { tenant_id?: string; subject_id?: string } }).principal
    const params = request.params as { tenant_id?: string } | undefined
    const correlation = request.headers["x-genio-correlation-id"] ?? request.headers["x-request-id"]
    const sensitiveRequest = isSensitive(request.routeOptions.config.sensitiveRequest, request, reply)
    recordHttpObservation({ service, tenantId: principal?.tenant_id ?? params?.tenant_id ?? process.env.GENIO_ONE_TENANT_ID ?? "unassigned", subjectId: principal?.subject_id, method: request.method, route: request.routeOptions.url ?? "/unmatched", status: reply.statusCode, correlationId: typeof correlation === "string" ? correlation : String(request.id), ...state, details: { "genio.request": sensitiveRequest ? sensitiveRequestOmitted : httpRequestOmitted, "genio.response": state.responseBody ?? httpResponseOmitted }, endedAt: BigInt(Date.now()) * 1_000_000n, origin })
  })
  app.addHook("onClose", flushOtel)
}
