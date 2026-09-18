import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import { Type } from "typebox"

import {
  CreateOrganizationSchema,
  OrganizationListSchema,
  OrganizationPathSchema,
  OrganizationSchema,
  UpdateOrganizationSchema,
} from "./contract"
import type { OrganizationDirectory } from "./module"

export interface OrganizationHttpOptions {
  directory: OrganizationDirectory
}

export const organizationHttp: FastifyPluginAsync<OrganizationHttpOptions> = async (
  app,
  options,
) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()

  routes.get(
    "/v1/tenants/:tenant_id/organizations",
    {
      schema: {
        operationId: "listOrganizations",
        summary: "List owner organizations",
        tags: ["Organizations"],
        params: OrganizationPathSchema,
        response: { 200: OrganizationListSchema },
      },
    },
    async (request) => {
      const organizations = await options.directory.list({
        tenantId: request.params.tenant_id,
      })
      if (!request.principal) return []
      if (request.principal.role === "TENANT_ADMINISTRATOR") return organizations
      const visible = new Set(request.principal.organization_ids)
      return organizations.filter((organization) => visible.has(organization.organization_id))
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/organizations",
    {
      schema: {
        operationId: "createOrganization",
        summary: "Create a Resource owner organization",
        tags: ["Organizations"],
        params: OrganizationPathSchema,
        body: CreateOrganizationSchema,
        response: { 201: OrganizationSchema },
      },
    },
    async (request, reply) => {
      const organization = await options.directory.create({
        tenantId: request.params.tenant_id,
        ...request.body,
      })
      return reply.code(201).send(organization)
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/organizations/:organization_id",
    {
      schema: {
        operationId: "getOrganization",
        summary: "Get an owner organization",
        tags: ["Organizations"],
        params: Type.Object({
          tenant_id: Type.String({ minLength: 1 }),
          organization_id: Type.String({ minLength: 1 }),
        }),
        response: { 200: OrganizationSchema },
      },
    },
    async (request) =>
      options.directory.get({
        tenantId: request.params.tenant_id,
        organizationId: request.params.organization_id,
      }),
  )

  routes.put(
    "/v1/tenants/:tenant_id/organizations/:organization_id",
    {
      schema: {
        operationId: "updateOrganization",
        summary: "Update Organization membership and roles",
        tags: ["Organizations"],
        params: Type.Object({
          tenant_id: Type.String({ minLength: 1 }),
          organization_id: Type.String({ minLength: 1 }),
        }),
        body: UpdateOrganizationSchema,
        response: { 200: OrganizationSchema },
      },
    },
    async (request) => options.directory.update({
      tenantId: request.params.tenant_id,
      organizationId: request.params.organization_id,
      value: request.body,
    }),
  )
}
