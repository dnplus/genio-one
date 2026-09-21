import type { BrowserOidcConfiguration, IdentitySession } from "@/domain/contracts"

class BrowserOidcError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

const verifierKey = (redirectPath: string) => `genioone.pkce.verifier:${redirectPath}`
const stateKey = (redirectPath: string) => `genioone.pkce.state:${redirectPath}`
const refreshTokenKey = (redirectPath: string) => `genioone.oidc.refresh_token:${redirectPath}`

export const BROWSER_SESSION_REFRESHED_EVENT = "genioone:browser-session-refreshed"
export const BROWSER_SESSION_EXPIRED_EVENT = "genioone:browser-session-expired"

const refreshes = new Map<string, Promise<string | null>>()
const completions = new Map<string, Promise<string | null>>()

function accessTokenKey(redirectPath: string) {
  return redirectPath === "/management"
    ? "genioone.management_token"
    : "genioone.self_service_token"
}

function clientId(
  configuration: BrowserOidcConfiguration,
  management: boolean,
) {
  return management
    ? configuration.management_client_id ?? ""
    : configuration.client_id
}

function persistTokens(
  redirectPath: string,
  tokens: { access_token: string; refresh_token?: string },
) {
  sessionStorage.setItem(accessTokenKey(redirectPath), tokens.access_token)
  if (tokens.refresh_token) {
    sessionStorage.setItem(refreshTokenKey(redirectPath), tokens.refresh_token)
  }
}

export function loadBrowserAccessToken(redirectPath: string) {
  return sessionStorage.getItem(accessTokenKey(redirectPath))?.trim() ?? ""
}

export function clearBrowserSession(redirectPath: string) {
  sessionStorage.removeItem(accessTokenKey(redirectPath))
  sessionStorage.removeItem(refreshTokenKey(redirectPath))
  sessionStorage.removeItem(verifierKey(redirectPath))
  sessionStorage.removeItem(stateKey(redirectPath))
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

function sha256Fallback(ascii: string): Uint8Array {
  const mathPow = Math.pow
  const maxWord = mathPow(2, 32)
  const lengthProperty = "length"
  let i = 0
  let j = 0
  const words: number[] = []
  const asciiBitLength = ascii[lengthProperty] * 8
  let hash: number[] = []
  const k: number[] = []
  let primeCounter = 0

  const isPrime = (candidate: number) => {
    for (let factor = 2, max = Math.sqrt(candidate); factor <= max; factor++) {
      if (candidate % factor === 0) return false
    }
    return true
  }

  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (isPrime(candidate)) {
      if (primeCounter < 8) hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0
      k[primeCounter] = (mathPow(candidate, 1 / 3) * maxWord) | 0
      primeCounter++
    }
  }

  let formatted = ascii + "\x80"
  while ((formatted[lengthProperty] % 64) - 56) formatted += "\x00"
  for (i = 0; i < formatted[lengthProperty]; i++) {
    j = formatted.charCodeAt(i)
    words[i >> 2] |= j << ((3 - (i % 4)) * 8)
  }
  words[words[lengthProperty]] = (asciiBitLength / maxWord) | 0
  words[words[lengthProperty]] = asciiBitLength

  for (j = 0; j < words[lengthProperty]; ) {
    const w = words.slice(j, (j += 16))
    const oldHash = hash.slice(0)
    for (i = 0; i < 64; i++) {
      const w15 = w[i - 15]!
      const w2 = w[i - 2]!
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)
      const ch = (hash[4]! & hash[5]!) ^ (~hash[4]! & hash[6]!)
      const maj = (hash[0]! & hash[1]!) ^ (hash[0]! & hash[2]!) ^ (hash[1]! & hash[2]!)
      const temp1 = (hash[7]! + (((hash[4]! >>> 6) | (hash[4]! << 26)) ^ ((hash[4]! >>> 11) | (hash[4]! << 21)) ^ ((hash[4]! >>> 25) | (hash[4]! << 7))) + ch + k[i]! + (w[i] = (i < 16) ? w[i]! : (w[i - 16]! + s0 + w[i - 7]! + s1) | 0)) | 0
      const temp2 = ((((hash[0]! >>> 2) | (hash[0]! << 30)) ^ ((hash[0]! >>> 13) | (hash[0]! << 19)) ^ ((hash[0]! >>> 22) | (hash[0]! << 10))) + maj) | 0
      hash = [(temp1 + temp2) | 0, hash[0]!, hash[1]!, hash[2]!, (hash[3]! + temp1) | 0, hash[4]!, hash[5]!, hash[6]!]
    }
    for (i = 0; i < 8; i++) hash[i] = (hash[i]! + oldHash[i]!) | 0
  }

  const out = new Uint8Array(32)
  for (i = 0; i < 8; i++) {
    out[i * 4] = (hash[i]! >>> 24) & 0xff
    out[i * 4 + 1] = (hash[i]! >>> 16) & 0xff
    out[i * 4 + 2] = (hash[i]! >>> 8) & 0xff
    out[i * 4 + 3] = hash[i]! & 0xff
  }
  return out
}

async function sha256(data: string): Promise<Uint8Array> {
  if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data))
    return new Uint8Array(digest)
  }
  return sha256Fallback(data)
}

function randomValue(length: number) {
  const bytes = new Uint8Array(length)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes)
  } else {
    throw new Error("Cryptographically secure random number generator is unavailable.")
  }
  return base64Url(bytes)
}

