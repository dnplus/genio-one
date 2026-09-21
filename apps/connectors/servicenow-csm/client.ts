import { observedFetch } from "@genioone/telemetry/operation-observability"
export type HttpRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface CaseQuery {
  caseNumber?: string
  state?: number
  limit: number
  offset: number
}

export class ServiceNowError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
  }
}

export function serviceNowOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("SERVICENOW_HTTPS_ORIGIN_REQUIRED")
  }
  return url.origin
}

export function createCaseClient(instanceUrl: string, accessToken: string, request: HttpRequest = (input, init) => observedFetch("genio-connector-servicenow-csm", input, init)) {
  const origin = serviceNowOrigin(instanceUrl)
  if (!accessToken || /[\s\x00-\x1f\x7f]/.test(accessToken)) throw new Error("SERVICENOW_ACCESS_TOKEN_REQUIRED")
  async function record(method: "GET" | "POST" | "PATCH" | "DELETE", sysId?: string, fields?: Record<string, string | number>) {
    if (sysId !== undefined && !/^[a-f0-9]{32}$/i.test(sysId)) throw new ServiceNowError("SERVICENOW_INVALID_SYS_ID", 400)
    const url = new URL(`/api/now/table/sn_customerservice_case${sysId ? `/${sysId}` : ""}`, origin)
    url.searchParams.set("sysparm_fields", "sys_id,number,short_description,description,priority,state,contact,account,assigned_to,work_notes,sys_updated_on")
    const response = await request(url, { method, headers: { accept: "application/json", authorization: `Bearer ${accessToken}`, ...(fields ? { "content-type": "application/json" } : {}) }, ...(fields ? { body: JSON.stringify(fields) } : {}), redirect: "error", signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new ServiceNowError(response.status === 401 ? "SERVICENOW_REAUTHORIZATION_REQUIRED" : response.status === 403 ? "SERVICENOW_ACCESS_DENIED" : response.status === 404 ? "SERVICENOW_CASE_NOT_FOUND" : "SERVICENOW_REQUEST_FAILED", response.status)
    if (method === "DELETE") return { sys_id: sysId, deleted: true }
    const body = await response.json() as { result?: unknown }
    if (!body.result || typeof body.result !== "object" || Array.isArray(body.result)) throw new ServiceNowError("SERVICENOW_RESPONSE_INVALID", 502)
    return body.result
  }
  return {
    get: (sysId: string) => record("GET", sysId),
    create: (fields: Record<string, string | number>) => record("POST", undefined, fields),
    update: (sysId: string, fields: Record<string, string | number>) => record("PATCH", sysId, fields),
    remove: (sysId: string) => record("DELETE", sysId),
    async list(query: CaseQuery) {
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100 || !Number.isInteger(query.offset) || query.offset < 0) {
        throw new Error("SERVICENOW_INVALID_PAGINATION")
      }
      if (query.caseNumber && !/^CS[0-9]+$/i.test(query.caseNumber)) throw new Error("SERVICENOW_INVALID_CASE_NUMBER")
      if (query.state !== undefined && (!Number.isInteger(query.state) || query.state < 0)) throw new Error("SERVICENOW_INVALID_STATE")
      const filters = [
        ...(query.caseNumber ? [`number=${query.caseNumber}`] : []),
        ...(query.state !== undefined ? [`state=${query.state}`] : []),
        "ORDERBYDESCsys_updated_on",
        "ORDERBYsys_id",
      ]
      const url = new URL("/api/now/table/sn_customerservice_case", origin)
      url.search = new URLSearchParams({
        sysparm_query: filters.join("^"),
        sysparm_fields: "sys_id,number,short_description,description,priority,state,sys_updated_on",
        sysparm_display_value: "all",
        sysparm_limit: String(query.limit),
        sysparm_offset: String(query.offset),
        sysparm_exclude_reference_link: "true",
      }).toString()
      const response = await request(url, {
        headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        throw new ServiceNowError(response.status === 401 ? "SERVICENOW_REAUTHORIZATION_REQUIRED" : response.status === 403 ? "SERVICENOW_ACCESS_DENIED" : "SERVICENOW_REQUEST_FAILED", response.status)
      }
      const body = await response.json() as { result?: unknown }
      if (!Array.isArray(body.result)) throw new ServiceNowError("SERVICENOW_RESPONSE_INVALID", 502)
      return body.result.map((record: Record<string, unknown>) => {
        const text = (key: string) => {
          const value = record[key]
          if (typeof value === "string") return value
          if (value && typeof value === "object") {
            const field = value as Record<string, unknown>
            return String(field.display_value ?? field.value ?? "")
          }
          return ""
        }
        const rawId = record.sys_id
        const sysId = typeof rawId === "string" ? rawId : String((rawId as Record<string, unknown> | null)?.value ?? "")
        return {
          sys_id: sysId,
          number: text("number"),
          short_description: text("short_description"),
          description: text("description"),
          priority: text("priority"),
          state: text("state"),
          updated_at: text("sys_updated_on"),
          url: `${origin}/nav_to.do?uri=${encodeURIComponent(`sn_customerservice_case.do?sys_id=${encodeURIComponent(sysId)}`)}`,
        }
      })
    },
  }
}
