import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  ApplicationApiCredentialCreationSchema,
  ApplicationApiCredentialListSchema,
  ApplicationApiCredentialSchema,
  ApplicationCredentialItemPathSchema,
  ApplicationCredentialPathSchema,
  ApplicationListSchema,
  ApplicationSchema,
  ApplicationTenantPathSchema,
  IssueApplicationOAuthCredentialSchema,
  RegisterApplicationSchema,
  RevokeApplicationCredentialSchema,
  RotateApplicationCredentialSchema,
} from "./contract"
import type { ApplicationRegistry } from "./module"
import { PlatformApiError } from "../errors"

export const applicationHttp: FastifyPluginAsync<{
  registry: ApplicationRegistry
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  async function visibleApplication(input: {
    tenantId: string
    applicationId: string
    role?: string
    organizationIds?: readonly string[]
  }) {
    const application = (await options.registry.list({ tenantId: input.tenantId }))
      .find((value) => value.application_id === input.applicationId)
    if (!application) throw new PlatformApiError("APPLICATION_NOT_FOUND", 404)
    if (
      input.role !== "TENANT_ADMINISTRATOR" &&
      !new Set(input.organizationIds ?? []).has(application.owner_organization_id)
    ) {
      throw new PlatformApiError("APPLICATION_NOT_FOUND", 404)
    }
    return application
  }
  routes.get(
    "/v1/tenants/:tenant_id/applications",
    {
      schema: {
        operationId: "listApplications",
        tags: ["Applications"],
        params: ApplicationTenantPathSchema,
        response: { 200: ApplicationListSchema },
      },
    },
    async (request) => {
      const values = await options.registry.list({ tenantId: request.params.tenant_id })
      if (request.principal?.role === "TENANT_ADMINISTRATOR") return values
      const visible = new Set(request.principal?.organization_ids ?? [])
      return values.filter((value) => visible.has(value.owner_organization_id))
    },
  )
  routes.post(
    "/v1/tenants/:tenant_id/applications",
    {
      schema: {
        operationId: "registerApplication",
        tags: ["Applications"],
        params: ApplicationTenantPathSchema,
        body: RegisterApplicationSchema,
        response: { 201: ApplicationSchema },
      },
    },
    async (request, reply) => reply.code(201).send(await options.registry.register({
      tenantId: request.params.tenant_id,
      registeredBySubjectId: request.principal!.subject_id,
      value: request.body,
    })),
  )
  routes.get(
    "/v1/tenants/:tenant_id/applications/:application_id/api-credentials",
    {
      schema: {
        operationId: "listApplicationApiCredentials",
        tags: ["Applications"],
        params: ApplicationCredentialPathSchema,
        response: { 200: ApplicationApiCredentialListSchema },
      },
    },
    async (request) => {
      await visibleApplication({
        tenantId: request.params.tenant_id,
        applicationId: request.params.application_id,
        role: request.principal?.role,
        organizationIds: request.principal?.organization_ids,
      })
      return options.registry.listCredentials({
        tenantId: request.params.tenant_id,
        applicationId: request.params.application_id,
      })
    },
  )
  routes.post(
    "/v1/tenants/:tenant_id/applications/:application_id/api-credentials",
    {
      schema: {
        operationId: "issueApplicationOAuthCredential",
        tags: ["Applications"],
        params: ApplicationCredentialPathSchema,
        body: IssueApplicationOAuthCredentialSchema,
        response: { 201: ApplicationApiCredentialCreationSchema },
      },
    },
    async (request, reply) => {
      await visibleApplication({
        tenantId: request.params.tenant_id,
        applicationId: request.params.application_id,
        role: request.principal?.role,
        organizationIds: request.principal?.organization_ids,
      })
      return reply.code(201).send(await options.registry.issueOAuthCredential({
        tenantId: request.params.tenant_id,
        applicationId: request.params.application_id,
        value: request.body,
      }))
    },
  )
  routes.post(
    "/v1/tenants/:tenant_id/applications/:application_id/api-credentials/:credential_id/rotate",
    {
      schema: {
        operationId: "rotateApplicationApiCredential",
        tags: ["Applications"],
        params: ApplicationCredentialItemPathSchema,
        body: RotateApplicationCredentialSchema,
        response: { 201: ApplicationApiCredentialCreationSchema },
      },
    },
    async (request, reply) => {
      await visibleApplication({
        tenantId: request.params.tenant_id,
        applicationId: request.params.application_id,
        role: request.principal?.role,
        organizationIds: request.principal?.organization_ids,
      })
      return reply.code(201).send(await options.registry.rotateCredential({
        tenantId: request.params.tenant_id,
        applicationId: request.params.application_id,
        credentialId: request.params.credential_id,
        value: request.body,
      }))
    },
  )
  routes.post(
    "/v1/tenants/:tenant_id/applications/:application_id/api-credentials/:credential_id/revoke",
    {
      schema: {
        operationId: "revokeApplicationApiCredential",
        tags: ["Applications"],
        params: ApplicationCredentialItemPathSchema,
        body: RevokeApplicationCredentialSchema,
        response: { 200: ApplicationApiCredentialSchema },
      },
    },
    async (request) => {
      await visibleApplication({
        tenantId: request.params.tenant_id,
        applicationId: request.params.application_id,
        role: request.principal?.role,
        organizationIds: request.principal?.organization_ids,
      })
      return options.registry.revokeCredential({
        tenantId: request.params.tenant_id,
        applicationId: request.params.application_id,
        credentialId: request.params.credential_id,
        correlationId: request.body.correlation_id,
      })
    },
  )
}
