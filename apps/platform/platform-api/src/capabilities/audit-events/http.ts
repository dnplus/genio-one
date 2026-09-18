import type { FastifyPluginAsync } from "fastify"
import { Type } from "typebox"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  GatewayAuthorizationAuditEventSchema,
  AuthorizationAuditEventSchema,
  GatewayAuthorizationAuditIngestSchema,
  GatewayAuthorizationAuditListPathSchema,
  GatewayAuthorizationAuditListQuerySchema,
  GatewayAuthorizationAuditPathSchema,
  GatewayAuthorizationAuditQueryResponseSchema,
} from "./contract"
import type { GatewayAuthorizationAuditStore } from "./module"
import { PlatformApiError, PlatformApiErrorResponseSchema } from "../errors"

export interface GatewayAuthorizationAuditHttpOptions {
  store: GatewayAuthorizationAuditStore
  authorizeRuntime(input: {
    tenantId: string
    runtimeId: string
    request: { principal?: import("../tenancy-auth/contract").Principal }
  }): Promise<void>
}

export const gatewayAuthorizationAuditHttp: FastifyPluginAsync<GatewayAuthorizationAuditHttpOptions> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.post(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/audit-events",
    {
      schema: {
        operationId: "recordGatewayAuthorizationAuditEvent",
        tags: ["Runtime Control"],
        params: GatewayAuthorizationAuditPathSchema,
        body: GatewayAuthorizationAuditIngestSchema,
        response: { 201: GatewayAuthorizationAuditEventSchema },
      },
    },
    async (request, reply) => {
      await options.authorizeRuntime({
        tenantId: request.params.tenant_id,
        runtimeId: request.params.runtime_id,
        request,
      })
      const event = await options.store.record({
        tenantId: request.params.tenant_id,
        event: request.body,
      })
      if (event.kind !== "ONE_POLICY_DECISION") throw new PlatformApiError("AUDIT_EVENT_KIND_INVALID", 500)
      return reply.code(201).send(event)
    },
  )
  routes.get(
    "/v1/tenants/:tenant_id/audit-events",
    {
      schema: {
        operationId: "listGatewayAuthorizationAuditEvents",
        tags: ["Audit"],
        params: GatewayAuthorizationAuditListPathSchema,
        querystring: GatewayAuthorizationAuditListQuerySchema,
        response: {
          200: Type.Union([
            Type.Array(AuthorizationAuditEventSchema),
            GatewayAuthorizationAuditQueryResponseSchema,
          ]),
          400: PlatformApiErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const offset = request.query.offset ?? 0
      const limit = request.query.limit ?? 100
      const from = request.query.from
      const to = request.query.to
      if (from !== undefined && to !== undefined && from > to) {
        throw new PlatformApiError("AUDIT_QUERY_TIME_RANGE_INVALID", 400)
      }
      const page = await options.store.query({
        tenantId: request.params.tenant_id,
        correlationId: request.query.correlation_id,
        enforcementPointId: request.query.enforcement_point_id,
        kind: request.query.kind,
        outcome: request.query.outcome,
        resourceId: request.query.resource_id,
        subjectId: request.query.subject_id,
        from,
        to,
        offset,
        limit,
      })
      if (!request.query.metadata) return page.events

      const asOf = Math.floor(Date.now() / 1000)
      const occurred = page.events.map((event) => event.occurred_at)
      const latestEventAt = occurred.length ? Math.max(...occurred) : null
      return {
        events: page.events,
        source_revision: page.sourceRevision,
        offset,
        limit,
        freshness: {
          as_of: asOf,
          latest_event_at: latestEventAt,
          age_seconds: latestEventAt === null ? null : Math.max(0, asOf - latestEventAt),
        },
        coverage: {
          requested_from: from ?? null,
          requested_to: to ?? null,
          returned_from: occurred.length ? Math.min(...occurred) : null,
          returned_to: latestEventAt,
          returned_count: page.events.length,
          has_more: page.hasMore,
        },
      }
    },
  )
}
