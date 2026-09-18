import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import { PlatformApiError } from "../errors"
import {
  CreateProviderCredentialProfileSchema,
  ProviderCredentialProfileListSchema,
  ProviderCredentialProfilePathSchema,
  ProviderCredentialProfileRevisionSchema,
  ProviderCredentialProfileTenantPathSchema,
  ReviseProviderCredentialProfileSchema,
} from "./contract"
import type { ProviderCredentialProfileStore } from "./module"

export const providerCredentialProfileHttp: FastifyPluginAsync<{
  store: ProviderCredentialProfileStore
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()

  function canManage(request: {
    principal?: { role: string; organization_ids: readonly string[] }
  }, organizationId: string): boolean {
    return request.principal?.role === "TENANT_ADMINISTRATOR" ||
      request.principal?.organization_ids.includes(organizationId) === true
  }

  routes.get("/v1/tenants/:tenant_id/provider-credential-profiles", {
    schema: {
      operationId: "listProviderCredentialProfiles",
      tags: ["Provider Credentials"],
      params: ProviderCredentialProfileTenantPathSchema,
      response: { 200: ProviderCredentialProfileListSchema },
    },
  }, async (request) => {
    const profiles = await options.store.listLatest({ tenantId: request.params.tenant_id })
    if (request.principal?.role === "TENANT_ADMINISTRATOR") return profiles
    const organizationIds = new Set(request.principal?.organization_ids ?? [])
    return profiles.filter((profile) => organizationIds.has(profile.owner_organization_id))
  })

  routes.get("/v1/tenants/:tenant_id/provider-credential-profiles/:profile_id", {
    schema: {
      operationId: "getProviderCredentialProfile",
      tags: ["Provider Credentials"],
      params: ProviderCredentialProfilePathSchema,
      response: { 200: ProviderCredentialProfileRevisionSchema },
    },
  }, async (request) => {
    const profile = await options.store.getLatest({
      tenantId: request.params.tenant_id,
      profileId: request.params.profile_id,
    })
    if (!profile || !canManage(request, profile.owner_organization_id)) {
      throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_NOT_FOUND", 404)
    }
    return profile
  })

  routes.post("/v1/tenants/:tenant_id/provider-credential-profiles", {
    schema: {
      operationId: "createProviderCredentialProfile",
      tags: ["Provider Credentials"],
      params: ProviderCredentialProfileTenantPathSchema,
      body: CreateProviderCredentialProfileSchema,
      response: { 201: ProviderCredentialProfileRevisionSchema },
    },
  }, async (request, reply) => {
    if (!canManage(request, request.body.owner_organization_id)) {
      throw new PlatformApiError("ORGANIZATION_ADMIN_REQUIRED", 403)
    }
    return reply.code(201).send(await options.store.create({
      tenantId: request.params.tenant_id,
      createdBySubjectId: request.principal!.subject_id,
      value: request.body,
    }))
  })

  routes.post("/v1/tenants/:tenant_id/provider-credential-profiles/:profile_id/revisions", {
    schema: {
      operationId: "reviseProviderCredentialProfile",
      tags: ["Provider Credentials"],
      params: ProviderCredentialProfilePathSchema,
      body: ReviseProviderCredentialProfileSchema,
      response: { 201: ProviderCredentialProfileRevisionSchema },
    },
  }, async (request, reply) => {
    const current = await options.store.getLatest({
      tenantId: request.params.tenant_id,
      profileId: request.params.profile_id,
    })
    if (!current || !canManage(request, current.owner_organization_id)) {
      throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_NOT_FOUND", 404)
    }
    return reply.code(201).send(await options.store.revise({
      tenantId: request.params.tenant_id,
      profileId: request.params.profile_id,
      createdBySubjectId: request.principal!.subject_id,
      value: request.body,
    }))
  })
}
