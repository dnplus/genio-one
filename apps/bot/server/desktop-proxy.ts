import { randomBytes } from "node:crypto"

import type { ManagedDesktop } from "./runtime"
import type { RuntimeBroker, RuntimeSession } from "./runtime-broker"

export const DESKTOP_BROWSER_GRANT_QUERY = "desktop_grant"
export const DESKTOP_BROWSER_COOKIE = "genio_desktop_grant"
const DESKTOP_BROWSER_GRANT_TTL_MS = 60_000

type DesktopLease = ManagedDesktop

type DesktopBrowserGrant = {
  runtimeSessionId: string
  lease: DesktopLease
  expiresAt: number
}

export type DesktopProxySession = {
  target: { url: URL; headers: Record<string, string> }
  websocketTarget: { url: URL; headers: Record<string, string> }
  grantExpiresAt: number
  bootstrap: boolean
}

function currentDesktopLease(session: RuntimeSession | null | undefined): DesktopLease | null {
  const lease = session?.leases.desktop
  if (!lease || !lease.details.execReady || lease.details.tier !== "desktop" || !lease.proxy?.desktop) return null
  return lease
}

function currentDesktopProxySession(session: RuntimeSession | null | undefined, lease: DesktopLease): Omit<DesktopProxySession, "grantExpiresAt" | "bootstrap"> | null {
  if (session?.leases.desktop !== lease || !lease.details.execReady || !lease.proxy?.desktop) return null
  try {
    const url = new URL(lease.proxy.desktop.url)
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/")) return null
    const websocket = lease.proxy.desktopWebSocket ?? lease.proxy.desktop
    const websocketUrl = new URL(websocket.url)
    if ((websocketUrl.protocol !== "http:" && websocketUrl.protocol !== "https:") || websocketUrl.username || websocketUrl.password || websocketUrl.search || websocketUrl.hash) return null
    return { target: { url, headers: lease.proxy.desktop.headers }, websocketTarget: { url: websocketUrl, headers: websocket.headers } }
  } catch {
    return null
  }
}

export class DesktopBrowserGrants {
  private readonly grants = new Map<string, DesktopBrowserGrant>()

  constructor(
    private readonly ttlMs = DESKTOP_BROWSER_GRANT_TTL_MS,
    private readonly now = () => Date.now(),
  ) {}

  issue(runtimeBroker: RuntimeBroker, runtimeSessionId: string): string | null {
    this.prune()
    const session = runtimeBroker.get(runtimeSessionId)
    const lease = currentDesktopLease(session)
    if (!lease) return null
    const credential = randomBytes(32).toString("base64url")
    this.grants.set(credential, { runtimeSessionId, lease, expiresAt: this.now() + this.ttlMs })
    return credential
  }

  validate(runtimeBroker: RuntimeBroker, runtimeSessionId: string, credential: string): Omit<DesktopProxySession, "bootstrap"> | null {
    this.prune()
    const grant = this.grants.get(credential)
    if (!grant || grant.runtimeSessionId !== runtimeSessionId) return null
    const session = runtimeBroker.get(runtimeSessionId)
    if (currentDesktopLease(session) !== grant.lease) return null
    const proxySession = currentDesktopProxySession(session, grant.lease)
    if (!proxySession) return null
    return { ...proxySession, grantExpiresAt: grant.expiresAt }
  }

  private prune() {
    const now = this.now()
    for (const [credential, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(credential)
    }
  }
}

export const desktopBrowserGrants = new DesktopBrowserGrants()

function validDesktopGrant(credential: string) {
  return /^[A-Za-z0-9_-]{32,128}$/.test(credential)
}

function allowedVncOptions(upstream: URL): URLSearchParams | null {
  if ((upstream.protocol !== "http:" && upstream.protocol !== "https:") || upstream.username || upstream.password || !upstream.pathname.endsWith("/vnc.html") || upstream.hash) return null
  const query = new URLSearchParams()
  for (const [key, value] of upstream.searchParams) {
    if (query.has(key)) return null
    if (key === "autoconnect" && (value === "true" || value === "false")) query.set(key, value)
    else if (key === "view_only" && (value === "true" || value === "false")) query.set(key, value)
    else if (key === "resize" && (value === "off" || value === "scale" || value === "remote")) query.set(key, value)
    else if (key === "password" && value.length > 0 && value.length <= 512) query.set(key, value)
    else return null
  }
  return query
}

export function proxiedDesktopUrl(runtimeSessionId: string, upstreamDesktopUrl: string | null, credential: string | null) {
  if (!upstreamDesktopUrl || !credential || !validDesktopGrant(credential)) return null
  try {
    const upstream = new URL(upstreamDesktopUrl)
    const query = allowedVncOptions(upstream)
    if (!query) return null
    const session = encodeURIComponent(runtimeSessionId)
    query.set("path", `/api/desktop/${session}/websockify`)
    return `/api/desktop/${session}/vnc.html?${DESKTOP_BROWSER_GRANT_QUERY}=${encodeURIComponent(credential)}#${query}`
  } catch {
    return null
  }
}

export function desktopCookiePath(runtimeSessionId: string) {
  return `/api/desktop/${encodeURIComponent(runtimeSessionId)}/`
}

export function desktopBrowserCookie(runtimeSessionId: string, credential: string, expiresAt: number, now = Date.now()) {
  const seconds = Math.max(1, Math.ceil((expiresAt - now) / 1000))
  return `${DESKTOP_BROWSER_COOKIE}=${credential}; Path=${desktopCookiePath(runtimeSessionId)}; Max-Age=${seconds}; HttpOnly; SameSite=Strict`
}

export function readDesktopBrowserCookie(header: string | string[] | undefined) {
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return null
  for (const item of value.split(";")) {
    const [name, ...parts] = item.trim().split("=")
    if (name === DESKTOP_BROWSER_COOKIE) {
      const credential = parts.join("=")
      return validDesktopGrant(credential) ? credential : null
    }
  }
  return null
}

export function appendDesktopLocationCleanup(body: Uint8Array) {
  const html = Buffer.from(body).toString("utf8")
  const script = `<script>addEventListener("load",()=>{history.replaceState(null,"",location.pathname+location.hash)},{once:true})</script>`
  return Buffer.from(html.includes("</body>") ? html.replace("</body>", `${script}</body>`) : `${html}${script}`)
}
