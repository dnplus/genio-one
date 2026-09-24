import { observationContext, observationEvidence, observationReference } from "./operation-observability"
import type { FastifyInstance } from "fastify"
import { flushOtel, observabilityOrigin, recordHttpObservation, traceIdentity } from "./otlp-observability"

const sensitiveResponseOmitted = JSON.stringify({ availability: "OMITTED_SENSITIVE_RESPONSE" })

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
  app.addHook("onSend", async (request, _reply, payload) => {
    const state = requests.get(request)
    if (state && (request.routeOptions.config as { sensitiveResponse?: boolean } | undefined)?.sensitiveResponse) state.responseBody = sensitiveResponseOmitted
    else if (state && /\/(traces|logs|traces\/[^/]+\/spans)$/.test(request.routeOptions.url ?? "")) state.responseBody = observationReference(payload)
    else if (state) state.responseBody = typeof payload === "string" ? observationEvidence(payload) : payload === null ? observationEvidence(null) : observationEvidence({ availability: "STREAM_OR_BINARY_NOT_CAPTURED" })
    return payload
  })
  app.addHook("onResponse", async (request, reply) => {
    const state = requests.get(request)
    if (!state) return
    const principal = (request as unknown as { principal?: { tenant_id?: string; subject_id?: string } }).principal
    const params = request.params as { tenant_id?: string } | undefined
    const correlation = request.headers["x-genio-correlation-id"] ?? request.headers["x-request-id"]
    recordHttpObservation({ service, tenantId: principal?.tenant_id ?? params?.tenant_id ?? process.env.GENIO_ONE_TENANT_ID ?? "unassigned", subjectId: principal?.subject_id, method: request.method, route: request.routeOptions.url ?? "/unmatched", status: reply.statusCode, correlationId: typeof correlation === "string" ? correlation : String(request.id), ...state, details: { "genio.request": observationEvidence({ params: request.params, query: request.query, headers: request.headers, body: request.body }), "genio.response": state.responseBody ?? observationEvidence({ availability: "NOT_PROVIDED" }) }, endedAt: BigInt(Date.now()) * 1_000_000n, origin })
  })
  app.addHook("onClose", flushOtel)
}
