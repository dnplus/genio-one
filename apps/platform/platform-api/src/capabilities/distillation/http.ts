import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"
import * as Value from "typebox/value"

import type { AccessGroupDirectory } from "../access-groups/module"
import { PlatformApiError } from "../errors"
import { principalHasManagementScope } from "../management-authorization/module"
import type { OrganizationDirectory } from "../organizations/module"
import type { Principal } from "../tenancy-auth/contract"
import {
  AssignKnowledgeWorkspaceSchema,
  CancelDistillationBotSchema,
  ClaimDistillationMarkerSchema,
  ClaimedDistillationMarkerSchema,
  CompleteDistillationMarkerSchema,
  CreateDistillationMarkerSchema,
  CreateTeamWorkspaceSchema,
  DistillationBotPathSchema,
  DistillationMarkerPageSchema,
  DistillationMarkerPathSchema,
  DistillationMarkerSchema,
  DistillationPageQuerySchema,
  DistillationTenantPathSchema,
  KnowledgeCandidatePageSchema,
  KnowledgeCandidatePathSchema,
  KnowledgeCandidateSchema,
  KnowledgeEvidenceSchema,
  ReviewKnowledgeCandidateSchema,
  TeamWorkspaceAccessQuerySchema,
  TeamWorkspacePathSchema,
  TeamWorkspaceSchema,
  type KnowledgeCandidate,
  type KnowledgeEvidence,
  type TeamWorkspace,
} from "./contract"
import type { DistillationStore } from "./module"

const CompletionSchema = Type.Object({
  marker: DistillationMarkerSchema,
  candidate: Type.Union([KnowledgeCandidateSchema, Type.Null()]),
}, { additionalProperties: false })

export type KnowledgeEvidenceReader = (input: {
  knowledgeId: string
  authorization: string
}) => Promise<unknown>

export type BotFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface DistillationHttpOptions {
  store: DistillationStore
  accessGroups: AccessGroupDirectory
  organizations: OrganizationDirectory
  botServiceEndpoint?: string
  fetchImpl?: BotFetch
  evidenceReader?: KnowledgeEvidenceReader
}

type WorkspaceRole = "reader" | "contributor" | "maintainer"

const MAINTAINER_ROLES: readonly WorkspaceRole[] = ["maintainer"]
const CONTRIBUTOR_ROLES: readonly WorkspaceRole[] = ["contributor", "maintainer"]
const VISIBLE_ROLES: readonly WorkspaceRole[] = ["reader", "contributor", "maintainer"]

async function workspaceIdsForRoles(input: {
  accessGroups: AccessGroupDirectory
  store: DistillationStore
  tenantId: string
  subjectId: string
  roles: readonly WorkspaceRole[]
  workspaces?: TeamWorkspace[]
}): Promise<string[]> {
  const [groups, workspaces] = await Promise.all([
    input.accessGroups.groupsForSubject({ tenantId: input.tenantId, subjectId: input.subjectId }),
    input.workspaces ?? input.store.listWorkspaces(input.tenantId),
  ])
  const groupIds = new Set(groups.filter((group) => group.enabled).map((group) => group.access_group_id))
  return workspaces
    .filter((workspace) => input.roles.some((role) => groupIds.has(workspace[`${role}_access_group_id`])))
    .map((workspace) => workspace.workspace_id)
}

function requireTenantAdministrator(principal: Principal): void {
  if (principal.role !== "TENANT_ADMINISTRATOR") {
    throw new PlatformApiError("TENANT_ADMINISTRATOR_REQUIRED", 403)
  }
}

function isManagementTenantAdministrator(principal: Principal): boolean {
  return principal.role === "TENANT_ADMINISTRATOR" && principalHasManagementScope(principal)
}

function requireAuthorization(authorization: string | undefined): string {
  if (!authorization) throw new PlatformApiError("UNAUTHENTICATED", 401)
  return authorization
}

function evidenceUnavailable(): PlatformApiError {
  return new PlatformApiError("KNOWLEDGE_EVIDENCE_UNAVAILABLE", 503)
}

class BotEvidenceFailure extends Error {
  constructor(readonly statusCode: number) {
    super("BOT_EVIDENCE_FAILURE")
  }
}

function mappedBotEvidenceFailure(statusCode: number): PlatformApiError {
  if (statusCode === 401) return new PlatformApiError("KNOWLEDGE_EVIDENCE_AUTH_REQUIRED", 401)
  if (statusCode === 403) return new PlatformApiError("KNOWLEDGE_EVIDENCE_FORBIDDEN", 403)
  if (statusCode === 404) return new PlatformApiError("KNOWLEDGE_EVIDENCE_NOT_FOUND", 404)
  if (statusCode === 409) return new PlatformApiError("KNOWLEDGE_EVIDENCE_CHANGED", 409)
  return evidenceUnavailable()
}

