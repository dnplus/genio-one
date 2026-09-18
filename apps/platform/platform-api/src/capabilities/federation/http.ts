import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import type { ApplicationRegistry } from "../applications/module"
import { PlatformApiError } from "../errors"
import {
  CreateFederationTrustRevisionSchema,
  FederationApplicationPathSchema,
  FederationExchangeEventListSchema,
  FederationTenantPathSchema,
  FederationTokenExchangeResponseSchema,
  FederationTokenExchangeSchema,
  FederationTrustRevisionListSchema,
  FederationTrustRevisionSchema,
} from "./contract"
import type { FederationService } from "./module"

export const federationHttp: FastifyPluginAsync<{
  service: FederationService
  applications: ApplicationRegistry
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()

  async function visibleApplication(input: {
    tenantId: string
    applicationId: string
    role?: string
    organizationIds?: readonly string[]
  }) {
    const application = (await options.applications.list({ tenantId: input.tenantId }))
      .find((value) => value.application_id === input.applicationId)
    if (!application) throw new PlatformApiError("APPLICATION_NOT_FOUND", 404)
    if (
      input.role !== "TENANT_ADMINISTRATOR" &&
      !new Set(input.organizationIds ?? []).has(application.owner_organization_id)
    ) throw new PlatformApiError("APPLICATION_NOT_FOUND", 404)
    return application
  }

  routes.get(
    "/v1/tenants/:tenant_id/applications/:application_id/federation-trust-revisions",
    {
      schema: {
        operationId: "listApplicationFederationTrustRevisions",
        tags: ["Applications"],
        params: FederationApplicationPathSchema,
        response: { 200: FederationTrustRevisionListSchema },
      },
    },
    async (request) => {
      await visibleApplication({
        tenantId: request.params.tenant_id,
        applicationId: request.params.application_id,
        role: request.principal?.role,
        organizationIds: request.principal?.organization_ids,
      })
      return options.service.listTrusts({
        tenantId: request.params.tenant_id,
        applicationId: request.params.application_id,
      })
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/applications/:application_id/federation-trust-revisions",
    {
      schema: {
        operationId: "createApplicationFederationTrustRevision",
        tags: ["Applications"],
        params: FederationApplicationPathSchema,
        body: CreateFederationTrustRevisionSchema,
        response: { 201: FederationTrustRevisionSchema },
      },
    },
    async (request, reply) => {
      await visibleApplication({
        tenantId: request.params.tenant_id,
        applicationId: request.params.application_id,
        role: request.principal?.role,
        organizationIds: request.principal?.organization_ids,
      })
      return reply.code(201).send(await options.service.createTrustRevision({
        tenantId: request.params.tenant_id,
        applicationId: request.params.application_id,
        createdBySubjectId: request.principal!.subject_id,
        value: request.body,
      }))
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/applications/:application_id/federation-exchanges",
    {
      schema: {
        operationId: "listApplicationFederationExchanges",
        tags: ["Applications"],
        params: FederationApplicationPathSchema,
        response: { 200: FederationExchangeEventListSchema },
      },
    },
    async (request) => {
      await visibleApplication({
        tenantId: request.params.tenant_id,
        applicationId: request.params.application_id,
        role: request.principal?.role,
        organizationIds: request.principal?.organization_ids,
      })
      return options.service.listExchangeEvents({
        tenantId: request.params.tenant_id,
        applicationId: request.params.application_id,
      })
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/sts/token-exchange",
    {
      schema: {
        operationId: "exchangeFederatedWorkloadToken",
        tags: ["Federation"],
        params: FederationTenantPathSchema,
        body: FederationTokenExchangeSchema,
        response: { 200: FederationTokenExchangeResponseSchema },
      },
    },
    async (request) => options.service.exchange({
      tenantId: request.params.tenant_id,
      value: request.body,
    }),
  )
}
