import type {
  AccessNotification,
  AccessRequest,
  Entitlement,
  ResourceOnboardingRequest,
  SubjectCatalogSnapshot,
  TenantConfigurationRevision,
} from "@/domain/contracts"
import { refreshBrowserSession } from "@/lib/browser-oidc"

export type PersonalMemoryKind = "preference" | "fact" | "decision"
export type PersonalMemoryContextKind = "GLOBAL" | "PROJECT" | "CONTEXT"

export interface PersonalMemoryContext {
  kind: PersonalMemoryContextKind
  context_id: string | null
}

export interface PersonalMemorySource {
  actor_subject_id: string
  client_id: string
  agent_id: string | null
  agent_grant_id: string | null
  reference_id: string | null
}

export interface PersonalMemory {
  memory_id: string
  tenant_id: string
  scope: "PERSONAL"
  owner_subject_id: string | null
  team_id: null
  organization_id: null
  key: string
  kind: PersonalMemoryKind
  context: PersonalMemoryContext
  content: string
  assertion_origin: "USER_EXPLICIT" | "AGENT_INFERRED"
  source: PersonalMemorySource
  revision: number
  created_at: number
  updated_at: number
}

export interface PersonalMemoryPage {
  memories: PersonalMemory[]
  next_cursor: string | null
}

export interface PersonalMemoryAgentGrant {
  tenant_id: string
  owner_subject_id: string
  agent_id: string
  grant_id: string
  enabled_at: number
  revoked_at: number | null
}

export interface PersonalMemoryCommand {
  memory_id?: string
  expected_revision: number
  idempotency_key: string
  key: string
  kind: PersonalMemoryKind
  context: PersonalMemoryContext
  content: string
}

export type SharedMemoryScopeTarget =
  | { scope: "TEAM"; workspace_id: string }
  | { scope: "ORGANIZATION"; organization_id: string }

export type MemoryScopeTarget = { scope: "PERSONAL" } | SharedMemoryScopeTarget

export interface MemoryScopeAccess {
  target: MemoryScopeTarget
  display_name: string
  can_read: boolean
  can_contribute: boolean
  can_manage: boolean
}

export type SharedMemory = Omit<PersonalMemory, "scope" | "owner_subject_id" | "team_id" | "organization_id"> & {
  scope: "TEAM" | "ORGANIZATION"
  owner_subject_id: null
  team_id: string | null
  organization_id: string | null
}

export interface SharedMemoryPage {
  memories: SharedMemory[]
  next_cursor: string | null
}

export type SharedMemoryCommand = PersonalMemoryCommand & {
  source_reference_id?: string
}

export type SharedMemoryCorrectionProposalStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "STALE"

export interface SharedMemoryCorrectionProposal {
  proposal_id: string
  tenant_id: string
  memory_id: string
  scope: "TEAM" | "ORGANIZATION"
  owner_subject_id: null
  team_id: string | null
  organization_id: string | null
  base_revision: number
  proposed_kind: PersonalMemoryKind
  proposed_content: string | null
  source: PersonalMemorySource
  status: SharedMemoryCorrectionProposalStatus
  reviewer_subject_id: string | null
  created_at: number
  resolved_at: number | null
}

export interface SharedMemoryCorrectionProposalPage {
  proposals: SharedMemoryCorrectionProposal[]
  next_cursor: string | null
}

export interface SharedMemoryCorrectionProposalCommand {
  expected_revision: number
  idempotency_key: string
  content: string
  source_reference_id?: string
}

export interface SharedMemoryCorrectionProposalReview {
  proposal: SharedMemoryCorrectionProposal
  memory: SharedMemory | null
}

class SelfServiceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function requestJson<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const send = (accessToken: string) => {
    const headers = new Headers(init?.headers)
    headers.set("accept", "application/json")
    headers.set("authorization", `Bearer ${accessToken}`)
    if (init?.body) headers.set("content-type", "application/json")
    return fetch(path, { ...init, headers })
  }

  let response = await send(token)
  if (response.status === 401) {
    const refreshedToken = await refreshBrowserSession("/self-service")
    if (refreshedToken) response = await send(refreshedToken)
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "code" in body
        ? String(body.code)
        : `Product API request failed (${response.status})`
    throw new SelfServiceApiError(message, response.status)
  }
  return body as T
}

