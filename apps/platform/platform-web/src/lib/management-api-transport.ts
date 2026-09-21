import { createBrowserObserver } from "@genioone/telemetry/browser-observability"
import { refreshBrowserSession } from "@/lib/browser-oidc"

type ProductApiViolation = {
  code: string
  message: string
  field?: string
}

export class ProductApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly violations: ReadonlyArray<ProductApiViolation> = [],
  ) {
    super(message)
  }
}

export function managementToken() {
  return sessionStorage.getItem("genioone.management_token")?.trim() ?? ""
}

const browserObserver = createBrowserObserver({ service: "genio-one-platform-web", token: managementToken, endpoint: tenantId => tenantId ? `/v1/tenants/${encodeURIComponent(tenantId)}/browser-telemetry` : "" })

function requestHeaders(init: RequestInit | undefined, accessToken: string) {
  const headers = new Headers(init?.headers)
  headers.set("accept", "application/json")
  if (typeof init?.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json")
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`)
  return headers
}

async function request(path: string, init?: RequestInit) {
  const token = managementToken()
  const send = (accessToken: string) => browserObserver.fetch(path, { ...init, headers: requestHeaders(init, accessToken) })
  let response = await send(token)
  if (response.status === 401 && token) {
    const refreshedToken = await refreshBrowserSession("/management", true)
    if (refreshedToken) response = await send(refreshedToken)
  }
  return response
}

function isProductApiViolation(value: unknown): value is ProductApiViolation {
  return typeof value === "object" && value !== null &&
    "code" in value && typeof value.code === "string" &&
    "message" in value && typeof value.message === "string"
}

async function throwProductApiError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null)
  const message = body && typeof body === "object" && "code" in body
    ? String(body.code)
    : "PRODUCT_API_REQUEST_FAILED"
  const violations = body && typeof body === "object" && "violations" in body && Array.isArray(body.violations)
    ? body.violations.filter(isProductApiViolation)
    : []
  throw new ProductApiError(message, response.status, violations)
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init)
  if (!response.ok) return throwProductApiError(response)
  return await response.json().catch(() => null) as T
}

export async function managementApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init)
  if (!response.ok) return throwProductApiError(response)
  const body = [204, 205, 304].includes(response.status) ? null : await response.text()
  const data = body ? JSON.parse(body) : {}
  return { data, status: response.status, headers: response.headers } as T
}
