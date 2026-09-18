import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"

import {
  AiUsageDashboardQuerySchema,
  AiUsageDashboardSchema,
  GatewayActivityEventSchema,
  GatewayActivityIngestSchema,
  GatewayActivityInventorySchema,
  GatewayActivityListPathSchema,
  GatewayActivityListQuerySchema,
  GatewayActivityPathSchema,
  GatewayActivitySessionPathSchema,
  GatewayActivitySessionTimelineSchema,
  buildSessionTimeline,
  GatewayActivityTrendQuerySchema,
  GatewayActivityTrendSchema,
  OutcomeAttributionInputSchema,
  OutcomeAttributionListSchema,
  OutcomeAttributionSchema,
  RoutingReconstructionSchema,
  RoutingAttemptEventSchema,
  RoutingAttemptIngestSchema,
} from "./contract"
import {
  GatewayActivityDetailPathSchema,
  GatewayActivityDetailSchema,
} from "./detail-contract"
import type { GatewayActivityMaterializer, GatewayActivityStore } from "./module"
import type { GatewayActivityDetailStore } from "./detail-module"
import type { GatewayMetricsStore } from "../metrics/module"
import { PlatformApiError, PlatformApiErrorResponseSchema } from "../errors"

export interface GatewayActivityHttpOptions {
  store: GatewayActivityStore
  detail?: GatewayActivityDetailStore
  materializer?: GatewayActivityMaterializer
  metrics?: GatewayMetricsStore
  authorizeRuntime(input: {
    tenantId: string
    runtimeId: string
    request: { principal?: import("../tenancy-auth/contract").Principal }
  }): Promise<void>
}

