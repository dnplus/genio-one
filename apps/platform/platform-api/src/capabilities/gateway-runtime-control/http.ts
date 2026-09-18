import { providerCredentialReferences } from "../../../../../../runtimes/gateway/services/shared/provider-credential-reference"
import type { ProviderCredentialProfileStore } from "../provider-credentials/module"
import "@fastify/websocket"

import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import type { FastifyPluginAsync, FastifyRequest } from "fastify"
import { randomUUID } from "node:crypto"
import { Type } from "typebox"
import type { WebSocket } from "ws"

import {
  GatewayReleasePackageSchema,
} from "../gateway-policy-release/package"
import type { GatewayReleasePackageSource } from "../gateway-policy-release/package-source"
import { PlatformApiError, isPlatformApiError } from "../errors"
import type { RuntimeControlStore, RuntimeRegistration } from "../runtime-control/contract"
import {
  GatewayRuntimeCommandSchema,
  GatewayRuntimeReportSchema,
  parseGatewayRuntimeReport,
} from "../../../../../../packages/protocol/src/gateway-release"
import {
  GatewayAggregateObservedStateRecordSchema,
  GatewayAggregateReportHistoryRecordSchema,
  GatewayAggregateDeliveryModeSchema,
  GatewayRuntimeCapabilitiesSchema,
  RuntimeProtocolVersionSchema,
  supportsGatewayAggregateDelivery,
  type GatewayAggregateRuntimeControlStore,
} from "./contract"

const Identifier = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\u0000\\r\\n]+$",
})

const TenantPathSchema = Type.Object({
  tenant_id: Identifier,
}, { additionalProperties: false })

const GatewayRollbackBodySchema = Type.Object({
  correlation_id: Identifier,
  /** Recorded for evidence; the delivered package comes from observed state. */
  failed_revision: Identifier,
  target_revision: Identifier,
  runtime_ids: Type.Array(Identifier, { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false })

const GatewayRollbackResultSchema = Type.Object({
  correlation_id: Identifier,
  failed_revision: Identifier,
  target_revision: Identifier,
  runtimes: Type.Array(Type.Object({
    runtime_id: Identifier,
    command_id: Identifier,
    desired_state_revision: Identifier,
  }, { additionalProperties: false })),
}, { additionalProperties: false })

const RuntimePathSchema = Type.Object({
  tenant_id: Identifier,
  runtime_id: Identifier,
}, { additionalProperties: false })

const ReleasePackagePathSchema = Type.Object({
  tenant_id: Identifier,
  runtime_id: Identifier,
  release_id: Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
  }),
}, { additionalProperties: false })

const ReleasePackageQuerySchema = Type.Object({
  command_id: Identifier,
}, { additionalProperties: false })

const CapabilitiesBodySchema = Type.Object({
  protocol_versions: Type.Array(RuntimeProtocolVersionSchema, {
    minItems: 1,
    maxItems: 1,
  }),
  preferred_protocol_version: RuntimeProtocolVersionSchema,
  delivery_mode: GatewayAggregateDeliveryModeSchema,
}, { additionalProperties: false })

