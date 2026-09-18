import type { GenioPrincipal, RuntimeBroker } from "./runtime-broker"
import type { RuntimeTier } from "./runtime"

export async function verifyGenioOneAccessToken(accessToken: string): Promise<GenioPrincipal> {
  const origin = process.env.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
  const response = await fetch(new URL("/v1/identity/session", origin), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  })
  if (!response.ok) throw new Error("GENIO_ONE_SESSION_REJECTED")
  const principal = await response.json() as Partial<GenioPrincipal>
  if (
    !principal.tenant_id?.trim() ||
    !principal.subject_id?.trim() ||
    !principal.acting_client_id?.trim() ||
    !Array.isArray(principal.scopes)
  ) throw new Error("GENIO_ONE_SESSION_INVALID")
  return principal as GenioPrincipal
}

export function requestAccessToken(request: { headers: Record<string, string | string[] | undefined> }): string {
  const authorization = request.headers.authorization
  const value = Array.isArray(authorization) ? authorization[0] : authorization
  if (!value?.startsWith("Bearer ")) throw new Error("GENIO_ONE_SESSION_TOKEN_REQUIRED")
  const accessToken = value.slice("Bearer ".length).trim()
  if (!accessToken) throw new Error("GENIO_ONE_SESSION_TOKEN_REQUIRED")
  return accessToken
}

export async function requestPrincipal(request: { headers: Record<string, string | string[] | undefined> }): Promise<GenioPrincipal> {
  return verifyGenioOneAccessToken(requestAccessToken(request))
}

export function extractBearerOrQueryToken(request: { headers: Record<string, string | string[] | undefined>; query?: unknown }): string | null {
  const authorization = request.headers.authorization
  const value = Array.isArray(authorization) ? authorization[0] : authorization
  if (value?.startsWith("Bearer ")) {
    const token = value.slice("Bearer ".length).trim()
    if (token) return token
  }
  if (request.query && typeof request.query === "object") {
    const queryToken = (request.query as Record<string, unknown>).token
    if (typeof queryToken === "string" && queryToken.trim()) return queryToken.trim()
  }
  return null
}

export function e2bProxySession(runtimeBroker: RuntimeBroker, runtimeSessionId: string, tier?: RuntimeTier) {
  const session = runtimeBroker.get(runtimeSessionId)
  const details = tier ? session?.runtimeDetails[tier] : session?.details
  if (!details?.sandboxId || details.kind !== "e2b-self-hosted") return null
  const configured = process.env.E2B_SANDBOX_URL?.trim()
  if (!configured) return null
  const sandboxUrl = new URL(configured)
  if (sandboxUrl.protocol !== "http:" && sandboxUrl.protocol !== "https:") return null
  return { sandboxId: details.sandboxId, sandboxUrl }
}

export async function authenticateProxySession(
  runtimeBroker: RuntimeBroker,
  runtimeSessionId: string,
  tier: RuntimeTier | undefined,
  request: { headers: Record<string, string | string[] | undefined>; query?: unknown },
) {
  const session = runtimeBroker.get(runtimeSessionId)
  if (!session) return null
  const token = extractBearerOrQueryToken(request)
  if (!token) return null
  try {
    const principal = await verifyGenioOneAccessToken(token)
    if (principal.tenant_id !== session.principal.tenant_id || principal.subject_id !== session.principal.subject_id) {
      return null
    }
  } catch {
    return null
  }
  return e2bProxySession(runtimeBroker, runtimeSessionId, tier)
}
