import type { GenioPrincipal } from "./runtime-broker"

export interface ScheduleAuthorityRequest {
  principal: Pick<GenioPrincipal, "tenant_id" | "subject_id" | "acting_client_id">
  botId: string
  scheduleId: string
  runId: string
}

export interface ScheduleAuthority {
  issue(request: ScheduleAuthorityRequest): Promise<string | null>
}

export function createScheduleAuthority(environment: NodeJS.ProcessEnv = process.env): ScheduleAuthority {
  const endpoint = environment.GENIO_ONE_SCHEDULE_AUTHORITY_URL?.trim() ?? ""
  const serviceToken = environment.GENIO_ONE_SCHEDULE_AUTHORITY_TOKEN?.trim() ?? ""
  return {
    async issue(request) {
      if (!endpoint) return null
      if (!serviceToken) throw new Error("SCHEDULE_AUTHORITY_TOKEN_REQUIRED")
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${serviceToken}` },
        body: JSON.stringify({
          tenant_id: request.principal.tenant_id,
          subject_id: request.principal.subject_id,
          acting_client_id: request.principal.acting_client_id,
          bot_id: request.botId,
          schedule_id: request.scheduleId,
          run_id: request.runId,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      const body = await response.json().catch(() => null) as { access_token?: unknown } | null
      if (!response.ok || typeof body?.access_token !== "string" || !body.access_token.trim()) throw new Error("SCHEDULE_AUTHORITY_UNAVAILABLE")
      return body.access_token.trim()
    },
  }
}