function defaultEvidenceReader(options: {
  botServiceEndpoint?: string
  fetchImpl?: BotFetch
}): KnowledgeEvidenceReader {
  return async ({ knowledgeId, authorization }) => {
    const endpoint = options.botServiceEndpoint?.trim() || process.env.GENIO_BOT_SERVICE_ENDPOINT?.trim()
    if (!endpoint) throw new BotEvidenceFailure(503)
    let response: Response
    try {
      const origin = new URL(endpoint)
      if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw new Error("BOT_ENDPOINT_INVALID")
      response = await (options.fetchImpl ?? globalThis.fetch)(
        new URL(`/api/knowledge-candidates/${encodeURIComponent(knowledgeId)}/evidence`, origin),
        {
          headers: { accept: "application/json", authorization },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      )
    } catch {
      throw new BotEvidenceFailure(503)
    }
    if (!response.ok) throw new BotEvidenceFailure(response.status)
    try {
      return await response.json()
    } catch {
      throw new BotEvidenceFailure(503)
    }
  }
}

function evidenceMatchesCandidate(evidence: KnowledgeEvidence, candidate: KnowledgeCandidate): boolean {
  return evidence.knowledge_id === candidate.knowledge_id &&
    evidence.tenant_id === candidate.tenant_id &&
    evidence.workspace_id === candidate.workspace_id &&
    evidence.content_digest === candidate.content_digest &&
    evidence.turns.length === candidate.provenance.turn_ids.length &&
    evidence.turns.every((turn, index) => turn.turn_id === candidate.provenance.turn_ids[index])
}

interface MaintainerCandidateLookup {
  accessGroups: AccessGroupDirectory
  store: DistillationStore
  tenantId: string
  subjectId: string
  knowledgeId: string
}

async function currentMaintainerCandidate(
  input: MaintainerCandidateLookup,
): Promise<{ candidate: KnowledgeCandidate; maintainerWorkspaceIds: string[] }> {
  const candidate = await input.store.getCandidate({ tenantId: input.tenantId, knowledgeId: input.knowledgeId })
  if (!candidate) throw new PlatformApiError("KNOWLEDGE_CANDIDATE_NOT_FOUND", 404)
  const workspaceIds = await workspaceIdsForRoles({
    accessGroups: input.accessGroups,
    store: input.store,
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    roles: MAINTAINER_ROLES,
  })
  if (!candidate.workspace_id || !workspaceIds.includes(candidate.workspace_id)) {
    throw new PlatformApiError("TEAM_WORKSPACE_MAINTAINER_REQUIRED", 403)
  }
  // A workspace move can commit while the ACL is resolved; never authorize a stale candidate snapshot.
  const current = await input.store.getCandidate({ tenantId: input.tenantId, knowledgeId: input.knowledgeId })
  if (!current) throw new PlatformApiError("KNOWLEDGE_CANDIDATE_NOT_FOUND", 404)
  if (current.workspace_id !== candidate.workspace_id || current.updated_at !== candidate.updated_at) {
    throw new PlatformApiError("KNOWLEDGE_EVIDENCE_CHANGED", 409)
  }
  return { candidate, maintainerWorkspaceIds: workspaceIds }
}

async function currentEvidence(input: {
  reader: KnowledgeEvidenceReader
  knowledgeId: string
  authorization: string
  candidate: KnowledgeCandidate
}): Promise<KnowledgeEvidence> {
  let value: unknown
  try {
    value = await input.reader({
      knowledgeId: input.knowledgeId,
      authorization: input.authorization,
    })
  } catch (error) {
    if (error instanceof BotEvidenceFailure) throw mappedBotEvidenceFailure(error.statusCode)
    throw evidenceUnavailable()
  }
  if (!Value.Check(KnowledgeEvidenceSchema, value)) throw evidenceUnavailable()
  const evidence = value as KnowledgeEvidence
  if (!evidenceMatchesCandidate(evidence, input.candidate)) {
    throw new PlatformApiError("KNOWLEDGE_EVIDENCE_CHANGED", 409)
  }
  return evidence
}

/**
 * Reads bot evidence for the candidate, then re-reads the candidate and maintainer
 * access so callers can reject changes that raced with the evidence fetch.
 */
async function fencedEvidence(input: {
  lookup: MaintainerCandidateLookup
  reader: KnowledgeEvidenceReader
  authorization: string
  candidate: KnowledgeCandidate
}): Promise<{
  evidence: KnowledgeEvidence
  refreshed: { candidate: KnowledgeCandidate; maintainerWorkspaceIds: string[] }
}> {
  const evidence = await currentEvidence({
    reader: input.reader,
    knowledgeId: input.lookup.knowledgeId,
    authorization: input.authorization,
    candidate: input.candidate,
  })
  const refreshed = await currentMaintainerCandidate(input.lookup)
  return { evidence, refreshed }
}

export const distillationHttp: FastifyPluginAsync<DistillationHttpOptions> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  const evidenceReader = options.evidenceReader ?? defaultEvidenceReader(options)
  routes.post("/v1/tenants/:tenant_id/team-workspaces", {
    schema: {
      operationId: "createTeamWorkspace",
      tags: ["Distillation"],
      params: DistillationTenantPathSchema,
      body: CreateTeamWorkspaceSchema,
      response: { 200: TeamWorkspaceSchema },
    },
  }, async (request) => {
    const principal = request.principal!
    requireTenantAdministrator(principal)
    await options.organizations.get({ tenantId: principal.tenant_id, organizationId: request.body.organization_id })
    const groupIds = [
      request.body.reader_access_group_id,
      request.body.contributor_access_group_id,
      request.body.maintainer_access_group_id,
    ]
    if (new Set(groupIds).size !== groupIds.length) throw new PlatformApiError("TEAM_WORKSPACE_ROLES_NOT_DISTINCT", 422)
    for (const accessGroupId of groupIds) {
      const group = await options.accessGroups.get(principal, accessGroupId)
      if (!group.enabled) throw new PlatformApiError("TEAM_WORKSPACE_ACCESS_GROUP_DISABLED", 422)
    }
    return options.store.createWorkspace({
      tenantId: principal.tenant_id,
      createdBy: principal.subject_id,
      value: request.body,
    })
  })
  routes.get("/v1/tenants/:tenant_id/team-workspaces", {
    schema: {
      operationId: "listTeamWorkspaces",
      tags: ["Distillation"],
      params: DistillationTenantPathSchema,
      response: { 200: Type.Array(TeamWorkspaceSchema) },
    },
  }, async (request) => {
    const principal = request.principal!
    const workspaces = await options.store.listWorkspaces(principal.tenant_id)
    if (isManagementTenantAdministrator(principal)) return workspaces
    const visible = new Set(await workspaceIdsForRoles({
      accessGroups: options.accessGroups,
      store: options.store,
      tenantId: principal.tenant_id,
      subjectId: principal.subject_id,
      roles: VISIBLE_ROLES,
      workspaces,
    }))
    return workspaces.filter((workspace) => visible.has(workspace.workspace_id))
  })
  routes.get("/v1/tenants/:tenant_id/team-workspaces/:workspace_id", {
    schema: {
      operationId: "getTeamWorkspace",
      tags: ["Distillation"],
      params: TeamWorkspacePathSchema,
      querystring: TeamWorkspaceAccessQuerySchema,
      response: { 200: TeamWorkspaceSchema },
    },
  }, async (request) => {
    const principal = request.principal!
    const workspaces = await options.store.listWorkspaces(principal.tenant_id)
    const workspace = workspaces.find((item) => item.workspace_id === request.params.workspace_id)
    if (!workspace) throw new PlatformApiError("TEAM_WORKSPACE_NOT_FOUND", 404)
    const contributorOnly = request.query.access === "contributor"
    if (!contributorOnly && isManagementTenantAdministrator(principal)) {
      return workspace
    }
    const allowed = await workspaceIdsForRoles({
      accessGroups: options.accessGroups,
      store: options.store,
      tenantId: principal.tenant_id,
      subjectId: principal.subject_id,
      roles: contributorOnly ? CONTRIBUTOR_ROLES : VISIBLE_ROLES,
      workspaces,
    })
    if (!allowed.includes(workspace.workspace_id)) {
      throw new PlatformApiError(contributorOnly ? "TEAM_WORKSPACE_CONTRIBUTOR_REQUIRED" : "TEAM_WORKSPACE_READER_REQUIRED", 403)
    }
    return workspace
  })
  routes.post("/v1/tenants/:tenant_id/distillation-markers", {
    schema: {
      operationId: "createDistillationMarker",
      tags: ["Distillation"],
      params: DistillationTenantPathSchema,
      body: CreateDistillationMarkerSchema,
      response: { 200: DistillationMarkerSchema },
    },
  }, async (request) => {
    const principal = request.principal!
    return options.store.createMarker({
      tenantId: principal.tenant_id,
      ownerSubjectId: principal.subject_id,
      value: request.body,
      contributorWorkspaceIds: request.body.workspace_id === null || request.body.workspace_id === undefined
        ? []
        : await workspaceIdsForRoles({
          accessGroups: options.accessGroups,
          store: options.store,
          tenantId: principal.tenant_id,
          subjectId: principal.subject_id,
          roles: CONTRIBUTOR_ROLES,
        }),
    })
  })
  routes.delete("/v1/tenants/:tenant_id/distillation-markers/bots/:bot_id", {
    schema: {
      operationId: "cancelDistillationBot",
      tags: ["Distillation"],
      params: DistillationBotPathSchema,
      response: { 200: CancelDistillationBotSchema },
    },
  }, async (request) => options.store.cancelBot({
    tenantId: request.principal!.tenant_id,
    ownerSubjectId: request.principal!.subject_id,
    botId: request.params.bot_id,
  }))
  routes.post("/v1/tenants/:tenant_id/distillation-markers/claim", {
    schema: {
      operationId: "claimDistillationMarker",
      tags: ["Distillation"],
      params: DistillationTenantPathSchema,
      body: ClaimDistillationMarkerSchema,
      response: { 200: Type.Union([ClaimedDistillationMarkerSchema, Type.Null()]) },
    },
  }, async (request) => options.store.claim({
    tenantId: request.principal!.tenant_id,
    ownerSubjectId: request.principal!.subject_id,
    botId: request.body.bot_id,
    leaseOwner: request.body.lease_owner,
  }))
  routes.post("/v1/tenants/:tenant_id/distillation-markers/:marker_id/result", {
    schema: {
      operationId: "completeDistillationMarker",
      tags: ["Distillation"],
      params: DistillationMarkerPathSchema,
      body: CompleteDistillationMarkerSchema,
      response: { 200: CompletionSchema },
    },
  }, async (request) => options.store.complete({
    tenantId: request.principal!.tenant_id,
    ownerSubjectId: request.principal!.subject_id,
    markerId: request.params.marker_id,
    value: request.body,
  }))
  routes.get("/v1/tenants/:tenant_id/distillation-markers/:marker_id", {
    schema: {
      operationId: "getDistillationMarker",
      tags: ["Distillation"],
      params: DistillationMarkerPathSchema,
      response: { 200: DistillationMarkerSchema },
    },
  }, async (request) => options.store.getMarker({
    tenantId: request.principal!.tenant_id,
    ownerSubjectId: request.principal!.subject_id,
    markerId: request.params.marker_id,
  }))
  routes.get("/v1/tenants/:tenant_id/distillation-markers", {
    schema: {
      operationId: "listDistillationMarkers",
      tags: ["Distillation"],
      params: DistillationTenantPathSchema,
      querystring: DistillationPageQuerySchema,
      response: { 200: DistillationMarkerPageSchema },
    },
  }, async (request) => options.store.listMarkers({
    tenantId: request.principal!.tenant_id,
    ownerSubjectId: request.principal!.subject_id,
    limit: request.query.limit,
    cursor: request.query.cursor,
  }))
  routes.get("/v1/tenants/:tenant_id/knowledge-candidates", {
    schema: {
      operationId: "listKnowledgeCandidates",
      tags: ["Distillation"],
      params: DistillationTenantPathSchema,
      querystring: DistillationPageQuerySchema,
      response: { 200: KnowledgeCandidatePageSchema },
    },
  }, async (request) => options.store.listCandidates({
    tenantId: request.principal!.tenant_id,
    ownerSubjectId: request.principal!.subject_id,
    workspaceIds: await workspaceIdsForRoles({
      accessGroups: options.accessGroups,
      store: options.store,
      tenantId: request.principal!.tenant_id,
      subjectId: request.principal!.subject_id,
      roles: VISIBLE_ROLES,
    }),
    limit: request.query.limit,
    cursor: request.query.cursor,
  }))
  routes.get("/v1/tenants/:tenant_id/knowledge-candidates/:knowledge_id/review-context", {
    schema: {
      operationId: "getKnowledgeCandidateReviewContext",
      tags: ["Distillation"],
      params: KnowledgeCandidatePathSchema,
      response: { 200: KnowledgeCandidateSchema },
    },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store").header("vary", "authorization")
    const principal = request.principal!
    const { candidate } = await currentMaintainerCandidate({
      accessGroups: options.accessGroups,
      store: options.store,
      tenantId: principal.tenant_id,
      subjectId: principal.subject_id,
      knowledgeId: request.params.knowledge_id,
    })
    return reply.send(candidate)
  })
  routes.get("/v1/tenants/:tenant_id/knowledge-candidates/:knowledge_id/evidence", {
    config: { sensitiveResponse: true },
    schema: {
      operationId: "getKnowledgeCandidateEvidence",
      tags: ["Distillation"],
      params: KnowledgeCandidatePathSchema,
      response: { 200: KnowledgeEvidenceSchema },
    },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store").header("vary", "authorization")
    const principal = request.principal!
    const lookup: MaintainerCandidateLookup = {
      accessGroups: options.accessGroups,
      store: options.store,
      tenantId: principal.tenant_id,
      subjectId: principal.subject_id,
      knowledgeId: request.params.knowledge_id,
    }
    const { candidate } = await currentMaintainerCandidate(lookup)
    const authorization = requireAuthorization(request.headers.authorization)
    const { evidence, refreshed } = await fencedEvidence({ lookup, reader: evidenceReader, authorization, candidate })
    if (!evidenceMatchesCandidate(evidence, refreshed.candidate)) {
      throw new PlatformApiError("KNOWLEDGE_EVIDENCE_CHANGED", 409)
    }
    return reply.send(evidence)
  })
  routes.post("/v1/tenants/:tenant_id/knowledge-candidates/:knowledge_id/workspace", {
    schema: {
      operationId: "assignKnowledgeCandidateWorkspace",
      tags: ["Distillation"],
      params: KnowledgeCandidatePathSchema,
      body: AssignKnowledgeWorkspaceSchema,
      response: { 200: KnowledgeCandidateSchema },
    },
  }, async (request) => options.store.assignWorkspace({
    tenantId: request.principal!.tenant_id,
    actorSubjectId: request.principal!.subject_id,
    knowledgeId: request.params.knowledge_id,
    workspaceId: request.body.workspace_id,
    maintainerWorkspaceIds: await workspaceIdsForRoles({
      accessGroups: options.accessGroups,
      store: options.store,
      tenantId: request.principal!.tenant_id,
      subjectId: request.principal!.subject_id,
      roles: MAINTAINER_ROLES,
    }),
  }))
  routes.post("/v1/tenants/:tenant_id/knowledge-candidates/:knowledge_id/review", {
    schema: {
      operationId: "reviewKnowledgeCandidate",
      tags: ["Distillation"],
      params: KnowledgeCandidatePathSchema,
      body: ReviewKnowledgeCandidateSchema,
      response: { 200: KnowledgeCandidateSchema },
    },
  }, async (request) => {
    const principal = request.principal!
    const lookup: MaintainerCandidateLookup = {
      accessGroups: options.accessGroups,
      store: options.store,
      tenantId: principal.tenant_id,
      subjectId: principal.subject_id,
      knowledgeId: request.params.knowledge_id,
    }
    const { candidate, maintainerWorkspaceIds: currentMaintainerIds } = await currentMaintainerCandidate(lookup)
    if (candidate.review_state !== "PENDING_REVIEW") throw new PlatformApiError("KNOWLEDGE_REVIEW_CLOSED", 409)
    const authorization = requireAuthorization(request.headers.authorization)
    if (request.body.decision === "REJECT") {
      return options.store.reviewCandidate({
        tenantId: principal.tenant_id,
        reviewerId: principal.subject_id,
        knowledgeId: request.params.knowledge_id,
        decision: "REJECT",
        maintainerWorkspaceIds: currentMaintainerIds,
        expectedWorkspaceId: candidate.workspace_id!,
        expectedUpdatedAt: candidate.updated_at,
      })
    }
    const { evidence, refreshed } = await fencedEvidence({ lookup, reader: evidenceReader, authorization, candidate })
    if (refreshed.candidate.review_state !== "PENDING_REVIEW") {
      throw new PlatformApiError("KNOWLEDGE_REVIEW_CLOSED", 409)
    }
    if (!evidenceMatchesCandidate(evidence, refreshed.candidate)) {
      throw new PlatformApiError("KNOWLEDGE_EVIDENCE_CHANGED", 409)
    }
    return options.store.reviewCandidate({
      tenantId: principal.tenant_id,
      reviewerId: principal.subject_id,
      knowledgeId: request.params.knowledge_id,
      decision: request.body.decision,
      maintainerWorkspaceIds: refreshed.maintainerWorkspaceIds,
      expectedWorkspaceId: refreshed.candidate.workspace_id!,
      expectedUpdatedAt: refreshed.candidate.updated_at,
    })
  })
}
