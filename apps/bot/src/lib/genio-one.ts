export interface GenioIdentity {
  tenant_id: string
  subject_id: string
  display_name?: string
  email?: string
  acting_client_id: string
  role: string
  organization_ids: string[]
  scopes: string[]
}

export interface GenioCatalogCapability {
  resource_id: string
  resource_display_name: string
  capability_id: string
  capability_display_name: string
  access: "ENTITLED" | "AUTO_GRANT" | "REQUEST"
  hub_status: "CONNECTED" | "AVAILABLE" | "REQUEST_ACCESS" | "PENDING_APPROVAL"
  connection_status: string
  resource_kind?: string
  builtin_service?: "DISCOVERY"
  extension_metadata?: Record<string, unknown> | null
}

export interface GenioCatalog {
  tenant_id: string
  catalog_revision: string
  subject_id: string
  subject_display_name: string
  capabilities: GenioCatalogCapability[]
}

export function isUsableEnterpriseCapability(capability: GenioCatalogCapability): boolean {
  return capability.connection_status === "READY" &&
    (capability.access === "ENTITLED" || capability.access === "AUTO_GRANT") &&
    (capability.hub_status === "CONNECTED" || capability.hub_status === "AVAILABLE")
}

export function isMcpToolCapability(capability: GenioCatalogCapability): boolean {
  return capability.capability_id.startsWith("mcp-tool-")
}

interface BrowserConfiguration {
  authorization_endpoint: string
  token_endpoint: string
  /** Self-service scopes — must NOT be paired with the bot OIDC client. */
  scopes: string[]
  client_id?: string
  management_client_id?: string
  management_scopes?: string[]
}

/** Bot client authorize scopes: invocation + management (subject registration). */
export const BOT_OIDC_DEFAULT_SCOPES = ["openid", "genioone-invocation", "genioone-management"] as const

const tokenKey = "genioone.bot.access_token"
const refreshKey = "genioone.bot.refresh_token"
const verifierKey = "genioone.bot.pkce.verifier"
const stateKey = "genioone.bot.pkce.state"
const returnToKey = "genioone.bot.pkce.return_to"

function clientId() {
  return import.meta.env.VITE_GENIO_ONE_BOT_OIDC_CLIENT_ID || "genio-one-bot"
}

/**
 * Resolve scopes for the bot OIDC client.
 * Never reuse self-service `browser-configuration.scopes` with `genio-one-bot`.
 */
export function resolveBotOidcScopes(config?: Pick<BrowserConfiguration, "management_scopes">): string[] {
  const fromEnv = (import.meta.env.VITE_GENIO_ONE_BOT_OIDC_SCOPES as string | undefined)?.trim()
  if (fromEnv) {
    return fromEnv.split(/\s+/).filter(Boolean)
  }
  // Pair genio-one-bot with invocation + management. Do not use self-service `scopes`.
  const rawManagement = config?.management_scopes
  const management = Array.isArray(rawManagement)
    ? rawManagement.filter((scope) => typeof scope === "string" && scope.trim())
    : []
  const merged = new Set<string>(["openid", "genioone-invocation", ...management])
  merged.add("genioone-management")
  return [...merged]
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

function randomValue(length: number) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

async function configuration() {
  const response = await fetch("/v1/identity/browser-configuration")
  if (!response.ok) throw new Error("GENIO_ONE_IDENTITY_UNAVAILABLE")
  return response.json() as Promise<BrowserConfiguration>
}

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null
  const match = document.cookie.match(new RegExp(`(^|;\\s*)(${name})=([^;]*)`))
  return match ? decodeURIComponent(match[3]!) : null
}