export const gatewayActivityHttp: FastifyPluginAsync<GatewayActivityHttpOptions> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.post(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/routing-attempts",
    {
      schema: {
        operationId: "recordRoutingAttempt",
        tags: ["Runtime Control"],
        params: GatewayActivityPathSchema,
        body: RoutingAttemptIngestSchema,
        response: { 201: RoutingAttemptEventSchema },
      },
    },
    async (request, reply) => {
      await options.authorizeRuntime({
        tenantId: request.params.tenant_id,
        runtimeId: request.params.runtime_id,
        request,
      })
      if (!options.store.recordAttempt) throw new PlatformApiError("ROUTING_ATTEMPT_STORE_UNAVAILABLE", 503)
      const attempt = await options.store.recordAttempt({ tenantId: request.params.tenant_id, event: request.body })
      return reply.code(201).send(attempt)
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/activities",
    {
      schema: {
        operationId: "recordGatewayActivity",
        tags: ["Runtime Control"],
        params: GatewayActivityPathSchema,
        body: GatewayActivityIngestSchema,
        response: { 201: GatewayActivityEventSchema },
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
      return reply.code(201).send(event)
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/api-activities",
    {
      schema: {
        operationId: "listGatewayActivities",
        tags: ["Activity"],
        params: GatewayActivityListPathSchema,
        querystring: GatewayActivityListQuerySchema,
        response: { 200: GatewayActivityInventorySchema },
      },
    },
    async (request) => {
      try {
        await options.materializer?.refresh({ tenantId: request.params.tenant_id })
      } catch (error) {
        request.log.warn({ error }, "Gateway Activity materialization failed")
      }
      return { events: await options.store.list({
        tenantId: request.params.tenant_id,
        limit: request.query.limit ?? 100,
      }) }
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/api-activities/:correlation_id/detail",
    {
      schema: {
        operationId: "getGatewayActivityDetail",
        tags: ["Activity"],
        params: GatewayActivityDetailPathSchema,
        response: {
          200: GatewayActivityDetailSchema,
          404: PlatformApiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const detail = await options.detail?.get({
        tenantId: request.params.tenant_id,
        correlationId: request.params.correlation_id,
      })
      if (!detail) {
        throw new PlatformApiError(
          "ACTIVITY_DETAIL_NOT_FOUND",
          404,
          "Activity detail is unavailable for this correlation",
        )
      }
      return reply.code(200).send(detail)
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/activity-sessions/:session_id",
    {
      schema: {
        operationId: "getGatewayActivitySessionTimeline",
        tags: ["Activity"],
        params: GatewayActivitySessionPathSchema,
        response: { 200: GatewayActivitySessionTimelineSchema },
      },
    },
    async (request) => {
      const events = options.store.listSession
        ? await options.store.listSession({
            tenantId: request.params.tenant_id,
            sessionId: request.params.session_id,
          })
        : (await options.store.list({ tenantId: request.params.tenant_id, limit: 500 }))
            .filter((event) => event.session_id === request.params.session_id)
      return buildSessionTimeline(request.params.session_id, events)
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/activities/:correlation_id/routing-reconstruction",
    {
      schema: {
        operationId: "getRoutingReconstruction",
        tags: ["Activity"],
        params: GatewayActivityDetailPathSchema,
        response: { 200: RoutingReconstructionSchema, 404: PlatformApiErrorResponseSchema },
      },
    },
    async (request) => {
      const event = await options.store.get?.({
        tenantId: request.params.tenant_id,
        correlationId: request.params.correlation_id,
      })
      if (!event) throw new PlatformApiError("ROUTING_RECONSTRUCTION_NOT_FOUND", 404)
      const attempts = await options.store.listAttempts?.({
        tenantId: request.params.tenant_id,
        correlationId: request.params.correlation_id,
      }) ?? []
      return {
        correlation_id: event.correlation_id,
        resource_id: event.resource_id,
        capability_id: event.capability_id,
        routing_policy_id: event.routing_policy_id,
        routing_revision: event.routing_revision,
        release_revision: event.release_id ?? event.processor_bundle_revision,
        release_head_revision: event.release_head_revision ?? null,
        candidate_set_digest: event.candidate_set_digest,
        candidate_connection_ids: event.candidate_connection_ids ?? [],
        selected_connection_id: event.connection_id,
        ordered_attempts: attempts.map((attempt) => ({
          order: attempt.order,
          connection_id: attempt.connection_id,
          outcome: attempt.outcome,
        })),
        original_upstream_attempted: event.upstream_attempted,
        query_upstream_invoked: false as const,
        reconstructed_at: Math.floor(Date.now() / 1000),
      }
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/activities/:correlation_id/outcomes",
    {
      schema: {
        operationId: "recordActivityOutcomeAttribution",
        tags: ["Activity"],
        params: GatewayActivityDetailPathSchema,
        body: OutcomeAttributionInputSchema,
        response: { 201: OutcomeAttributionSchema, 404: PlatformApiErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (!options.store.get || !options.store.recordOutcome) {
        throw new PlatformApiError("OUTCOME_ATTRIBUTION_UNAVAILABLE", 503)
      }
      const event = await options.store.get({
        tenantId: request.params.tenant_id,
        correlationId: request.params.correlation_id,
      })
      if (!event) throw new PlatformApiError("ACTIVITY_NOT_FOUND", 404)
      const subjectId = request.principal?.subject_id
      if (!subjectId) throw new PlatformApiError("AUTHENTICATION_REQUIRED", 401)
      return reply.code(201).send(await options.store.recordOutcome({
        tenantId: request.params.tenant_id,
        correlationId: request.params.correlation_id,
        recordedBySubjectId: subjectId,
        value: request.body,
      }))
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/activities/:correlation_id/outcomes",
    {
      schema: {
        operationId: "listActivityOutcomeAttributions",
        tags: ["Activity"],
        params: GatewayActivityDetailPathSchema,
        response: { 200: OutcomeAttributionListSchema },
      },
    },
    async (request) => options.store.listOutcomes
      ? options.store.listOutcomes({
          tenantId: request.params.tenant_id,
          correlationId: request.params.correlation_id,
        })
      : [],
  )

  routes.get(
    "/v1/tenants/:tenant_id/transaction-trends",
    {
      schema: {
        operationId: "getGatewayTransactionTrends",
        tags: ["Activity"],
        params: GatewayActivityListPathSchema,
        querystring: GatewayActivityTrendQuerySchema,
        response: {
          200: GatewayActivityTrendSchema,
          400: Type.Object({
            error: Type.Literal("INVALID_TIME_RANGE"),
            message: Type.String(),
          }, { additionalProperties: false }),
        },
      },
    },
    async (request, reply) => {
      if (request.query.from > request.query.to) {
        return reply.code(400).send({
          error: "INVALID_TIME_RANGE",
          message: "from must be less than or equal to to",
        })
      }
      return {
        points: await options.store.trend({
          tenantId: request.params.tenant_id,
          from: request.query.from,
          to: request.query.to,
          timeZone: request.query.time_zone,
        }),
      }
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/ai-usage",
    {
      schema: {
        operationId: "getAiUsageDashboard",
        tags: ["Activity"],
        params: GatewayActivityListPathSchema,
        querystring: AiUsageDashboardQuerySchema,
        response: {
          200: AiUsageDashboardSchema,
          400: Type.Object({
            error: Type.Literal("INVALID_TIME_RANGE"),
            message: Type.String(),
          }, { additionalProperties: false }),
        },
      },
    },
    async (request, reply) => {
      if (request.query.from > request.query.to) {
        return reply.code(400).send({
          error: "INVALID_TIME_RANGE",
          message: "from must be less than or equal to to",
        })
      }
      try {
        await options.materializer?.refresh({ tenantId: request.params.tenant_id })
      } catch (error) {
        request.log.warn({ error }, "Gateway Activity materialization failed")
      }
      const [summary, metrics] = await Promise.all([
        options.store.summarize({
          tenantId: request.params.tenant_id,
          from: request.query.from,
          to: request.query.to,
        }),
        options.metrics?.summarize({
          tenantId: request.params.tenant_id,
          windowSeconds: Math.max(60, request.query.to - request.query.from),
        }),
      ])
      return metrics
        ? {
            ...summary,
            usage: {
              ...summary.usage,
              request_bytes: metrics.request_bytes,
              response_bytes: metrics.response_bytes,
            },
          }
        : summary
    },
  )
}
