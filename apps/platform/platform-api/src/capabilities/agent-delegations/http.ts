import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import { PlatformApiError } from "../errors"
import {
  AgentDelegationListSchema,
  AgentDelegationPathSchema,
  AgentDelegationSchema,
  AgentDelegationTenantPathSchema,
  CreateAgentDelegationSchema,
  RevokeAgentDelegationSchema,
} from "./contract"
import type { AgentDelegationDirectory } from "./module"

export const agentDelegationHttp: FastifyPluginAsync<{
  directory: AgentDelegationDirectory
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get("/v1/tenants/:tenant_id/agent-delegations", {
    schema: {
      operationId: "listAgentDelegations",
      tags: ["Agent Delegation"],
      params: AgentDelegationTenantPathSchema,
      response: { 200: AgentDelegationListSchema },
    },
  }, async (request) => {
    const principal = request.principal
    if (!principal) throw new PlatformApiError("AUTHENTICATION_REQUIRED", 401)
    const values = await options.directory.list({ tenantId: request.params.tenant_id })
    if (principal.role === "TENANT_ADMINISTRATOR") return values
    return values.filter((value) =>
      value.principal_subject_id === principal.subject_id || value.agent_subject_id === principal.subject_id)
  })

  routes.post("/v1/tenants/:tenant_id/agent-delegations", {
    schema: {
      operationId: "createAgentDelegation",
      tags: ["Agent Delegation"],
      params: AgentDelegationTenantPathSchema,
      body: CreateAgentDelegationSchema,
      response: { 201: AgentDelegationSchema },
    },
  }, async (request, reply) => {
    const principal = request.principal
    if (!principal) throw new PlatformApiError("AUTHENTICATION_REQUIRED", 401)
    return reply.code(201).send(await options.directory.create({
      tenantId: request.params.tenant_id,
      actor: {
        subjectId: principal.subject_id,
        tenantAdministrator: principal.role === "TENANT_ADMINISTRATOR",
      },
      value: request.body,
    }))
  })

  routes.post("/v1/tenants/:tenant_id/agent-delegations/:delegation_id/revoke", {
    schema: {
      operationId: "revokeAgentDelegation",
      tags: ["Agent Delegation"],
      params: AgentDelegationPathSchema,
      body: RevokeAgentDelegationSchema,
      response: { 200: AgentDelegationSchema },
    },
  }, async (request) => {
    const principal = request.principal
    if (!principal) throw new PlatformApiError("AUTHENTICATION_REQUIRED", 401)
    return options.directory.revoke({
      tenantId: request.params.tenant_id,
      delegationId: request.params.delegation_id,
      expectedRevision: request.body.expected_revision,
      actor: {
        subjectId: principal.subject_id,
        tenantAdministrator: principal.role === "TENANT_ADMINISTRATOR",
      },
    })
  })
}
