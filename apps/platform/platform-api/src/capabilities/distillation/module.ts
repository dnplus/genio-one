import type {
  CancelDistillationBot,
  ClaimedDistillationMarker,
  CompleteDistillationMarker,
  CreateDistillationMarker,
  CreateTeamWorkspace,
  DistillationMarker,
  KnowledgeCandidate,
  ReviewKnowledgeCandidate,
  TeamWorkspace,
} from "./contract"

export interface DistillationStore {
  createMarker(input: {
    tenantId: string
    ownerSubjectId: string
    value: CreateDistillationMarker
    contributorWorkspaceIds: readonly string[]
  }): Promise<DistillationMarker>
  cancelBot(input: {
    tenantId: string
    ownerSubjectId: string
    botId: string
  }): Promise<CancelDistillationBot>
  claim(input: {
    tenantId: string
    ownerSubjectId: string
    botId: string
    leaseOwner: string
  }): Promise<ClaimedDistillationMarker | null>
  complete(input: {
    tenantId: string
    ownerSubjectId: string
    markerId: string
    value: CompleteDistillationMarker
  }): Promise<{ marker: DistillationMarker; candidate: KnowledgeCandidate | null }>
  getMarker(input: {
    tenantId: string
    ownerSubjectId: string
    markerId: string
  }): Promise<DistillationMarker>
  listMarkers(input: {
    tenantId: string
    ownerSubjectId: string
    limit?: number
    cursor?: string
  }): Promise<{ markers: DistillationMarker[]; next_cursor: string | null }>
  listCandidates(input: {
    tenantId: string
    ownerSubjectId: string
    workspaceIds: readonly string[]
    limit?: number
    cursor?: string
  }): Promise<{ candidates: KnowledgeCandidate[]; next_cursor: string | null }>
  getCandidate(input: {
    tenantId: string
    knowledgeId: string
  }): Promise<KnowledgeCandidate | null>
  createWorkspace(input: {
    tenantId: string
    createdBy: string
    value: CreateTeamWorkspace
  }): Promise<TeamWorkspace>
  listWorkspaces(tenantId: string): Promise<TeamWorkspace[]>
  assignWorkspace(input: {
    tenantId: string
    actorSubjectId: string
    knowledgeId: string
    workspaceId: string
    maintainerWorkspaceIds: readonly string[]
  }): Promise<KnowledgeCandidate>
  reviewCandidate(input: {
    tenantId: string
    reviewerId: string
    knowledgeId: string
    decision: ReviewKnowledgeCandidate["decision"]
    maintainerWorkspaceIds: readonly string[]
    expectedWorkspaceId: string
    expectedUpdatedAt: number
  }): Promise<KnowledgeCandidate>
}