const GatewayRuntimeHeartbeatSchema = Type.Object({
  runtime_id: Identifier,
  expires_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export interface GatewayAggregateRuntimeAuthorizationInput {
  tenantId: string
  runtimeId: string
  request: FastifyRequest
}

export type GatewayAggregateRuntimeAuthorizer = (
  input: GatewayAggregateRuntimeAuthorizationInput,
) => boolean | void | Promise<boolean | void>

export interface GatewayAggregateRuntimeControlHttpOptions {
  credentials?: ProviderCredentialProfileStore
  store: GatewayAggregateRuntimeControlStore
  registrations: RuntimeControlStore
  packages: GatewayReleasePackageSource
  authorizeRuntime: GatewayAggregateRuntimeAuthorizer
  pollIntervalMs?: number
  leaseTtlSeconds?: number
  leaseOwnerId?: string
  leaseIdFactory?: (input: GatewayAggregateRuntimeAuthorizationInput) => string
}

const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_LEASE_TTL_SECONDS = 30

function positiveFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function requireRegistration(value: RuntimeRegistration | null): RuntimeRegistration {
  if (!value) throw new PlatformApiError("RUNTIME_RUNTIME_NOT_REGISTERED", 404)
  return value
}

function requireActiveRegistration(value: RuntimeRegistration | null): RuntimeRegistration {
  const registration = requireRegistration(value)
  if (registration.status !== "ACTIVE") {
    throw new PlatformApiError("RUNTIME_RUNTIME_NOT_ACTIVE", 403)
  }
  return registration
}

async function authorizeRuntime(
  options: GatewayAggregateRuntimeControlHttpOptions,
  input: GatewayAggregateRuntimeAuthorizationInput,
): Promise<void> {
  try {
    if (await options.authorizeRuntime(input) === false) {
      throw new PlatformApiError("RUNTIME_ACCESS_DENIED", 403)
    }
  } catch (error) {
    if (isPlatformApiError(error)) throw error
    throw new PlatformApiError("RUNTIME_ACCESS_DENIED", 403)
  }
}

function rawMessageText(data: WebSocket.RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8")
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8")
  return data.toString("utf8")
}

function serialQueue() {
  let tail = Promise.resolve()
  return {
    enqueue(task: () => Promise<void> | void): Promise<void> {
      const next = tail.then(task)
      tail = next.catch(() => undefined)
      return next
    },
  }
}

function closeSocket(socket: WebSocket): void {
  if (socket.readyState === 0 || socket.readyState === 1) {
    try {
      socket.close(1008, "runtime protocol rejected")
    } catch {
      // The peer may close between the state check and close().
    }
  }
}

function sendSocketMessage(socket: WebSocket, value: unknown): Promise<void> {
  if (socket.readyState !== 1) {
    throw new PlatformApiError("RUNTIME_CHANNEL_CLOSED", 409)
  }
  return new Promise((resolve, reject) => {
    try {
      socket.send(JSON.stringify(value), (error?: Error) => error ? reject(error) : resolve())
    } catch (error) {
      reject(error)
    }
  })
}

export const gatewayAggregateRuntimeControlHttp: FastifyPluginAsync<
  GatewayAggregateRuntimeControlHttpOptions
> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()

  routes.post(
    "/v1/tenants/:tenant_id/gateway-rollbacks",
    {
      schema: {
        operationId: "rollbackGatewayRuntimes",
        summary: "Re-deliver the last release each Gateway Runtime reported as applied",
        tags: ["Runtime Control"],
        params: TenantPathSchema,
        body: GatewayRollbackBodySchema,
        response: { 200: GatewayRollbackResultSchema },
      },
    },
    async (request) => {
      const tenantId = request.params.tenant_id
      const runtimeIds = [...new Set(request.body.runtime_ids)]
      const runtimes: Array<{ runtime_id: string; command_id: string; desired_state_revision: string }> = []
      for (const runtimeId of runtimeIds) {
        const registration = await options.registrations.getGatewayRuntime({ tenantId, runtimeId })
        if (!registration) {
          throw new PlatformApiError("RUNTIME_NOT_FOUND", 404, `Gateway Runtime ${runtimeId} is not registered`)
        }
        const observed = await options.store.getLatestGatewayReleaseObserved({ tenantId, runtimeId })
        // The rollback target is the release the Runtime itself last reported as
        // applied, not an operator-supplied revision: re-delivering a package the
        // Runtime never proved it could apply would not be a recovery.
        const applied = observed?.applied_release ?? null
        if (!applied) {
          throw new PlatformApiError(
            "GATEWAY_ROLLBACK_TARGET_UNAVAILABLE",
            409,
            `Gateway Runtime ${runtimeId} has not reported an applied release to roll back to`,
          )
        }
        if (String(applied.head_revision) !== request.body.target_revision) {
          throw new PlatformApiError(
            "GATEWAY_ROLLBACK_TARGET_STALE",
            409,
            `Gateway Runtime ${runtimeId} last applied revision ${applied.head_revision}, not ${request.body.target_revision}`,
          )
        }
        const command = await options.store.enqueueGatewayRelease({
          tenantId,
          runtimeId,
          release: applied,
        })
        runtimes.push({
          runtime_id: runtimeId,
          command_id: command.command_id,
          desired_state_revision: String(applied.head_revision),
        })
      }
      return {
        correlation_id: request.body.correlation_id,
        failed_revision: request.body.failed_revision,
        target_revision: request.body.target_revision,
        runtimes,
      }
    },
  )

  routes.put(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/capabilities",
    {
      schema: {
        operationId: "negotiateGatewayAggregateRuntimeCapabilities",
        summary: "Negotiate aggregate Gateway Runtime capabilities",
        tags: ["Runtime Control"],
        params: RuntimePathSchema,
        body: CapabilitiesBodySchema,
        response: { 200: GatewayRuntimeCapabilitiesSchema },
      },
    },
    async (request) => {
      const tenantId = request.params.tenant_id
      const runtimeId = request.params.runtime_id
      await authorizeRuntime(options, { tenantId, runtimeId, request })
      requireActiveRegistration(await options.registrations.getGatewayRuntime({
        tenantId,
        runtimeKind: "GATEWAY",
        runtimeId,
      }))
      return options.store.saveCapabilities({
        tenantId,
        runtimeId,
        protocolVersions: request.body.protocol_versions,
        preferredProtocolVersion: request.body.preferred_protocol_version,
        deliveryMode: request.body.delivery_mode,
      })
    },
  )

  /**
   * HTTP-polling runtimes use this explicit lease heartbeat when a deployment
   * cannot upgrade to WebSocket. It is deliberately separate from command
   * polling so the inventory can distinguish a live runtime from a stale
   * capability registration without treating a read as a hidden mutation.
   */
  routes.put(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/aggregate/heartbeat",
    {
      schema: {
        operationId: "heartbeatGatewayAggregateRuntime",
        summary: "Renew the aggregate Gateway Runtime session lease",
        tags: ["Runtime Control"],
        params: RuntimePathSchema,
        response: { 200: GatewayRuntimeHeartbeatSchema },
      },
    },
    async (request) => {
      const tenantId = request.params.tenant_id
      const runtimeId = request.params.runtime_id
      await authorizeRuntime(options, { tenantId, runtimeId, request })
      requireActiveRegistration(await options.registrations.getGatewayRuntime({
        tenantId,
        runtimeKind: "GATEWAY",
        runtimeId,
      }))
      const capabilities = await options.store.getCapabilities({
        tenantId,
        runtimeKind: "GATEWAY",
        runtimeId,
      })
      if (
        !capabilities ||
        !supportsGatewayAggregateDelivery({
          protocolVersions: capabilities.protocol_versions,
          preferredProtocolVersion: capabilities.preferred_protocol_version,
          deliveryMode: capabilities.delivery_mode,
        })
      ) {
        throw new PlatformApiError("RUNTIME_AGGREGATE_DELIVERY_UNSUPPORTED", 409)
      }
      const lease = await options.registrations.claimGatewaySessionLease({
        tenantId,
        runtimeId,
        ownerId: "gateway-runtime-control-http",
        leaseId: runtimeId,
        ttlSeconds: Math.max(
          1,
          Math.floor(positiveFinite(options.leaseTtlSeconds, DEFAULT_LEASE_TTL_SECONDS)),
        ),
      })
      return { runtime_id: lease.runtime_id, expires_at: lease.expires_at }
    },
  )

  async function authorizedPackage(request: FastifyRequest, parameters: { tenant_id: string; runtime_id: string; release_id: string }, commandId: string) {
      const tenantId = parameters.tenant_id
      const runtimeId = parameters.runtime_id
      const releaseId = parameters.release_id
      await authorizeRuntime(options, { tenantId, runtimeId, request })
      const registration = requireActiveRegistration(
        await options.registrations.getGatewayRuntime({
          tenantId,
          runtimeKind: "GATEWAY",
          runtimeId,
        }),
      )
      const command = await options.store.getGatewayReleaseCommand({
        tenantId,
        runtimeKind: "GATEWAY",
        runtimeId,
        commandId,
      })
      if (!command || command.release_id !== releaseId) {
        throw new PlatformApiError("RUNTIME_RELEASE_REFERENCE_UNKNOWN", 403)
      }
      if (registration.target_id !== command.gateway_id) {
        throw new PlatformApiError("RUNTIME_RELEASE_SCOPE_MISMATCH", 403)
      }
      const value = await options.packages.getPackage({
        tenantId,
        runtimeId,
        releaseId,
        headRevision: command.head_revision,
      })
      if (!value) throw new PlatformApiError("GATEWAY_RELEASE_PACKAGE_NOT_FOUND", 404)
      if (
        value.tenant_id !== tenantId ||
        value.runtime_id !== runtimeId ||
        value.release_id !== command.release_id ||
        value.gateway_id !== command.gateway_id ||
        value.head_revision !== command.head_revision ||
        value.package_digest !== command.package_digest ||
        value.projection_count !== command.projection_count
      ) {
        throw new PlatformApiError("RUNTIME_RELEASE_PACKAGE_MISMATCH", 409)
      }
      return value
  }

  routes.get("/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/aggregate/releases/:release_id/credentials", {
    schema: { operationId: "getGatewayReleaseCredentials", tags: ["Runtime Control"], params: ReleasePackagePathSchema, querystring: ReleasePackageQuerySchema, response: { 200: Type.Array(Type.Object({ profile_id: Identifier, revision: Type.Integer({ minimum: 1 }), namespace: Identifier, secret_name: Identifier, credential_json: Type.String({ maxLength: 65536 }) }, { additionalProperties: false })) } } }, async (request, reply) => {
    const value = await authorizedPackage(request, request.params, request.query.command_id)
    const resources = value.projections.flatMap(({ projection }) => projection.operation === "APPLY" ? projection.resources : [])
    const refs = providerCredentialReferences(request.params.tenant_id, resources)
    const result = []
    for (const ref of refs) {
      const material = await options.credentials?.readMaterial?.({ tenantId: request.params.tenant_id, profileId: ref.profile_id, revision: ref.revision })
      if (!material) throw new PlatformApiError("GATEWAY_PROVIDER_CREDENTIAL_UNAVAILABLE", 409)
      result.push({ ...ref, credential_json: material })
    }
    reply.header("cache-control", "no-store")
    return result
  })

  routes.get(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/aggregate/releases/:release_id/package",
    {
      schema: {
        operationId: "getGatewayAggregateReleasePackage",
        summary: "Fetch one immutable aggregate Gateway release package",
        tags: ["Runtime Control"],
        params: ReleasePackagePathSchema,
        querystring: ReleasePackageQuerySchema,
        response: { 200: GatewayReleasePackageSchema },
      },
    },
    async (request, reply) => {
      const value = await authorizedPackage(request, request.params, request.query.command_id)
      reply.header("etag", `\"${value.package_digest}\"`)
      return value
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/aggregate/observed-state",
    {
      schema: {
        operationId: "getGatewayAggregateObservedState",
        summary: "Get the latest aggregate Gateway Runtime state",
        tags: ["Runtime Control"],
        params: RuntimePathSchema,
        response: {
          200: Type.Union([GatewayAggregateObservedStateRecordSchema, Type.Null()]),
        },
      },
    },
    async (request) => {
      requireRegistration(await options.registrations.getGatewayRuntime({
        tenantId: request.params.tenant_id,
        runtimeKind: "GATEWAY",
        runtimeId: request.params.runtime_id,
      }))
      return options.store.getLatestGatewayReleaseObserved({
        tenantId: request.params.tenant_id,
        runtimeKind: "GATEWAY",
        runtimeId: request.params.runtime_id,
      })
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/aggregate/report-history",
    {
      schema: {
        operationId: "listGatewayAggregateReportHistory",
        summary: "List aggregate Gateway Runtime report history",
        tags: ["Runtime Control"],
        params: RuntimePathSchema,
        response: { 200: Type.Array(GatewayAggregateReportHistoryRecordSchema) },
      },
    },
    async (request) => {
      requireRegistration(await options.registrations.getGatewayRuntime({
        tenantId: request.params.tenant_id,
        runtimeKind: "GATEWAY",
        runtimeId: request.params.runtime_id,
      }))
      return options.store.listGatewayReleaseReportHistory({
        tenantId: request.params.tenant_id,
        runtimeKind: "GATEWAY",
        runtimeId: request.params.runtime_id,
      })
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/aggregate/commands/next",
    {
      schema: {
        operationId: "pollGatewayAggregateCommand",
        summary: "Poll the next aggregate Gateway Runtime command",
        tags: ["Runtime Control"],
        params: RuntimePathSchema,
        response: { 200: Type.Union([GatewayRuntimeCommandSchema, Type.Null()]) },
      },
    },
    async (request) => {
      const tenantId = request.params.tenant_id
      const runtimeId = request.params.runtime_id
      await authorizeRuntime(options, { tenantId, runtimeId, request })
      requireActiveRegistration(await options.registrations.getGatewayRuntime({
        tenantId,
        runtimeKind: "GATEWAY",
        runtimeId,
      }))
      const capabilities = await options.store.getCapabilities({
        tenantId,
        runtimeKind: "GATEWAY",
        runtimeId,
      })
      if (
        !capabilities ||
        !supportsGatewayAggregateDelivery({
          protocolVersions: capabilities.protocol_versions,
          preferredProtocolVersion: capabilities.preferred_protocol_version,
          deliveryMode: capabilities.delivery_mode,
        })
      ) {
        throw new PlatformApiError("RUNTIME_AGGREGATE_DELIVERY_UNSUPPORTED", 409)
      }
      const [record] = await options.store.listPendingGatewayReleaseCommands({
        tenantId,
        runtimeKind: "GATEWAY",
        runtimeId,
      })
      if (!record) return null
      await options.store.markGatewayReleaseCommandDelivered({
        tenantId,
        runtimeKind: "GATEWAY",
        runtimeId,
        commandId: record.command_id,
      })
      return record.command
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/aggregate/reports",
    {
      schema: {
        operationId: "reportGatewayAggregateStatus",
        summary: "Report aggregate Gateway Runtime status",
        tags: ["Runtime Control"],
        params: RuntimePathSchema,
        body: GatewayRuntimeReportSchema,
        response: { 200: GatewayAggregateObservedStateRecordSchema },
      },
    },
    async (request) => {
      const tenantId = request.params.tenant_id
      const runtimeId = request.params.runtime_id
      await authorizeRuntime(options, { tenantId, runtimeId, request })
      const report = parseGatewayRuntimeReport(request.body)
      if (report.tenant_id !== tenantId || report.runtime_id !== runtimeId) {
        throw new PlatformApiError("RUNTIME_REPORT_SCOPE_MISMATCH", 403)
      }
      return (await options.store.recordGatewayReleaseReport({ tenantId, report })).observed
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/aggregate/connect",
    {
      websocket: true,
      schema: {
        operationId: "connectGatewayAggregateRuntime",
        summary: "Open the aggregate Gateway Runtime Control Channel",
        tags: ["Runtime Control"],
        params: RuntimePathSchema,
      },
    },
    (socket, request) => {
      const tenantId = request.params.tenant_id
      const runtimeId = request.params.runtime_id
      const queue = serialQueue()
      const sentCommandIds = new Set<string>()
      const pollIntervalMs = positiveFinite(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)
      const leaseTtlSeconds = Math.max(
        1,
        Math.floor(positiveFinite(options.leaseTtlSeconds, DEFAULT_LEASE_TTL_SECONDS)),
      )
      const ownerId = options.leaseOwnerId ?? `gateway-runtime-control-${runtimeId}`
      const authorizationInput = { tenantId, runtimeId, request }
      const leaseId = options.leaseIdFactory?.(authorizationInput) ?? randomUUID()
      let closed = false
      let started = false
      let leaseClaimed = false
      let pollTimer: ReturnType<typeof setInterval> | undefined
      let renewTimer: ReturnType<typeof setInterval> | undefined
      let resolveReady!: (value: boolean) => void
      const ready = new Promise<boolean>((resolve) => {
        resolveReady = resolve
      })

      const stopTimers = () => {
        if (pollTimer !== undefined) clearInterval(pollTimer)
        if (renewTimer !== undefined) clearInterval(renewTimer)
      }
      const releaseLease = () => {
        if (!leaseClaimed) return
        leaseClaimed = false
        void queue.enqueue(() => options.registrations.releaseGatewaySessionLease({
          tenantId,
          runtimeId,
          ownerId,
          leaseId,
        })).catch(() => undefined)
      }
      const finish = () => {
        if (closed) return
        closed = true
        started = false
        resolveReady(false)
        stopTimers()
        releaseLease()
      }
      const failClosed = (error?: unknown) => {
        if (closed) return
        app.log.warn(
          {
            tenant_id: tenantId,
            runtime_id: runtimeId,
            error_name: error instanceof Error ? error.name : "UnknownError",
            error_message: error instanceof Error ? error.message : "Runtime channel failed",
          },
          "Gateway Runtime aggregate channel rejected a message",
        )
        finish()
        closeSocket(socket)
      }
      const assertReadyRuntime = async () => {
        requireActiveRegistration(await options.registrations.getGatewayRuntime({
          tenantId,
          runtimeKind: "GATEWAY",
          runtimeId,
        }))
        const capabilities = await options.store.getCapabilities({
          tenantId,
          runtimeKind: "GATEWAY",
          runtimeId,
        })
        if (
          !capabilities ||
          !supportsGatewayAggregateDelivery({
            protocolVersions: capabilities.protocol_versions,
            preferredProtocolVersion: capabilities.preferred_protocol_version,
            deliveryMode: capabilities.delivery_mode,
          })
        ) {
          throw new PlatformApiError("RUNTIME_AGGREGATE_DELIVERY_UNSUPPORTED", 409)
        }
      }
      const poll = async () => {
        if (closed || !started) return
        await assertReadyRuntime()
        const pending = await options.store.listPendingGatewayReleaseCommands({
          tenantId,
          runtimeKind: "GATEWAY",
          runtimeId,
        })
        for (const record of pending) {
          if (sentCommandIds.has(record.command_id)) continue
          await sendSocketMessage(socket, record.command)
          await options.store.markGatewayReleaseCommandDelivered({
            tenantId,
            runtimeKind: "GATEWAY",
            runtimeId,
            commandId: record.command_id,
          })
          sentCommandIds.add(record.command_id)
        }
      }
      const processMessage = async (data: WebSocket.RawData) => {
        if (!(await ready) || closed) return
        try {
          const parsed = parseGatewayRuntimeReport(JSON.parse(rawMessageText(data)))
          if (parsed.tenant_id !== tenantId || parsed.runtime_id !== runtimeId) {
            throw new PlatformApiError("RUNTIME_REPORT_SCOPE_MISMATCH", 403)
          }
          await options.store.recordGatewayReleaseReport({ tenantId, report: parsed })
        } catch (error) {
          failClosed(error)
        }
      }

      socket.on("message", (data) => {
        void queue.enqueue(() => processMessage(data)).catch(failClosed)
      })
      socket.once("close", finish)
      socket.once("error", failClosed)

      void (async () => {
        try {
          await authorizeRuntime(options, authorizationInput)
          await assertReadyRuntime()
          await options.registrations.claimGatewaySessionLease({
            tenantId,
            runtimeId,
            ownerId,
            leaseId,
            ttlSeconds: leaseTtlSeconds,
          })
          leaseClaimed = true
          if (closed) return
          started = true
          resolveReady(true)
          await queue.enqueue(poll)
          if (closed) return
          pollTimer = setInterval(() => void queue.enqueue(poll).catch(failClosed), pollIntervalMs)
          renewTimer = setInterval(() => {
            void queue.enqueue(async () => {
              if (closed || !started) return
              await assertReadyRuntime()
              await options.registrations.renewGatewaySessionLease({
                tenantId,
                runtimeId,
                ownerId,
                leaseId,
                ttlSeconds: leaseTtlSeconds,
              })
            }).catch(failClosed)
          }, Math.max(1_000, Math.floor(leaseTtlSeconds * 1_000 / 3)))
        } catch (error) {
          resolveReady(false)
          failClosed(error)
        }
      })()
    },
  )
}
