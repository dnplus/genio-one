import {
  DISTILLATION_CLASSIFIER_VERSION,
  DISTILLATION_EXTRACTOR_VERSION,
  DISTILLATION_PROCESSING_STATES,
  isDistillationTriage,
  type DistillationEvidence,
  type DistillationProcessingState,
  type DistillationTriage,
} from "@genioone/protocol/distillation-triage"

export interface DistillationMarkerDraft {
  bot_id: string
  thread_id: string
  turn_ids: string[]
  source_revision: string
  content_digest: string
  scope_hint: string
  sensitivity: string
  knowledge_type: string
  representation: string
  classifier_version: typeof DISTILLATION_CLASSIFIER_VERSION
  extractor_version: typeof DISTILLATION_EXTRACTOR_VERSION
  evidence: DistillationEvidence[]
  excerpt_truncated: boolean
  workspace_id: string | null
}

export interface ClaimedMarker {
  marker_id: string
  content_digest: string
  lease_token: string
  turn_ids: string[]
  thread_id: string
  workspace_id?: string | null
}

export interface SubmittedMarker {
  marker_id: string
  processing_state?: DistillationProcessingState
  last_error?: string | null
}

export type DistillationCompletion = {
  lease_token: string
  outcome: "CANDIDATE_CREATED" | "WAITING_FOR_HISTORY" | "FAILED"
  content_digest?: string
  error?: string
}

export interface DistillationPlatform {
  submit(token: string, tenantId: string, draft: DistillationMarkerDraft): Promise<SubmittedMarker>
  claim(token: string, tenantId: string, botId: string, leaseOwner: string): Promise<ClaimedMarker | null>
  complete(token: string, tenantId: string, markerId: string, body: DistillationCompletion): Promise<void>
  marker?(token: string, tenantId: string, markerId: string): Promise<SubmittedMarker>
}

export interface DistillationClassifier {
  classify(tenantId: string, text: string): Promise<DistillationTriage>
}

async function readJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`DISTILLATION_PLATFORM_${response.status}`)
  return body
}

function isTriageResponse(value: unknown): value is { classifier_version: typeof DISTILLATION_CLASSIFIER_VERSION; triage: DistillationTriage } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  return keys.length === 2 &&
    keys.every((key) => key === "classifier_version" || key === "triage") &&
    record.classifier_version === DISTILLATION_CLASSIFIER_VERSION &&
    isDistillationTriage(record.triage)
}

function isProcessingState(value: unknown): value is DistillationProcessingState {
  return (DISTILLATION_PROCESSING_STATES as readonly unknown[]).includes(value)
}

export function createHttpDistillationPlatform(origin: string, fetchImpl: typeof fetch = fetch): DistillationPlatform {
  const root = origin.replace(/\/$/, "")
  const get = async (token: string, path: string) => readJson(await fetchImpl(`${root}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  }))
  const post = async (token: string, path: string, body: unknown) => readJson(await fetchImpl(`${root}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }))
  return {
    async submit(token, tenantId, draft) {
      const marker = await post(token, `/v1/tenants/${encodeURIComponent(tenantId)}/distillation-markers`, draft)
      if (typeof marker?.marker_id !== "string" || !isProcessingState(marker.processing_state)) throw new Error("DISTILLATION_PLATFORM_RESPONSE_INVALID")
      return {
        marker_id: marker.marker_id,
        processing_state: marker.processing_state,
        last_error: typeof marker.last_error === "string" ? marker.last_error : null,
      }
    },
    async claim(token, tenantId, botId, leaseOwner) {
      const claimed = await post(token, `/v1/tenants/${encodeURIComponent(tenantId)}/distillation-markers/claim`, { bot_id: botId, lease_owner: leaseOwner })
      if (!claimed) return null
      if (typeof claimed.marker_id !== "string" || typeof claimed.lease_token !== "string" || typeof claimed.content_digest !== "string" || !(claimed.workspace_id === null || typeof claimed.workspace_id === "string")) {
        throw new Error("DISTILLATION_PLATFORM_RESPONSE_INVALID")
      }
      return {
        marker_id: claimed.marker_id,
        content_digest: claimed.content_digest,
        lease_token: claimed.lease_token,
        turn_ids: Array.isArray(claimed.turn_ids) ? claimed.turn_ids.filter((id: unknown) => typeof id === "string") : [],
        thread_id: typeof claimed.thread_id === "string" ? claimed.thread_id : "",
        workspace_id: claimed.workspace_id,
      }
    },
    async complete(token, tenantId, markerId, body) {
      await post(token, `/v1/tenants/${encodeURIComponent(tenantId)}/distillation-markers/${encodeURIComponent(markerId)}/result`, body)
    },
    async marker(token, tenantId, markerId) {
      const marker = await get(token, `/v1/tenants/${encodeURIComponent(tenantId)}/distillation-markers/${encodeURIComponent(markerId)}`)
      if (marker?.marker_id !== markerId || !isProcessingState(marker.processing_state)) throw new Error("DISTILLATION_PLATFORM_RESPONSE_INVALID")
      return {
        marker_id: marker.marker_id,
        processing_state: marker.processing_state,
        last_error: typeof marker.last_error === "string" ? marker.last_error : null,
      }
    },
  }
}

export function createHttpDistillationClassifier(input: {
  url: string
  token: string
  adapterId: string
  fetchImpl?: typeof fetch
}): DistillationClassifier {
  const fetchImpl = input.fetchImpl ?? fetch
  return {
    async classify(tenantId, text) {
      const response = await fetchImpl(input.url, {
        method: "POST",
        headers: { authorization: `Bearer ${input.token}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ tenant_id: tenantId, adapter_id: input.adapterId, text }),
        signal: AbortSignal.timeout(10_000),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || !isTriageResponse(body)) return { status: "UNAVAILABLE", classifier_version: DISTILLATION_CLASSIFIER_VERSION }
      return body.triage
    },
  }
}