function redirectUri(redirectPath: string) {
  if (location.protocol === "http:" && !["localhost", "127.0.0.1"].includes(location.hostname)) {
    return `https://${location.host}${redirectPath}`
  }
  return `${location.origin}${redirectPath}`
}

export async function loadBrowserOidcConfiguration() {
  const response = await fetch("/v1/identity/browser-configuration", {
    headers: { accept: "application/json" },
  })
  if (!response.ok) throw new BrowserOidcError("BROWSER_OIDC_UNAVAILABLE", response.status)
  return (await response.json()) as BrowserOidcConfiguration
}

export async function beginBrowserLogin(
  redirectPath: string,
  management = false,
  options: { forceReauthentication?: boolean } = {},
) {
  const configuration = await loadBrowserOidcConfiguration()
  const clientId = management
    ? configuration.management_client_id
    : configuration.client_id
  const scopes = management
    ? configuration.management_scopes
    : configuration.scopes
  if (!clientId || !scopes?.length) {
    throw new BrowserOidcError(
      management ? "MANAGEMENT_OIDC_UNAVAILABLE" : "SELF_SERVICE_OIDC_UNAVAILABLE",
    )
  }

  const verifier = randomValue(48)
  const loginState = randomValue(24)
  const digest = await sha256(verifier)
  const challenge = base64Url(digest)
  sessionStorage.setItem(verifierKey(redirectPath), verifier)
  sessionStorage.setItem(stateKey(redirectPath), loginState)

  const authorization = new URL(configuration.authorization_endpoint)
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri(redirectPath),
    scope: scopes.join(" "),
    state: loginState,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(options.forceReauthentication ? { prompt: "login", max_age: "0", acr_values: "2" } : {}),
  }).toString()
  location.assign(authorization)
}

async function exchangeBrowserLogin(redirectPath: string) {
  const query = new URLSearchParams(location.search)
  if (query.has("error")) throw new BrowserOidcError(`OIDC_${query.get("error")}`)
  const code = query.get("code")
  if (!code) return null

  const verifier = sessionStorage.getItem(verifierKey(redirectPath))
  const expectedState = sessionStorage.getItem(stateKey(redirectPath))
  if (!verifier || !expectedState || query.get("state") !== expectedState) {
    throw new BrowserOidcError("OIDC_STATE_INVALID")
  }

  const configuration = await loadBrowserOidcConfiguration()
  const response = await fetch(configuration.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: redirectPath === "/management"
        ? configuration.management_client_id ?? ""
        : configuration.client_id,
      code,
      redirect_uri: redirectUri(redirectPath),
      code_verifier: verifier,
    }),
  })
  const tokens = (await response.json().catch(() => null)) as {
    access_token?: string
    refresh_token?: string
  } | null
  sessionStorage.removeItem(verifierKey(redirectPath))
  sessionStorage.removeItem(stateKey(redirectPath))
  history.replaceState({}, "", location.pathname)
  if (!response.ok || !tokens?.access_token) {
    throw new BrowserOidcError("OIDC_CODE_EXCHANGE_FAILED", response.status)
  }
  persistTokens(redirectPath, {
    access_token: tokens.access_token,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
  })
  return tokens.access_token
}

export function completeBrowserLogin(redirectPath: string) {
  const pending = completions.get(redirectPath)
  if (pending) return pending
  const completion = exchangeBrowserLogin(redirectPath)
    .finally(() => completions.delete(redirectPath))
  completions.set(redirectPath, completion)
  return completion
}

export function refreshBrowserSession(redirectPath: string, management = false) {
  const pending = refreshes.get(redirectPath)
  if (pending) return pending

  const refresh = (async () => {
    const refreshToken = sessionStorage.getItem(refreshTokenKey(redirectPath))?.trim()
    if (!refreshToken) {
      clearBrowserSession(redirectPath)
      window.dispatchEvent(
        new CustomEvent(BROWSER_SESSION_EXPIRED_EVENT, { detail: { redirectPath } }),
      )
      return null
    }

    const configuration = await loadBrowserOidcConfiguration()
    const response = await fetch(configuration.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId(configuration, management),
        refresh_token: refreshToken,
      }),
    })
    const tokens = (await response.json().catch(() => null)) as {
      access_token?: string
      refresh_token?: string
    } | null
    if (!response.ok || !tokens?.access_token) {
      clearBrowserSession(redirectPath)
      window.dispatchEvent(
        new CustomEvent(BROWSER_SESSION_EXPIRED_EVENT, { detail: { redirectPath } }),
      )
      return null
    }

    persistTokens(redirectPath, {
      access_token: tokens.access_token,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    })
    window.dispatchEvent(
      new CustomEvent(BROWSER_SESSION_REFRESHED_EVENT, {
        detail: { redirectPath, accessToken: tokens.access_token },
      }),
    )
    return tokens.access_token
  })().finally(() => refreshes.delete(redirectPath))

  refreshes.set(redirectPath, refresh)
  return refresh
}

async function requestIdentity<T>(token: string, path: string) {
  const response = await fetch(path, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "code" in body
        ? String(body.code)
        : `PRODUCT_API_REQUEST_FAILED_${response.status}`
    throw new BrowserOidcError(message, response.status)
  }
  return body as T
}

export function loadIdentitySession(token: string) {
  return requestIdentity<IdentitySession>(token, "/v1/identity/session")
}