function removeCookie(name: string) {
  if (typeof document === "undefined") return
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`
}

function localReturnPath(value: string | null) {
  const fallback = location.pathname
  if (!value?.startsWith("/") || value.startsWith("//")) return fallback
  try {
    const target = new URL(value, location.origin)
    if (target.origin !== location.origin) return fallback
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return fallback
  }
}

export function loadGenioToken(): string {
  const token = typeof localStorage !== "undefined" ? localStorage.getItem(tokenKey)?.trim() : ""
  if (token) return token
  // Migration fallback: check legacy sessionStorage or cookie, migrate to localStorage and clean up
  const fallback = (typeof sessionStorage !== "undefined" ? sessionStorage.getItem(tokenKey)?.trim() : null) || getCookie(tokenKey) || ""
  if (fallback && typeof localStorage !== "undefined") {
    localStorage.setItem(tokenKey, fallback)
    try { sessionStorage.removeItem(tokenKey) } catch {}
    removeCookie(tokenKey)
  }
  return fallback
}

export function loadGenioRefreshToken(): string {
  const refresh = typeof localStorage !== "undefined" ? localStorage.getItem(refreshKey)?.trim() : ""
  if (refresh) return refresh
  // Migration fallback: check legacy sessionStorage or cookie, migrate to localStorage and clean up
  const fallback = (typeof sessionStorage !== "undefined" ? sessionStorage.getItem(refreshKey)?.trim() : null) || getCookie(refreshKey) || ""
  if (fallback && typeof localStorage !== "undefined") {
    localStorage.setItem(refreshKey, fallback)
    try { sessionStorage.removeItem(refreshKey) } catch {}
    removeCookie(refreshKey)
  }
  return fallback
}

export function storeGenioTokens(accessToken: string, refreshToken?: string) {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(tokenKey, accessToken)
  }
  // Clean up legacy cookies and sessionStorage
  removeCookie(tokenKey)
  try { sessionStorage.removeItem(tokenKey) } catch {}
  if (refreshToken) {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(refreshKey, refreshToken)
    }
    removeCookie(refreshKey)
    try { sessionStorage.removeItem(refreshKey) } catch {}
  }
}

export function clearGenioTokens() {
  removeCookie(tokenKey)
  removeCookie(refreshKey)
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(tokenKey)
    localStorage.removeItem(refreshKey)
  }
  try {
    sessionStorage.removeItem(tokenKey)
    sessionStorage.removeItem(refreshKey)
  } catch {}
}

export async function refreshGenioLogin() {
  const refreshToken = loadGenioRefreshToken()
  if (!refreshToken) return ""
  const config = await configuration()
  const response = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId(),
      refresh_token: refreshToken,
    }),
  })
  const tokens = await response.json() as { access_token?: string; refresh_token?: string }
  if (!response.ok || !tokens.access_token) {
    clearGenioTokens()
    return ""
  }
  storeGenioTokens(tokens.access_token, tokens.refresh_token)
  return tokens.access_token
}

export async function beginGenioLogin(options: { forceReauthentication?: boolean } = {}) {
  const config = await configuration()
  const verifier = randomValue(48)
  const state = randomValue(24)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  sessionStorage.setItem(verifierKey, verifier)
  sessionStorage.setItem(stateKey, state)
  sessionStorage.setItem(returnToKey, `${location.pathname}${location.search}${location.hash}`)
  const authorization = new URL(config.authorization_endpoint)
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId(),
    redirect_uri: location.origin,
    scope: resolveBotOidcScopes(config).join(" "),
    state,
    code_challenge: base64Url(new Uint8Array(digest)),
    code_challenge_method: "S256",
    ...(options.forceReauthentication ? { prompt: "login", max_age: "0" } : {}),
  }).toString()
  location.assign(authorization)
}

export async function completeGenioLogin() {
  const query = new URLSearchParams(location.search)
  const code = query.get("code")
  if (!code) return loadGenioToken()
  const verifier = sessionStorage.getItem(verifierKey)
  const state = sessionStorage.getItem(stateKey)
  if (!verifier || !state || query.get("state") !== state) throw new Error("GENIO_ONE_OIDC_STATE_INVALID")
  const config = await configuration()
  const response = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId(),
      code,
      redirect_uri: location.origin,
      code_verifier: verifier,
    }),
  })
  const tokens = await response.json() as { access_token?: string; refresh_token?: string }
  if (!response.ok || !tokens.access_token) throw new Error("GENIO_ONE_OIDC_EXCHANGE_FAILED")
  storeGenioTokens(tokens.access_token, tokens.refresh_token)
  const returnTo = localReturnPath(sessionStorage.getItem(returnToKey))
  sessionStorage.removeItem(verifierKey)
  sessionStorage.removeItem(stateKey)
  sessionStorage.removeItem(returnToKey)
  history.replaceState({}, "", returnTo)
  return tokens.access_token
}

async function request<T>(token: string, path: string) {
  const response = await fetch(path, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`GENIO_ONE_REQUEST_FAILED_${response.status}`)
  return response.json() as Promise<T>
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".")
    if (parts.length < 2) return null
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=")
    const json = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join(""),
    )
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

export function isJwtExpired(token: string, bufferSeconds = 30): boolean {
  const payload = decodeJwtPayload(token)
  if (!payload || typeof payload.exp !== "number") return false
  return Date.now() / 1000 >= payload.exp - bufferSeconds
}


export async function loadGenioContext(token: string) {
  const identity = await request<GenioIdentity>(token, "/v1/identity/session")
  const payload = decodeJwtPayload(token)
  if (payload) {
    if (!identity.display_name && typeof payload.name === "string" && payload.name.trim()) {
      identity.display_name = payload.name.trim()
    } else if (!identity.display_name && typeof payload.preferred_username === "string" && payload.preferred_username.trim()) {
      identity.display_name = payload.preferred_username.trim()
    }
    if (!identity.email && typeof payload.email === "string" && payload.email.trim()) {
      identity.email = payload.email.trim()
    }
  }
  const catalog = await request<GenioCatalog>(
    token,
    `/v1/tenants/${encodeURIComponent(identity.tenant_id)}/catalog`,
  )
  return { identity, catalog }
}
