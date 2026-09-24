import type { FastifyPluginAsync } from "fastify"
import { Type } from "typebox"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  GatewayAuthorizationAuditEventSchema,
  AuthorizationAuditEventSchema,
  AUDIT_EXPORT_MAX_RECORDS,
  AuditExportArtifactSchema,
  AuditExportQuerySchema,
  GatewayAuthorizationAuditIngestSchema,
  GatewayAuthorizationAuditListPathSchema,
  GatewayAuthorizationAuditListQuerySchema,
  GatewayAuthorizationAuditPathSchema,
  GatewayAuthorizationAuditQueryResponseSchema,
} from "./contract"
import type { AuditExportArtifact, AuditExportRecord, AuthorizationAuditEvent } from "./contract"
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

const AUDIT_EXPORT_PAGE_SIZE = 500

function auditExportRecord(
  event: AuthorizationAuditEvent,
  expected: { tenantId: string; resourceId: string; from: number; to: number },
): AuditExportRecord {
  if (event.kind !== "ONE_POLICY_DECISION") {
    throw new PlatformApiError(
      "AUDIT_EXPORT_SOURCE_INCONSISTENT",
      409,
      "The audit source contains an event that cannot be exported as a decision record",
    )
  }
  if (
    event.tenant_id !== expected.tenantId ||
    event.resource_id !== expected.resourceId ||
    event.occurred_at < expected.from ||
    event.occurred_at > expected.to ||
    !event.decision.correlation_id
  ) {
    throw new PlatformApiError(
      "AUDIT_EXPORT_SOURCE_INCONSISTENT",
      409,
      "The audit source returned an event outside the requested export boundary",
    )
  }
  return {
    policy_version: event.decision.policy_version,
    decision_correlation_id: event.decision.correlation_id,
    audit_event_id: event.audit_event_id,
    correlation_id: event.correlation_id,
    resource_id: event.resource_id,
    occurred_at: event.occurred_at,
  }
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
  routes.get(
    "/v1/tenants/:tenant_id/audit-export",
    {
      schema: {
        operationId: "exportGatewayAuthorizationAudit",
        tags: ["Audit"],
        params: GatewayAuthorizationAuditListPathSchema,
        querystring: AuditExportQuerySchema,
        response: {
          200: AuditExportArtifactSchema,
          400: PlatformApiErrorResponseSchema,
          403: PlatformApiErrorResponseSchema,
          409: PlatformApiErrorResponseSchema,
          422: PlatformApiErrorResponseSchema,
          500: PlatformApiErrorResponseSchema,
        },
      },
    },
    async (request): Promise<AuditExportArtifact> => {
      const { from, to, resource_id: resourceId } = request.query
      if (from > to) {
        throw new PlatformApiError(
          "AUDIT_EXPORT_TIME_RANGE_INVALID",
          400,
          "The audit export start time must not be after the end time",
        )
      }

      const query = (offset: number, limit: number) => options.store.query({
        tenantId: request.params.tenant_id,
        resourceId,
        from,
        to,
        offset,
        limit,
      })
      const records: AuditExportRecord[] = []
      let sourceRevision: number | null = null
      let offset = 0

      while (true) {
        const page = await query(offset, AUDIT_EXPORT_PAGE_SIZE)
        if (sourceRevision === null) {
          sourceRevision = page.sourceRevision
        } else if (page.sourceRevision !== sourceRevision) {
          throw new PlatformApiError(
            "AUDIT_EXPORT_SOURCE_CHANGED",
            409,
            "The audit source changed while the export was being assembled",
          )
        }
        if (page.events.length > AUDIT_EXPORT_PAGE_SIZE || (page.hasMore && page.events.length === 0)) {
          throw new PlatformApiError(
            "AUDIT_EXPORT_SOURCE_INCONSISTENT",
            409,
            "The audit source returned an inconsistent export page",
          )
        }
        records.push(...page.events.map((event) => auditExportRecord(event, {
          tenantId: request.params.tenant_id,
          resourceId,
          from,
          to,
        })))
        if (records.length > AUDIT_EXPORT_MAX_RECORDS || (records.length === AUDIT_EXPORT_MAX_RECORDS && page.hasMore)) {
          throw new PlatformApiError(
            "AUDIT_EXPORT_LIMIT_EXCEEDED",
            422,
            `Audit export exceeds the maximum of ${AUDIT_EXPORT_MAX_RECORDS} records`,
          )
        }
        if (!page.hasMore) break
        if (page.events.length === 0) {
          throw new PlatformApiError(
            "AUDIT_EXPORT_SOURCE_INCONSISTENT",
            409,
            "The audit source returned an inconsistent export page",
          )
        }
        offset += page.events.length
      }

      const verification = await query(0, 1)
      if (verification.sourceRevision !== sourceRevision) {
        throw new PlatformApiError(
          "AUDIT_EXPORT_SOURCE_CHANGED",
          409,
          "The audit source changed while the export was being assembled",
        )
      }

      return {
        schema_version: "genioone.audit-export.v1",
        tenant_id: request.params.tenant_id,
        from,
        to,
        resource_id: resourceId,
        record_count: records.length,
        records,
      }
    },
  )
}
