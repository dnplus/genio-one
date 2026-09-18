import type { GenioPrincipal } from "./runtime-broker"

export interface AgentSubject {
  subjectId: string
  mode: "control-plane"
}

export async function ensureAgentSubject(input: {
  principal: GenioPrincipal
  accessToken: string
  displayName: string
}, environment: NodeJS.ProcessEnv = process.env): Promise<AgentSubject> {
  const platformOrigin = environment.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
  const authorization = input.accessToken.trim()

  if (!authorization) {
    throw new Error("AGENT_SUBJECT_REGISTRATION_REQUIRED:missing_credentials")
  }

  try {
    const response = await fetch(new URL(`/v1/tenants/${encodeURIComponent(input.principal.tenant_id)}/me/agents`, platformOrigin), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${authorization}`,
      },
      body: JSON.stringify({
        display_name: input.displayName.trim() || "Genio Bot",
      }),
      signal: AbortSignal.timeout(5_000),
    })
    const body = await response.json().catch(() => null) as { subject_id?: unknown; kind?: unknown; error?: unknown; code?: unknown } | null
    if (response.ok && body?.kind === "AGENT" && typeof body.subject_id === "string" && body.subject_id.trim()) {
      return { subjectId: body.subject_id, mode: "control-plane" }
    }
    const detail = typeof body?.code === "string" ? body.code
      : typeof body?.error === "string" ? body.error
      : (response.statusText || "unknown")
    if (response.status === 401 || response.status === 403) {
      throw new Error(`AGENT_SUBJECT_CREATE_FORBIDDEN:${response.status}:${detail}`)
    }
    if (response.status === 409) {
      throw new Error(`AGENT_SUBJECT_CREATE_CONFLICT:${detail}`)
    }
    throw new Error(`AGENT_SUBJECT_CREATE_FAILED:${response.status}:${detail}`)
  } catch (error) {
    throw error instanceof Error ? error : new Error("AGENT_SUBJECT_CREATE_FAILED")
  }
}
