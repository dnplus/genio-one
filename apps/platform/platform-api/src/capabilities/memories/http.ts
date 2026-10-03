import type { FastifyPluginAsync, FastifyRequest } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type, type TSchema } from "typebox"
import { Check } from "typebox/value"

import { handleMemoryMcp, type MemoryMcpCompleted } from "../../../../../connectors/memory/server"
import type { IdentityDirectory } from "../identity/module"
import { PlatformApiError } from "../errors"
import type { Principal } from "../tenancy-auth/contract"
import {
  type PersonalMemoryCommand,
  type PersonalMemoryDelete,
  type PersonalMemoryList,
  MemoryScopeListResultSchema,
  PersonalMemoryAgentGrantSchema,
  PersonalMemoryAgentListResultSchema,
  PersonalMemoryAgentListSchema,
  PersonalMemoryCommandSchema,
  PersonalMemoryEnableAgentSchema,
  PersonalMemoryListSchema,
  SharedMemoryDeletionSchema,
  SharedMemoryIdempotencyKeySchema,
  SharedMemoryCorrectionProposalCommandSchema,
  SharedMemoryCorrectionProposalListResultSchema,
  SharedMemoryCorrectionProposalListSchema,
  SharedMemoryCorrectionProposalReviewResultSchema,
  SharedMemoryCorrectionProposalReviewSchema,
  SharedMemoryCorrectionProposalSchema,
  SharedMemorySchema,
} from "./contract"
import type { SharedMemoryDirectory, VerifiedPersonalMemoryGrantor } from "./module"
import type { SharedMemoryScopeSelector } from "./shared-scope-access"

const selfServiceClientId = "genio-one-self-service"
const managementConsoleClientId = "genio-one-management-console"
const invocationScope = "genioone-invocation"
const directMemoryClientIds = new Set([selfServiceClientId, managementConsoleClientId])
const identifier = Type.String({ minLength: 1, maxLength: 256 })
const tenantPath = Type.Object({ tenant_id: identifier })
const memoryPath = Type.Object({ tenant_id: identifier, memory_id: identifier })
const agentPath = Type.Object({ tenant_id: identifier, agent_id: identifier })
const workspacePath = Type.Object({ tenant_id: identifier, workspace_id: identifier }, { additionalProperties: false })
const organizationPath = Type.Object({ tenant_id: identifier, organization_id: identifier }, { additionalProperties: false })
const workspaceMemoryPath = Type.Object({ tenant_id: identifier, workspace_id: identifier, memory_id: identifier }, { additionalProperties: false })
const organizationMemoryPath = Type.Object({ tenant_id: identifier, organization_id: identifier, memory_id: identifier }, { additionalProperties: false })
const workspaceProposalPath = Type.Object({ tenant_id: identifier, workspace_id: identifier, memory_id: identifier, proposal_id: identifier }, { additionalProperties: false })
const organizationProposalPath = Type.Object({ tenant_id: identifier, organization_id: identifier, memory_id: identifier, proposal_id: identifier }, { additionalProperties: false })
const listResponse = Type.Object({
  memories: Type.Array(SharedMemorySchema),
  next_cursor: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
}, { additionalProperties: false })
const deleteInput = Type.Object({
  expected_revision: Type.Integer({ minimum: 1 }),
  idempotency_key: SharedMemoryIdempotencyKeySchema,
}, { additionalProperties: false })

interface SharedRoute {
  base: string
  scope: SharedMemoryScopeSelector["scope"]
  scope_parameter: "workspace_id" | "organization_id"
  collection_params: TSchema
  memory_params: TSchema
  proposal_params: TSchema
  tag: string
  operation: string
}
function errorCode(error: unknown): string {
  return error instanceof PlatformApiError ? error.code : "MEMORY_OPERATION_FAILED"
}

function requireInvocationScope(principal: Principal): void {
  if (principal.scopes?.includes(invocationScope)) return
  throw new PlatformApiError("INSUFFICIENT_SCOPE", 403, `The required OAuth scope is missing: ${invocationScope}`)
}