export async function loadSelfService(token: string, tenantId: string) {
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}`
  const [catalog, requests, entitlements, notifications, configuration, onboardingRequests] = await Promise.all([
    requestJson<SubjectCatalogSnapshot>(token, `${base}/catalog`),
    requestJson<AccessRequest[]>(token, `${base}/me/access-requests`),
    requestJson<Entitlement[]>(token, `${base}/me/entitlements`),
    requestJson<AccessNotification[]>(token, `${base}/me/access-notifications`),
    requestJson<TenantConfigurationRevision | null>(token, `${base}/self-service-configuration`),
    requestJson<ResourceOnboardingRequest[]>(token, `${base}/me/resource-onboarding-requests`).catch(() => []),
  ])
  return { catalog, requests, entitlements, notifications, onboardingRequests, configuration }
}

export function requestResourceOnboarding(
  token: string,
  tenantId: string,
  requestedResourceName: string,
  requestedServiceUrl: string,
  businessJustification: string,
) {
  return requestJson<ResourceOnboardingRequest>(
    token,
    `/v1/tenants/${encodeURIComponent(tenantId)}/resource-onboarding-requests`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `self-service-resource-onboarding-${crypto.randomUUID()}`,
        requested_resource_name: requestedResourceName,
        requested_service_url: requestedServiceUrl.trim() || null,
        business_justification: businessJustification,
      }),
    },
  )
}

export function requestAccess(
  token: string,
  tenantId: string,
  resourceId: string,
  capabilityId: string,
  justification: string,
  requestedValidForSeconds: number,
) {
  return requestJson<Record<string, AccessRequest>>(
    token,
    `/v1/tenants/${encodeURIComponent(tenantId)}/access-requests`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `self-service-request-${crypto.randomUUID()}`,
        resource_id: resourceId,
        capability_id: capabilityId,
        justification,
        requested_valid_for_seconds: requestedValidForSeconds,
      }),
    },
  )
}

export function cancelAccessRequest(token: string, tenantId: string, requestId: string) {
  return requestJson<AccessRequest>(
    token,
    `/v1/tenants/${encodeURIComponent(tenantId)}/access-requests/${encodeURIComponent(requestId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `self-service-cancel-${crypto.randomUUID()}`,
        reason: "Cancelled by requester in Self-service",
      }),
    },
  )
}

export function activateAutoGrant(
  token: string,
  tenantId: string,
  resourceId: string,
  capabilityId: string,
) {
  return requestJson<unknown>(
    token,
    `/v1/tenants/${encodeURIComponent(tenantId)}/me/entitlements/activate`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `self-service-auto-grant-${crypto.randomUUID()}`,
        resource_id: resourceId,
        capability_id: capabilityId,
      }),
    },
  )
}

export function listPersonalMemories(
  token: string,
  tenantId: string,
  cursor?: string | null,
) {
  const query = new URLSearchParams({ limit: "100" })
  if (cursor) query.set("cursor", cursor)
  return requestJson<PersonalMemoryPage>(
    token,
    `/v1/tenants/${encodeURIComponent(tenantId)}/me/memories?${query}`,
  )
}

export function rememberPersonalMemory(
  token: string,
  tenantId: string,
  input: PersonalMemoryCommand,
) {
  return requestJson<PersonalMemory>(
    token,
    `/v1/tenants/${encodeURIComponent(tenantId)}/me/memories`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  )
}

export function forgetPersonalMemory(
  token: string,
  tenantId: string,
  input: Pick<PersonalMemoryCommand, "expected_revision" | "idempotency_key"> & { memory_id: string },
) {
  return requestJson<{
    memory_id: string
    scope: "PERSONAL"
    owner_subject_id: string | null
    deleted_revision: number
    deleted_at: number
  }>(
    token,
    `/v1/tenants/${encodeURIComponent(tenantId)}/me/memories/${encodeURIComponent(input.memory_id)}`,
    {
      method: "DELETE",
      body: JSON.stringify({
        expected_revision: input.expected_revision,
        idempotency_key: input.idempotency_key,
      }),
    },
  )
}

export async function listPersonalMemoryAgents(token: string, tenantId: string) {
  const agents = new Map<string, PersonalMemoryAgentGrant>()
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  do {
    const query = new URLSearchParams({ limit: "100" })
    if (cursor) query.set("cursor", cursor)
    const page = await requestJson<{ agents: PersonalMemoryAgentGrant[]; next_cursor: string | null }>(
      token,
      `/v1/tenants/${encodeURIComponent(tenantId)}/me/memory-agents?${query}`,
    )
    for (const grant of page.agents) agents.set(grant.agent_id, grant)
    cursor = page.next_cursor
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error("MEMORY_AGENT_CURSOR_INVALID")
      seenCursors.add(cursor)
    }
  } while (cursor)
  return { agents: [...agents.values()] }
}

