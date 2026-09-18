import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"

import { PlatformApiError } from "../errors"
import type { Principal } from "../tenancy-auth/contract"
import {
  AccessNotificationListSchema,
  AccessEntitlementPathSchema,
  AccessRequestListSchema,
  AccessRequestPathSchema,
  AccessRequestSchema,
  AccessTenantPathSchema,
  CancelAccessRequestSchema,
  DecideAccessRequestSchema,
  LegacyEntitlementListSchema,
  LegacyEntitlementSchema,
  RevokeEntitlementSchema,
  RequestAccessOutcomeSchema,
  RequestAccessSchema,
  SubjectCatalogSchema,
} from "./contract"
import type { AccessActor, AccessGovernanceStore } from "./module"

function actor(principal: Principal): AccessActor {
  return {
    subjectId: principal.subject_id,
    clientId: principal.client_id,
    role: principal.role,
    organizationIds: principal.organization_ids,
  }
}

export const accessHttp: FastifyPluginAsync<{ store: AccessGovernanceStore }> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get("/v1/tenants/:tenant_id/catalog", {
    schema: { tags: ["Access"], params: AccessTenantPathSchema, response: { 200: SubjectCatalogSchema } },
  }, async (request) => options.store.catalog({
    tenantId: request.params.tenant_id,
    actor: actor(request.principal!),
  }))
  routes.post("/v1/tenants/:tenant_id/access-requests", {
    schema: { tags: ["Access"], params: AccessTenantPathSchema, body: RequestAccessSchema, response: { 200: RequestAccessOutcomeSchema } },
  }, async (request) => options.store.request({
    tenantId: request.params.tenant_id,
    actor: actor(request.principal!),
    value: request.body,
  }))
  routes.get("/v1/tenants/:tenant_id/me/access-requests", {
    schema: { tags: ["Access"], params: AccessTenantPathSchema, response: { 200: AccessRequestListSchema } },
  }, async (request) => options.store.listMine({
    tenantId: request.params.tenant_id,
    actor: actor(request.principal!),
  }))
  routes.get("/v1/tenants/:tenant_id/access-requests", {
    schema: { tags: ["Access"], params: AccessTenantPathSchema, response: { 200: AccessRequestListSchema } },
  }, async (request) => {
    if (request.principal!.role === "USER") throw new PlatformApiError("ACCESS_MANAGEMENT_REQUIRED", 403)
    return options.store.listManagement({
      tenantId: request.params.tenant_id,
      actor: actor(request.principal!),
    })
  })
  routes.post("/v1/tenants/:tenant_id/access-requests/:request_id/decision", {
    schema: {
      tags: ["Access"], params: AccessRequestPathSchema, body: DecideAccessRequestSchema,
      response: { 200: Type.Object({
        request: AccessRequestSchema,
        entitlement: Type.Union([LegacyEntitlementSchema, Type.Null()]),
      }, { additionalProperties: false }) },
    },
  }, async (request) => options.store.decide({
    tenantId: request.params.tenant_id,
    actor: actor(request.principal!),
    requestId: request.params.request_id,
    value: request.body,
  }))
  routes.post("/v1/tenants/:tenant_id/access-requests/:request_id/cancel", {
    schema: { tags: ["Access"], params: AccessRequestPathSchema, body: CancelAccessRequestSchema, response: { 200: AccessRequestSchema } },
  }, async (request) => options.store.cancel({
    tenantId: request.params.tenant_id,
    actor: actor(request.principal!),
    requestId: request.params.request_id,
    value: request.body,
  }))
  routes.post("/v1/tenants/:tenant_id/entitlements/:entitlement_id/revoke", {
    schema: {
      tags: ["Access"],
      params: AccessEntitlementPathSchema,
      body: RevokeEntitlementSchema,
      response: { 200: LegacyEntitlementSchema },
    },
  }, async (request) => options.store.revokeEntitlement({
    tenantId: request.params.tenant_id,
    actor: actor(request.principal!),
    entitlementId: request.params.entitlement_id,
    value: request.body,
  }))
  routes.get("/v1/tenants/:tenant_id/me/entitlements", {
    schema: { tags: ["Access"], params: AccessTenantPathSchema, response: { 200: LegacyEntitlementListSchema } },
  }, async (request) => options.store.entitlementsForSubject({
    tenantId: request.params.tenant_id,
    actor: actor(request.principal!),
  }))
  routes.get("/v1/tenants/:tenant_id/me/owned-entitlements", {
    schema: { tags: ["Access"], params: AccessTenantPathSchema, response: { 200: LegacyEntitlementListSchema } },
  }, async (request) => options.store.entitlementsForOwner({
    tenantId: request.params.tenant_id,
    actor: actor(request.principal!),
  }))
  routes.get("/v1/tenants/:tenant_id/me/access-notifications", {
    schema: { tags: ["Access"], params: AccessTenantPathSchema, response: { 200: AccessNotificationListSchema } },
  }, async (request) => options.store.notifications({
    tenantId: request.params.tenant_id,
    actor: actor(request.principal!),
  }))
}