function strictBody(schema: TSchema) {
  return async (request: FastifyRequest): Promise<void> => {
    if (Check(schema, request.body)) return
    throw new PlatformApiError("REQUEST_VALIDATION_FAILED", 400, "Request validation failed")
  }
}

export const memoryHttp: FastifyPluginAsync<{
  directory: SharedMemoryDirectory
  identity: Pick<IdentityDirectory, "inventory">
}> = async (app, options) => {
  app.addHook("onRoute", (route) => {
    route.config = { ...route.config, sensitiveRequest: true, sensitiveResponse: true }
  })
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  const memoriesBase = "/v1/tenants/:tenant_id/me/memories"
  const agentsBase = "/v1/tenants/:tenant_id/me/memory-agents"

  async function verifiedOwner(request: FastifyRequest, tenantId: string): Promise<{
    actor: Principal
    grantor: VerifiedPersonalMemoryGrantor
  }> {
    const actor = request.principal
    if (!actor || actor.tenant_id !== tenantId) throw new PlatformApiError("AUTHENTICATION_REQUIRED", 401)
    requireInvocationScope(actor)
    if (actor.client_id !== selfServiceClientId) {
      throw new PlatformApiError("MEMORY_SELF_SERVICE_CLIENT_REQUIRED", 403)
    }
    const inventory = await options.identity.inventory({ tenantId })
    const subject = inventory.subjects.find((value) => value.subject_id === actor.subject_id)
    if (!subject || subject.kind !== "PERSON") {
      throw new PlatformApiError("MEMORY_PERSON_SUBJECT_REQUIRED", 403)
    }
    return {
      actor,
      grantor: {
        actor,
        management_authorized: true,
        person_subject: true,
      },
    }
  }

  async function verifiedSharedActor(request: FastifyRequest, tenantId: string): Promise<Principal> {
    const actor = request.principal
    if (!actor || actor.tenant_id !== tenantId) throw new PlatformApiError("AUTHENTICATION_REQUIRED", 401)
    requireInvocationScope(actor)
    if (!directMemoryClientIds.has(actor.client_id)) {
      throw new PlatformApiError("MEMORY_DIRECT_CLIENT_REQUIRED", 403)
    }
    const inventory = await options.identity.inventory({ tenantId })
    const subject = inventory.subjects.find((value) => value.subject_id === actor.subject_id)
    if (!subject || subject.kind !== "PERSON") {
      throw new PlatformApiError("MEMORY_PERSON_SUBJECT_REQUIRED", 403)
    }
    return actor
  }

  function ownerLog(request: FastifyRequest, operation: string, fields: {
    outcome: "SUCCEEDED" | "FAILED"
    memory_id?: string
    revision?: number
    agent_id?: string
    result_count?: number
    error_code?: string
  }) {
    const principal = request.principal
    request.log.info({
      event: "memory.owner.operation",
      correlation_id: request.id,
      tenant_id: principal?.tenant_id,
      subject_id: principal?.subject_id,
      acting_client_id: principal?.client_id,
      operation,
      ...fields,
    }, "Personal memory operation completed")
  }

  async function ownerOperation<T>(request: FastifyRequest, operation: string, execute: () => Promise<T>, metadata: (value: T) => Omit<Parameters<typeof ownerLog>[2], "outcome">) {
    try {
      const value = await execute()
      ownerLog(request, operation, { outcome: "SUCCEEDED", ...metadata(value) })
      return value
    } catch (error) {
      ownerLog(request, operation, { outcome: "FAILED", error_code: errorCode(error) })
      throw error
    }
  }

  function sharedLog(request: FastifyRequest, operation: string, scope: SharedMemoryScopeSelector["scope"], fields: {
    outcome: "SUCCEEDED" | "FAILED"
    scope_id?: string
    memory_id?: string
    proposal_id?: string
    revision?: number
    result_count?: number
    error_code?: string
  }) {
    const principal = request.principal
    request.log.info({
      event: "memory.shared.operation",
      correlation_id: request.id,
      tenant_id: principal?.tenant_id,
      subject_id: principal?.subject_id,
      acting_client_id: principal?.client_id,
      operation,
      scope,
      ...fields,
    }, "Shared memory operation completed")
  }

  async function sharedOperation<T>(
    request: FastifyRequest,
    operation: string,
    scope: SharedMemoryScopeSelector,
    execute: () => Promise<T>,
    metadata: (value: T) => Omit<Parameters<typeof sharedLog>[3], "outcome" | "scope_id">,
  ): Promise<T> {
    const scopeId = scope.scope === "TEAM" ? scope.workspace_id : scope.organization_id
    try {
      const value = await execute()
      sharedLog(request, operation, scope.scope, { outcome: "SUCCEEDED", scope_id: scopeId, ...metadata(value) })
      return value
    } catch (error) {
      sharedLog(request, operation, scope.scope, { outcome: "FAILED", scope_id: scopeId, error_code: errorCode(error) })
      throw error
    }
  }

  routes.get(memoriesBase, {
    schema: {
      operationId: "listMyPersonalMemories",
      tags: ["Personal Memory"],
      params: tenantPath,
      querystring: PersonalMemoryListSchema,
      response: { 200: listResponse },
    },
  }, async (request, reply) => {
    const { actor } = await verifiedOwner(request, request.params.tenant_id)
    const value = await ownerOperation(request, "list", () => options.directory.listPersonal(actor, request.query), (result) => ({ result_count: result.memories.length }))
    return reply.header("cache-control", "no-store").send(value)
  })

  routes.post(memoriesBase, {
    schema: {
      operationId: "rememberMyPersonalMemory",
      tags: ["Personal Memory"],
      params: tenantPath,
      body: PersonalMemoryCommandSchema,
      response: { 200: SharedMemorySchema, 201: SharedMemorySchema },
    },
  }, async (request, reply) => {
    const { actor } = await verifiedOwner(request, request.params.tenant_id)
    const value = await ownerOperation(request, "remember", () => options.directory.rememberPersonal(actor, request.body), (result) => ({ memory_id: result.memory_id, revision: result.revision }))
    return reply.code(request.body.memory_id === undefined ? 201 : 200).header("cache-control", "no-store").send(value)
  })

  routes.get(`${memoriesBase}/:memory_id`, {
    schema: {
      operationId: "getMyPersonalMemory",
      tags: ["Personal Memory"],
      params: memoryPath,
      response: { 200: SharedMemorySchema },
    },
  }, async (request, reply) => {
    const { actor } = await verifiedOwner(request, request.params.tenant_id)
    const value = await ownerOperation(request, "get", () => options.directory.getPersonal(actor, request.params.memory_id), (result) => ({ memory_id: result.memory_id, revision: result.revision, result_count: 1 }))
    return reply.header("cache-control", "no-store").send(value)
  })

  routes.delete(`${memoriesBase}/:memory_id`, {
    schema: {
      operationId: "forgetMyPersonalMemory",
      tags: ["Personal Memory"],
      params: memoryPath,
      body: deleteInput,
      response: { 200: SharedMemoryDeletionSchema },
    },
  }, async (request, reply) => {
    const { actor } = await verifiedOwner(request, request.params.tenant_id)
    const value = await ownerOperation(request, "forget", () => options.directory.deletePersonal(actor, {
      memory_id: request.params.memory_id,
      expected_revision: request.body.expected_revision,
      idempotency_key: request.body.idempotency_key,
    }), (result) => ({ memory_id: result.memory_id, revision: result.deleted_revision }))
    return reply.header("cache-control", "no-store").send(value)
  })

  routes.post(agentsBase, {
    schema: {
      operationId: "enableMyPersonalMemoryAgent",
      tags: ["Personal Memory"],
      params: tenantPath,
      body: PersonalMemoryEnableAgentSchema,
      response: { 201: PersonalMemoryAgentGrantSchema },
    },
  }, async (request, reply) => {
    const { actor, grantor } = await verifiedOwner(request, request.params.tenant_id)
    const value = await ownerOperation(request, "enable_agent", () => options.directory.enablePersonalAgent(actor, grantor, request.body), (result) => ({ agent_id: result.agent_id }))
    return reply.code(201).header("cache-control", "no-store").send(value)
  })

  routes.get(agentsBase, {
    schema: {
      operationId: "listMyPersonalMemoryAgents",
      tags: ["Personal Memory"],
      params: tenantPath,
      querystring: PersonalMemoryAgentListSchema,
      response: { 200: PersonalMemoryAgentListResultSchema },
    },
  }, async (request, reply) => {
    const { actor } = await verifiedOwner(request, request.params.tenant_id)
    const value = await ownerOperation(
      request,
      "list_agents",
      () => options.directory.listPersonalAgents(actor, request.query),
      (result) => ({ result_count: result.agents.length }),
    )
    return reply.header("cache-control", "no-store").send(value)
  })

  routes.get(`${agentsBase}/:agent_id`, {
    schema: {
      operationId: "getMyPersonalMemoryAgent",
      tags: ["Personal Memory"],
      params: agentPath,
      response: { 200: PersonalMemoryAgentGrantSchema },
    },
  }, async (request, reply) => {
    const { actor } = await verifiedOwner(request, request.params.tenant_id)
    const value = await ownerOperation(request, "get_agent", async () => {
      const grant = await options.directory.getPersonalAgent(actor, request.params.agent_id)
      if (!grant) throw new PlatformApiError("MEMORY_AGENT_GRANT_NOT_FOUND", 404)
      return grant
    }, (result) => ({ agent_id: result.agent_id }))
    return reply.header("cache-control", "no-store").send(value)
  })

  routes.delete(`${agentsBase}/:agent_id`, {
    schema: {
      operationId: "revokeMyPersonalMemoryAgent",
      tags: ["Personal Memory"],
      params: agentPath,
      response: { 200: PersonalMemoryAgentGrantSchema },
    },
  }, async (request, reply) => {
    const { actor, grantor } = await verifiedOwner(request, request.params.tenant_id)
    const value = await ownerOperation(request, "revoke_agent", () => options.directory.revokePersonalAgent(actor, grantor, { agent_id: request.params.agent_id }), (result) => ({ agent_id: result.agent_id }))
    return reply.header("cache-control", "no-store").send(value)
  })

  routes.get("/v1/tenants/:tenant_id/me/memory-scopes", {
    schema: {
      operationId: "listMyMemoryScopes",
      tags: ["Shared Memory"],
      params: tenantPath,
      response: { 200: MemoryScopeListResultSchema },
    },
  }, async (request, reply) => {
    const actor = await verifiedSharedActor(request, request.params.tenant_id)
    const value = await ownerOperation(
      request,
      "list_scopes",
      async () => ({ scopes: await options.directory.listMemoryScopes(actor) }),
      (result) => ({ result_count: result.scopes.length }),
    )
    return reply.header("cache-control", "no-store").send(value)
  })

  function scopeForRoute(input: SharedRoute, params: Record<string, string>): SharedMemoryScopeSelector {
    const scopeId = params[input.scope_parameter]
    if (input.scope === "TEAM") return { scope: "TEAM", workspace_id: scopeId }
    return { scope: "ORGANIZATION", organization_id: scopeId }
  }

  function registerSharedRoutes(input: SharedRoute): void {
    routes.get(input.base, {
      schema: {
        operationId: `list${input.operation}Memories`,
        tags: [input.tag],
        params: input.collection_params,
        querystring: PersonalMemoryListSchema,
        response: { 200: listResponse },
      },
    }, async (request, reply) => {
      const params = request.params as unknown as Record<string, string>
      const actor = await verifiedSharedActor(request, params.tenant_id)
      const scope = scopeForRoute(input, params)
      const value = await sharedOperation(
        request,
        "list",
        scope,
        () => options.directory.listShared(actor, scope, request.query as PersonalMemoryList),
        (result) => ({ result_count: result.memories.length }),
      )
      return reply.header("cache-control", "no-store").send(value)
    })

    routes.post(input.base, {
      schema: {
        operationId: `remember${input.operation}Memory`,
        tags: [input.tag],
        params: input.collection_params,
        body: PersonalMemoryCommandSchema,
        response: { 200: SharedMemorySchema, 201: SharedMemorySchema },
      },
      preValidation: strictBody(PersonalMemoryCommandSchema),
    }, async (request, reply) => {
      const params = request.params as unknown as Record<string, string>
      const actor = await verifiedSharedActor(request, params.tenant_id)
      const scope = scopeForRoute(input, params)
      const command = request.body as PersonalMemoryCommand
      const value = await sharedOperation(
        request,
        "remember",
        scope,
        () => options.directory.rememberShared(actor, scope, command),
        (result) => ({ memory_id: result.memory_id, revision: result.revision }),
      )
      return reply.code(command.memory_id === undefined ? 201 : 200).header("cache-control", "no-store").send(value)
    })

    routes.get(`${input.base}/:memory_id`, {
      schema: {
        operationId: `get${input.operation}Memory`,
        tags: [input.tag],
        params: input.memory_params,
        response: { 200: SharedMemorySchema },
      },
    }, async (request, reply) => {
      const params = request.params as unknown as Record<string, string>
      const actor = await verifiedSharedActor(request, params.tenant_id)
      const scope = scopeForRoute(input, params)
      const value = await sharedOperation(
        request,
        "get",
        scope,
        () => options.directory.getShared(actor, scope, params.memory_id),
        (result) => ({ memory_id: result.memory_id, revision: result.revision, result_count: 1 }),
      )
      return reply.header("cache-control", "no-store").send(value)
    })

    routes.delete(`${input.base}/:memory_id`, {
      schema: {
        operationId: `forget${input.operation}Memory`,
        tags: [input.tag],
        params: input.memory_params,
        body: deleteInput,
        response: { 200: SharedMemoryDeletionSchema },
      },
      preValidation: strictBody(deleteInput),
    }, async (request, reply) => {
      const params = request.params as unknown as Record<string, string>
      const actor = await verifiedSharedActor(request, params.tenant_id)
      const scope = scopeForRoute(input, params)
      const body = request.body as Omit<PersonalMemoryDelete, "memory_id">
      const value = await sharedOperation(
        request,
        "forget",
        scope,
        () => options.directory.deleteShared(actor, scope, {
          memory_id: params.memory_id,
          expected_revision: body.expected_revision,
          idempotency_key: body.idempotency_key,
        }),
        (result) => ({ memory_id: result.memory_id, revision: result.deleted_revision }),
      )
      return reply.header("cache-control", "no-store").send(value)
    })

    routes.get(`${input.base}/:memory_id/corrections`, {
      schema: {
        operationId: `list${input.operation}MemoryCorrections`,
        tags: [input.tag],
        params: input.memory_params,
        querystring: SharedMemoryCorrectionProposalListSchema,
        response: { 200: SharedMemoryCorrectionProposalListResultSchema },
      },
    }, async (request, reply) => {
      const params = request.params as unknown as Record<string, string>
      const actor = await verifiedSharedActor(request, params.tenant_id)
      const scope = scopeForRoute(input, params)
      const value = await sharedOperation(
        request,
        "list_corrections",
        scope,
        () => options.directory.listSharedCorrectionProposals(actor, scope, params.memory_id, request.query),
        (result) => ({ memory_id: params.memory_id, result_count: result.proposals.length }),
      )
      return reply.header("cache-control", "no-store").send(value)
    })

    routes.post(`${input.base}/:memory_id/corrections`, {
      schema: {
        operationId: `create${input.operation}MemoryCorrection`,
        tags: [input.tag],
        params: input.memory_params,
        body: SharedMemoryCorrectionProposalCommandSchema,
        response: { 201: SharedMemoryCorrectionProposalSchema },
      },
      preValidation: strictBody(SharedMemoryCorrectionProposalCommandSchema),
    }, async (request, reply) => {
      const params = request.params as unknown as Record<string, string>
      const actor = await verifiedSharedActor(request, params.tenant_id)
      const scope = scopeForRoute(input, params)
      const value = await sharedOperation(
        request,
        "create_correction",
        scope,
        () => options.directory.createSharedCorrectionProposal(actor, scope, params.memory_id, request.body),
        (result) => ({ memory_id: result.memory_id, proposal_id: result.proposal_id, revision: result.base_revision }),
      )
      return reply.code(201).header("cache-control", "no-store").send(value)
    })

    routes.post(`${input.base}/:memory_id/corrections/:proposal_id/review`, {
      schema: {
        operationId: `review${input.operation}MemoryCorrection`,
        tags: [input.tag],
        params: input.proposal_params,
        body: SharedMemoryCorrectionProposalReviewSchema,
        response: { 200: SharedMemoryCorrectionProposalReviewResultSchema },
      },
      preValidation: strictBody(SharedMemoryCorrectionProposalReviewSchema),
    }, async (request, reply) => {
      const params = request.params as unknown as Record<string, string>
      const actor = await verifiedSharedActor(request, params.tenant_id)
      const scope = scopeForRoute(input, params)
      const value = await sharedOperation(
        request,
        "review_correction",
        scope,
        () => options.directory.reviewSharedCorrectionProposal(actor, scope, params.memory_id, params.proposal_id, request.body),
        (result) => ({
          memory_id: result.proposal.memory_id,
          proposal_id: result.proposal.proposal_id,
          ...(result.memory ? { revision: result.memory.revision } : {}),
        }),
      )
      return reply.header("cache-control", "no-store").send(value)
    })
  }

  registerSharedRoutes({
    base: "/v1/tenants/:tenant_id/team-workspaces/:workspace_id/memories",
    scope: "TEAM",
    scope_parameter: "workspace_id",
    collection_params: workspacePath,
    memory_params: workspaceMemoryPath,
    proposal_params: workspaceProposalPath,
    tag: "Team Workspace Memory",
    operation: "TeamWorkspace",
  })

  registerSharedRoutes({
    base: "/v1/tenants/:tenant_id/organizations/:organization_id/memories",
    scope: "ORGANIZATION",
    scope_parameter: "organization_id",
    collection_params: organizationPath,
    memory_params: organizationMemoryPath,
    proposal_params: organizationProposalPath,
    tag: "Organization Memory",
    operation: "Organization",
  })

  routes.all("/v1/tenants/:tenant_id/memory/mcp", { schema: { hide: true, params: tenantPath } }, async (request, reply) => {
    const principal = request.principal
    if (!principal || principal.tenant_id !== request.params.tenant_id) {
      throw new PlatformApiError("AUTHENTICATION_REQUIRED", 401)
    }
    requireInvocationScope(principal)
    try {
      await options.directory.listPersonalAsAgent(principal, { limit: 1 })
    } catch (error) {
      request.log.info({
        event: "memory.mcp.authorize",
        correlation_id: request.id,
        tenant_id: principal.tenant_id,
        subject_id: principal.subject_id,
        acting_client_id: principal.client_id,
        outcome: "FAILED",
        error_code: errorCode(error),
      }, "Personal memory MCP authorization failed")
      throw error
    }
    const headers = new Headers()
    for (const name of ["content-type", "accept", "mcp-protocol-version", "mcp-session-id"]) {
      const value = request.headers[name]
      if (typeof value === "string") headers.set(name, value)
    }
    const response = await handleMemoryMcp(new Request(`http://platform${request.url}`, {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body === undefined ? undefined : JSON.stringify(request.body) }),
    }), {
      actor: principal,
      directory: options.directory,
      completed: (input: MemoryMcpCompleted) => request.log.info({
        event: "memory.mcp.operation",
        correlation_id: request.id,
        tenant_id: principal.tenant_id,
        subject_id: principal.subject_id,
        acting_client_id: principal.client_id,
        ...input,
      }, "Personal memory MCP operation completed"),
    })
    for (const [name, value] of response.headers) reply.header(name, value)
    reply.header("cache-control", "no-store")
    reply.header("x-request-id", request.id)
    return reply.code(response.status).send(response.body ? await response.text() : undefined)
  })
}
