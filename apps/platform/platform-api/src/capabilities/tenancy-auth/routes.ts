import { PlatformApiError } from "../errors"

export interface TenantRoute {
  tenantId: string
  rest: string[]
}

export function tenantRoute(request: {
  url: string
  raw?: { url?: string }
  routeOptions?: { url?: string }
  params?: unknown
}): TenantRoute | null {
  const rawPath = (request.raw?.url ?? request.url).split("?", 1)[0]!
  const rawSegments = rawPath.split("/").slice(1)
  const templateSegments = request.routeOptions?.url?.split("/").slice(1)
  const matchedTenantRoute = templateSegments?.[0] === "v1" && templateSegments[1] === "tenants" && templateSegments[2] === ":tenant_id"
  const rawTenantRoute = rawSegments[0] === "v1" && rawSegments[1] === "tenants"
  let decodedSegments: string[]
  try {
    decodedSegments = rawSegments.map((segment) => decodeURIComponent(segment))
  } catch {
    if (!matchedTenantRoute && !rawTenantRoute) return null
    throw new PlatformApiError("INVALID_TENANT_PATH", 400)
  }
  const decodedTenantRoute = decodedSegments[0] === "v1" && decodedSegments[1] === "tenants"
  if (!matchedTenantRoute && !rawTenantRoute && !decodedTenantRoute) return null
  if (!decodedTenantRoute || !decodedSegments[2] || rawPath.includes("\\") || rawPath.includes("\0")) {
    throw new PlatformApiError("INVALID_TENANT_PATH", 400)
  }
  if (decodedSegments.at(-1) === "") decodedSegments.pop()
  if (matchedTenantRoute) {
    const parameters = request.params
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || decodedSegments.length !== templateSegments.length) {
      throw new PlatformApiError("INVALID_TENANT_PATH", 400)
    }
    const segments = templateSegments.map((segment, index) => {
      if (!segment.startsWith(":")) {
        if (decodedSegments[index] !== segment) throw new PlatformApiError("INVALID_TENANT_PATH", 400)
        return segment
      }
      const parameter = Object.hasOwn(parameters, segment.slice(1))
        ? (parameters as Record<string, unknown>)[segment.slice(1)]
        : undefined
      if (typeof parameter !== "string" || !parameter || parameter.includes("\0") || parameter !== decodedSegments[index]) {
        throw new PlatformApiError("INVALID_TENANT_PATH", 400)
      }
      return parameter
    })
    return { tenantId: segments[2]!, rest: segments.slice(3) }
  }
  if (decodedSegments.some((segment) =>
    !segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0"),
  )) throw new PlatformApiError("INVALID_TENANT_PATH", 400)
  return { tenantId: decodedSegments[2]!, rest: decodedSegments.slice(3) }
}

export function isRuntimeControlTransport(route: TenantRoute, method: string): boolean {
  if (
    route.rest[0] !== "runtime-control" ||
    route.rest[1] !== "GATEWAY" ||
    !route.rest[2]
  ) return false
  if (
    method === "PUT" &&
    route.rest.length === 4 &&
    route.rest[3] === "capabilities"
  ) return true
  if (
    method === "PUT" &&
    route.rest.length === 5 &&
    route.rest[3] === "aggregate" &&
    route.rest[4] === "heartbeat"
  ) return true
  if (method === "POST") {
    return (
      route.rest.length === 4 &&
      (
        route.rest[3] === "activities" ||
        route.rest[3] === "routing-attempts" ||
        route.rest[3] === "audit-events" ||
        route.rest[3] === "accounting" ||
        route.rest[3] === "connection-health-observations"
      )
    ) || (
      route.rest.length === 5 &&
      route.rest[3] === "aggregate" &&
      route.rest[4] === "reports"
    ) || (
      route.rest.length === 7 &&
      route.rest[3] === "operations" &&
      route.rest[4] === "mcp-discovery" &&
      route.rest[6] === "result"
    )
  }
  if (method !== "GET") return false
  return (
    route.rest.length === 4 &&
    route.rest[3] === "connection-health-targets"
  ) || (
    route.rest.length === 5 &&
    route.rest[3] === "mcp-oauth" &&
    route.rest[4] === "headers"
  ) || (
    route.rest.length === 6 &&
    route.rest[3] === "operations" &&
    route.rest[4] === "mcp-discovery" &&
    route.rest[5] === "next"
  ) || (
    route.rest.length === 7 &&
    route.rest[3] === "operations" &&
    route.rest[4] === "mcp-discovery" &&
    route.rest[6] === "credential"
  ) || (
    route.rest.length === 6 &&
    route.rest[3] === "aggregate" &&
    route.rest[4] === "commands" &&
    route.rest[5] === "next"
  ) || (
    route.rest.length === 5 &&
    route.rest[3] === "aggregate" &&
    route.rest[4] === "connect"
  ) || (
    route.rest.length === 7 &&
    route.rest[3] === "aggregate" &&
    route.rest[4] === "releases" &&
    ["package", "credentials"].includes(route.rest[6]!)
  )
}

export function isRuntimeSelfRegistration(route: TenantRoute, method: string): boolean {
  return method === "PUT" &&
    route.rest.length === 4 &&
    route.rest[0] === "runtime-control" &&
    route.rest[1] === "GATEWAY" &&
    Boolean(route.rest[2]) &&
    route.rest[3] === "registration"
}
