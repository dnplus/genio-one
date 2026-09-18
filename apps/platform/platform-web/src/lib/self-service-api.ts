import type {
  AccessNotification,
  AccessRequest,
  Entitlement,
  ResourceOnboardingRequest,
  SubjectCatalogSnapshot,
  TenantConfigurationRevision,
} from "@/domain/contracts"
import { refreshBrowserSession } from "@/lib/browser-oidc"

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
    `/v1/tenants/${encodeURIComponent(tenantId)}/invocations/authorize`,
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
