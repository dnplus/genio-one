import { randomUUID } from "node:crypto"
import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"
import { Check } from "typebox/value"
import type { EndpointRuntimeHttpOptions } from "./http"

const ReportSchema = Type.Object({
  command_id: Type.String({ minLength: 1 }),
  runtime_id: Type.String({ minLength: 1 }),
  runtime_kind: Type.Literal("ENDPOINT"),
  runtime_version: Type.String({ minLength: 1, maxLength: 64 }),
  applied_state_revision: Type.String({ minLength: 1 }),
  applied_policy_version: Type.String({ minLength: 1 }),
  health: Type.Union([Type.Literal("READY"), Type.Literal("DEGRADED")]),
  components: Type.Array(Type.Unknown(), { maxItems: 0 }),
  secure_access: Type.Array(Type.Unknown(), { maxItems: 0 }),
}, { additionalProperties: false })

export const endpointRuntimeWebSocket: FastifyPluginAsync<EndpointRuntimeHttpOptions> = async (app, options) => {
  const sockets = new Set<import("ws").WebSocket>()
  app.addHook("onClose", async () => {
    for (const socket of sockets) socket.terminate()
  })
  app.withTypeProvider<TypeBoxTypeProvider>().get("/v1/tenants/:tenant_id/runtime-control/ENDPOINT/:runtime_id/connect", {
    websocket: true,
    schema: { operationId: "connectEndpointRuntime", tags: ["Endpoint Runtime"], params: Type.Object({
      tenant_id: Type.String({ minLength: 1 }), runtime_id: Type.String({ minLength: 1 }),
    }) },
  }, (socket, request) => {
    sockets.add(socket)
    const tenantId = request.params.tenant_id
    const deviceId = request.params.runtime_id
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? ""
    let pending: { id: string; revision: string; policy: string } | null = null
    let nextDeliveryAt = 0
    let stopped = false
    let queued = 0
    let queue = Promise.resolve()
    const close = () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      sockets.delete(socket)
      socket.close(1008, "Endpoint session rejected")
    }
    const authorize = async () => {
      const identity = await options.store.authenticateCredential({ tenantId, token })
      if (identity.kind !== "RUNTIME" || identity.deviceId !== deviceId) throw new Error("ENDPOINT_CREDENTIAL_REJECTED")
      return identity
    }
    const enqueue = (work: () => Promise<void>) => {
      if (stopped) return
      if (++queued > 8) { close(); return }
      queue = queue.then(async () => { if (!stopped) await work() }).catch(close).finally(() => { queued-- })
    }
    const deliver = async () => {
      const identity = await authorize()
      if (Date.now() < nextDeliveryAt) return
      const device = await options.store.get({ tenantId, deviceId })
      const enrollment = await options.store.enroll({ tenantId, subjectId: identity.subjectId, credentialId: identity.credentialId,
        value: { correlation_id: randomUUID(), device_id: deviceId, endpoint_version: device.observed_state.endpoint_version,
          at: Math.floor(Date.now() / 1000), identity: { device_id: deviceId,
            subject: { subject_id: identity.subjectId, evidence_level: "VERIFIED" },
            acting_client: { acting_client_id: null, evidence_level: "UNKNOWN" } } } })
      const desired = enrollment.configuration.desired_state
      pending = { id: randomUUID(), revision: desired.revision, policy: desired.policy_version }
      socket.send(JSON.stringify({ command_id: pending.id, desired_state: { runtime_kind: "ENDPOINT", desired_state: desired } }))
      nextDeliveryAt = Date.now() + enrollment.configuration.heartbeat_interval_seconds * 1000
    }
    const timer = setInterval(() => enqueue(deliver), 1000)
    timer.unref()
    socket.on("close", () => { stopped = true; clearInterval(timer); sockets.delete(socket) })
    socket.on("error", close)
    socket.on("message", (data, binary) => {
      const encoded = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
      if (binary || encoded.length > 16384) { close(); return }
      enqueue(async () => {
        const identity = await authorize()
        const report: unknown = JSON.parse(encoded.toString())
        if (!Check(ReportSchema, report) || !pending || report.command_id !== pending.id || report.runtime_id !== deviceId ||
          report.applied_state_revision !== pending.revision || report.applied_policy_version !== pending.policy) throw new Error("ENDPOINT_REPORT_REJECTED")
        await options.store.heartbeat({ tenantId, deviceId, subjectId: identity.subjectId, value: {
          correlation_id: report.command_id, evidence_level: "VERIFIED", subject: { subject_id: identity.subjectId, evidence_level: "VERIFIED" },
          endpoint_version: report.runtime_version,
          applied_state_revision: report.health === "READY" ? report.applied_state_revision : null,
          applied_policy_version: report.health === "READY" ? report.applied_policy_version : null,
          health: report.health === "READY" ? "HEALTHY" : "DEGRADED", at: Math.floor(Date.now() / 1000),
        } })
      })
    })
    enqueue(deliver)
  })
}