export function enablePersonalMemoryAgent(token: string, tenantId: string, agentId: string) {
  return requestJson<PersonalMemoryAgentGrant>(
    token,
    `/v1/tenants/${encodeURIComponent(tenantId)}/me/memory-agents`,
    {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId }),
    },
  )
}

export function revokePersonalMemoryAgent(token: string, tenantId: string, agentId: string) {
  return requestJson<PersonalMemoryAgentGrant>(
    token,
    `/v1/tenants/${encodeURIComponent(tenantId)}/me/memory-agents/${encodeURIComponent(agentId)}`,
    { method: "DELETE" },
  )
}

function sharedMemoryCollectionPath(tenantId: string, target: SharedMemoryScopeTarget) {
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}`
  if (target.scope === "TEAM") {
    return `${base}/team-workspaces/${encodeURIComponent(target.workspace_id)}/memories`
  }
  return `${base}/organizations/${encodeURIComponent(target.organization_id)}/memories`
}

export function listMemoryScopes(token: string, tenantId: string) {
  return requestJson<{ scopes: MemoryScopeAccess[] }>(
    token,
    `/v1/tenants/${encodeURIComponent(tenantId)}/me/memory-scopes`,
  )
}

export function listSharedMemories(
  token: string,
  tenantId: string,
  target: SharedMemoryScopeTarget,
  cursor?: string | null,
) {
  const query = new URLSearchParams({ limit: "100" })
  if (cursor) query.set("cursor", cursor)
  return requestJson<SharedMemoryPage>(
    token,
    `${sharedMemoryCollectionPath(tenantId, target)}?${query}`,
  )
}

export function rememberSharedMemory(
  token: string,
  tenantId: string,
  target: SharedMemoryScopeTarget,
  input: SharedMemoryCommand,
) {
  return requestJson<SharedMemory>(
    token,
    sharedMemoryCollectionPath(tenantId, target),
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  )
}

export function forgetSharedMemory(
  token: string,
  tenantId: string,
  target: SharedMemoryScopeTarget,
  input: Pick<SharedMemoryCommand, "expected_revision" | "idempotency_key"> & { memory_id: string },
) {
  return requestJson<{
    memory_id: string
    scope: "TEAM" | "ORGANIZATION"
    owner_subject_id: null
    deleted_revision: number
    deleted_at: number
  }>(
    token,
    `${sharedMemoryCollectionPath(tenantId, target)}/${encodeURIComponent(input.memory_id)}`,
    {
      method: "DELETE",
      body: JSON.stringify({
        expected_revision: input.expected_revision,
        idempotency_key: input.idempotency_key,
      }),
    },
  )
}

export function listSharedMemoryCorrectionProposals(
  token: string,
  tenantId: string,
  target: SharedMemoryScopeTarget,
  memoryId: string,
  input?: {
    cursor?: string | null
    status?: SharedMemoryCorrectionProposalStatus
  },
) {
  const query = new URLSearchParams({ limit: "100" })
  if (input?.cursor) query.set("cursor", input.cursor)
  if (input?.status) query.set("status", input.status)
  return requestJson<SharedMemoryCorrectionProposalPage>(
    token,
    `${sharedMemoryCollectionPath(tenantId, target)}/${encodeURIComponent(memoryId)}/corrections?${query}`,
  )
}

export function proposeSharedMemoryCorrection(
  token: string,
  tenantId: string,
  target: SharedMemoryScopeTarget,
  memoryId: string,
  input: SharedMemoryCorrectionProposalCommand,
) {
  return requestJson<SharedMemoryCorrectionProposal>(
    token,
    `${sharedMemoryCollectionPath(tenantId, target)}/${encodeURIComponent(memoryId)}/corrections`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  )
}

export function reviewSharedMemoryCorrection(
  token: string,
  tenantId: string,
  target: SharedMemoryScopeTarget,
  memoryId: string,
  proposalId: string,
  action: "ACCEPT" | "REJECT",
) {
  return requestJson<SharedMemoryCorrectionProposalReview>(
    token,
    `${sharedMemoryCollectionPath(tenantId, target)}/${encodeURIComponent(memoryId)}/corrections/${encodeURIComponent(proposalId)}/review`,
    {
      method: "POST",
      body: JSON.stringify({ action }),
    },
  )
}
