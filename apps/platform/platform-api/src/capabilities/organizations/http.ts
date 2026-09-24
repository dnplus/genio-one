import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import { Type } from "typebox"
import { PlatformApiError } from "../errors"
import type { IdentityDirectory } from "../identity/module"
import type { AccessGroupDirectory } from "../access-groups/module"

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
  identity: Pick<IdentityDirectory, "inventory">
  accessGroups: Pick<AccessGroupDirectory, "assertOrganizationMembersRemainScoped">
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
      if (!request.principal) throw new PlatformApiError("UNAUTHENTICATED", 401)
      const inventory = await options.identity.inventory({ tenantId: request.params.tenant_id })
      const knownSubjects = new Set(inventory.subjects.map((subject) => subject.subject_id))
      if ((request.body.member_subject_ids ?? []).some((subjectId) => !knownSubjects.has(subjectId))) {
        throw new PlatformApiError("ORGANIZATION_MEMBER_NOT_FOUND", 422)
      }
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
    async (request) => {
      const principal = request.principal
      if (!principal) throw new PlatformApiError("UNAUTHENTICATED", 401)
      const current = await options.directory.get({
        tenantId: request.params.tenant_id,
        organizationId: request.params.organization_id,
      })
      if (
        principal.role === "ORGANIZATION_ADMINISTRATOR" &&
        !principal.organization_ids.includes(request.params.organization_id)
      ) {
        throw new PlatformApiError("ORGANIZATION_ACCESS_DENIED", 403)
      }
      if (principal.role === "USER") {
        throw new PlatformApiError("ORGANIZATION_ACCESS_DENIED", 403)
      }
      const inventory = await options.identity.inventory({ tenantId: request.params.tenant_id })
      const knownSubjects = new Set(inventory.subjects.map((subject) => subject.subject_id))
      const submittedSubjectIds = [
        ...request.body.member_subject_ids,
        ...request.body.organization_administrator_subject_ids,
      ]
      if (submittedSubjectIds.some((subjectId) => !knownSubjects.has(subjectId))) {
        throw new PlatformApiError("ORGANIZATION_MEMBER_NOT_FOUND", 422)
      }
      if (
        principal.role === "ORGANIZATION_ADMINISTRATOR" &&
        submittedSubjectIds.some((subjectId) => !current.member_subject_ids.includes(subjectId))
      ) {
        throw new PlatformApiError("ORGANIZATION_MEMBER_SCOPE_REQUIRED", 422)
      }
      await options.accessGroups.assertOrganizationMembersRemainScoped({
        tenantId: request.params.tenant_id,
        organizationId: request.params.organization_id,
        memberSubjectIds: request.body.member_subject_ids,
      })
      return options.directory.update({
        tenantId: request.params.tenant_id,
        organizationId: request.params.organization_id,
        value: request.body,
      })
    },
  )
}
