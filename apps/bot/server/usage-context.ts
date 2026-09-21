import type { GenioPrincipal } from "./runtime-broker"
import { CE_DEMO_USE_CASE_ID } from "@genioone/protocol/ce-demo"

export interface BotUsageContext {
  consumerOrganizationId: string
  useCaseId: string
}

export class BotUsageContextError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code)
    this.name = "BotUsageContextError"
  }
}

interface PlatformUseCase {
  tenant_id: string
  organization_id: string
  use_case_id: string
  display_name: string
  state: "ACTIVE" | "DISABLED"
}

interface PlatformDemoProject {
  installation: "NOT_INSTALLED" | "SKIPPED" | "INSTALLED"
  organization_id: string | null
}

function platformOrigin() {
  return process.env.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
}

function isUseCase(value: unknown): value is PlatformUseCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row.tenant_id === "string" && row.tenant_id.trim().length > 0 &&
    typeof row.organization_id === "string" && row.organization_id.trim().length > 0 &&
    typeof row.use_case_id === "string" && row.use_case_id.trim().length > 0 &&
    typeof row.display_name === "string" && row.display_name.trim().length > 0 &&
    (row.state === "ACTIVE" || row.state === "DISABLED")
}

function isDemoProject(value: unknown): value is PlatformDemoProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const project = value as Record<string, unknown>
  return (project.installation === "NOT_INSTALLED" || project.installation === "SKIPPED" || project.installation === "INSTALLED") &&
    (typeof project.organization_id === "string" || project.organization_id === null)
}

async function demoInstallationOrganizationId(
  principal: GenioPrincipal,
  accessToken: string,
): Promise<string | null> {
  let response: Response
  try {
    response = await fetch(new URL(
      `/v1/tenants/${encodeURIComponent(principal.tenant_id)}/demo-project`,
      platformOrigin(),
    ), {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(2_000),
    })
  } catch {
    throw new BotUsageContextError("USAGE_CONTEXT_LOOKUP_UNAVAILABLE", 503)
  }
  if (!response.ok) throw new BotUsageContextError("USAGE_CONTEXT_LOOKUP_UNAVAILABLE", 503)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new BotUsageContextError("USAGE_CONTEXT_LOOKUP_INVALID", 503)
  }
  if (!isDemoProject(body)) throw new BotUsageContextError("USAGE_CONTEXT_LOOKUP_INVALID", 503)
  const organizationId = body.organization_id?.trim()
  return body.installation === "INSTALLED" && organizationId ? organizationId : null
}

async function listUseCases(
  principal: GenioPrincipal,
  accessToken: string,
  organizationId: string,
): Promise<PlatformUseCase[]> {
  let response: Response
  try {
    response = await fetch(new URL(
      `/v1/tenants/${encodeURIComponent(principal.tenant_id)}/organizations/${encodeURIComponent(organizationId)}/use-cases`,
      platformOrigin(),
    ), {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(2_000),
    })
  } catch {
    throw new BotUsageContextError("USAGE_CONTEXT_LOOKUP_UNAVAILABLE", 503)
  }
  if (!response.ok) throw new BotUsageContextError("USAGE_CONTEXT_LOOKUP_UNAVAILABLE", 503)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new BotUsageContextError("USAGE_CONTEXT_LOOKUP_INVALID", 503)
  }
  if (!Array.isArray(body) || !body.every(isUseCase)) throw new BotUsageContextError("USAGE_CONTEXT_LOOKUP_INVALID", 503)
  const values = body.filter((value) => value.tenant_id === principal.tenant_id && value.organization_id === organizationId)
  if (values.length !== body.length) throw new BotUsageContextError("USAGE_CONTEXT_LOOKUP_INVALID", 503)
  return values
}

export async function resolveBotUsageContext(input: {
  principal: GenioPrincipal
  accessToken: string
  useCaseId?: string
}): Promise<BotUsageContext | null> {
  const requested = input.useCaseId?.trim()
  let organizationIds = Array.isArray(input.principal.organization_ids)
    ? [...new Set(input.principal.organization_ids.filter((value): value is string => typeof value === "string" && value.trim().length > 0))]
    : []
  if (organizationIds.length === 0 && requested === CE_DEMO_USE_CASE_ID && input.principal.role === "TENANT_ADMINISTRATOR") {
    const organizationId = await demoInstallationOrganizationId(input.principal, input.accessToken)
    if (organizationId) organizationIds = [organizationId]
  }
  if (organizationIds.length === 0) {
    if (requested) throw new BotUsageContextError("USE_CASE_NOT_ALLOWED", 403)
    return null
  }
  const active: Array<{ organizationId: string; useCase: PlatformUseCase }> = []
  for (const organizationId of organizationIds) {
    const useCases = await listUseCases(input.principal, input.accessToken, organizationId)
    for (const useCase of useCases) {
      if (useCase.state === "ACTIVE") active.push({ organizationId, useCase })
    }
  }
  if (requested) {
    const matches = active.filter((candidate) => candidate.useCase.use_case_id === requested)
    if (matches.length !== 1) throw new BotUsageContextError("USE_CASE_NOT_ALLOWED", 403)
    return { consumerOrganizationId: matches[0]!.organizationId, useCaseId: requested }
  }
  if (active.length === 0) return null
  if (active.length !== 1) throw new BotUsageContextError("USE_CASE_SELECTION_REQUIRED", 409)
  return {
    consumerOrganizationId: active[0]!.organizationId,
    useCaseId: active[0]!.useCase.use_case_id,
  }
}
