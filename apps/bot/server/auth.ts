import type { GenioPrincipal, RuntimeBroker } from "./runtime-broker"
import type { RuntimeTier } from "./runtime"
import { desktopBrowserGrants, DESKTOP_BROWSER_GRANT_QUERY, readDesktopBrowserCookie, type DesktopProxySession } from "./desktop-proxy"

export async function verifyGenioOneAccessToken(accessToken: string, signal?: AbortSignal): Promise<GenioPrincipal> {
  if (signal?.aborted) throw signal.reason
  const origin = process.env.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
  const response = await fetch(new URL("/v1/identity/session", origin), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    ...(signal ? { signal } : {}),
  })
  if (signal?.aborted) throw signal.reason
  if (!response.ok) throw Object.assign(new Error("GENIO_ONE_SESSION_REJECTED"), { status: response.status })
  const principal = await response.json() as Partial<GenioPrincipal>
  if (signal?.aborted) throw signal.reason
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

export function executorProxySession(runtimeBroker: RuntimeBroker, runtimeSessionId: string, tier?: RuntimeTier) {
  const session = runtimeBroker.get(runtimeSessionId)
  const lease = tier === "headless" || tier === "desktop" ? session?.leases[tier] : session?.desktop
  if (!lease || !lease.details.execReady || !lease.proxy?.executor) return null
  return lease.proxy.executor
}

export async function authenticateExecutorProxySession(
  runtimeBroker: RuntimeBroker,
  runtimeSessionId: string,
  tier: RuntimeTier | undefined,
  request: { headers: Record<string, string | string[] | undefined> },
) {
  const session = runtimeBroker.get(runtimeSessionId)
  if (!session) return null
  let token: string
  try {
    token = requestAccessToken(request)
  } catch {
    return null
  }
  try {
    const principal = await verifyGenioOneAccessToken(token)
    if (principal.tenant_id !== session.principal.tenant_id || principal.subject_id !== session.principal.subject_id || principal.acting_client_id !== session.principal.acting_client_id) {
      return null
    }
  } catch {
    return null
  }
  return executorProxySession(runtimeBroker, runtimeSessionId, tier)
}

function desktopGrantFromQuery(request: { query?: unknown }) {
  if (!request.query || typeof request.query !== "object") return null
  const value = (request.query as Record<string, unknown>)[DESKTOP_BROWSER_GRANT_QUERY]
  return typeof value === "string" ? value : null
}

export function authenticateDesktopProxySession(
  runtimeBroker: RuntimeBroker,
  runtimeSessionId: string,
  request: { headers: Record<string, string | string[] | undefined>; query?: unknown },
  allowBootstrap: boolean,
): DesktopProxySession | null {
  const queryCredential = allowBootstrap ? desktopGrantFromQuery(request) : null
  if (queryCredential) {
    const querySession = desktopBrowserGrants.validate(runtimeBroker, runtimeSessionId, queryCredential)
    if (querySession) return { ...querySession, bootstrap: true }
  }
  const cookieCredential = readDesktopBrowserCookie(request.headers.cookie)
  if (!cookieCredential) return null
  const session = desktopBrowserGrants.validate(runtimeBroker, runtimeSessionId, cookieCredential)
  return session ? { ...session, bootstrap: false } : null
}
