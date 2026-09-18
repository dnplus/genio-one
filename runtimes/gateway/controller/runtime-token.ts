import { readFile } from "node:fs/promises"
import type { HttpFetch } from "../services/shared/http-fetch"

export interface RuntimeTokenSource {
  headers(): Promise<Record<string, string>>
}

export interface RuntimeTokenSourceOptions {
  staticToken?: string
  tokenEndpoint?: string
  clientIdFile?: string
  clientSecretFile?: string
  scope?: string
  fetch?: HttpFetch
  now?: () => number
}

interface CachedToken {
  value: string
  refreshAt: number
}

function trimmed(value: string, label: string): string {
  const result = value.trim()
  if (!result) throw new Error(`${label} is empty`)
  return result
}

export function createRuntimeTokenSource(options: RuntimeTokenSourceOptions): RuntimeTokenSource {
  if (options.staticToken?.trim()) {
    const token = options.staticToken.trim()
    return { async headers() { return { authorization: `Bearer ${token}` } } }
  }
  if (!options.tokenEndpoint || !options.clientIdFile || !options.clientSecretFile) {
    throw new Error(
      "Gateway Runtime requires a static token or OIDC token endpoint and client credential files",
    )
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const now = options.now ?? (() => Date.now())
  let cached: CachedToken | undefined
  let pending: Promise<CachedToken> | undefined

  async function refresh(): Promise<CachedToken> {
    const [clientIdText, clientSecretText] = await Promise.all([
      readFile(options.clientIdFile!, "utf8"),
      readFile(options.clientSecretFile!, "utf8"),
    ])
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: trimmed(clientIdText, "Gateway Runtime OIDC client id"),
      client_secret: trimmed(clientSecretText, "Gateway Runtime OIDC client secret"),
      ...(options.scope?.trim() ? { scope: options.scope.trim() } : {}),
    })
    const response = await fetchImplementation(options.tokenEndpoint!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`Gateway Runtime OIDC token request failed (${response.status})`)
    }
    const payload = await response.json() as Record<string, unknown>
    const value = typeof payload.access_token === "string" ? payload.access_token.trim() : ""
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 60
    if (!value || !Number.isFinite(expiresIn) || expiresIn < 1) {
      throw new Error("Gateway Runtime OIDC token response is invalid")
    }
    return {
      value,
      refreshAt: now() + Math.max(1, expiresIn - 30) * 1_000,
    }
  }

  return {
    async headers() {
      if (!cached || now() >= cached.refreshAt) {
        pending ??= refresh().finally(() => { pending = undefined })
        cached = await pending
      }
      return { authorization: `Bearer ${cached.value}` }
    },
  }
}
