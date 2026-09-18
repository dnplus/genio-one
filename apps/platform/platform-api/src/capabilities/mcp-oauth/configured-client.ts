import { createHash, randomBytes } from "node:crypto"
import type { DownstreamIdentityProjection } from "../connections/contract"
import { PlatformApiError } from "../errors"

export type ConfiguredOAuthClient = NonNullable<DownstreamIdentityProjection["oauth_client"]>

export function configuredAuthorization(client: ConfiguredOAuthClient, state: string, redirectUri: string) {
  const verifier = randomBytes(32).toString("base64url")
  const url = new URL(client.authorization_endpoint)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...(client.scopes.length ? { scope: client.scopes.join(" ") } : {}),
  }).toString()
  return { url: url.toString(), verifier }
}

export async function exchangeConfiguredCode(input: {
  client: ConfiguredOAuthClient
  code: string
  verifier: string
  redirectUri: string
  request?: (url: string, init: RequestInit) => Promise<Response>
}) {
  const response = await (input.request ?? fetch)(input.client.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: input.client.client_id, code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new PlatformApiError("MCP_OAUTH_TOKEN_EXCHANGE_FAILED", 422)
  const body = await response.json() as Record<string, unknown>
  if (typeof body.access_token !== "string" || !body.access_token || /[\s\u0000-\u001f]/.test(body.access_token) || String(body.token_type).toLowerCase() !== "bearer") {
    throw new PlatformApiError("MCP_OAUTH_TOKEN_EXCHANGE_FAILED", 422)
  }
  const expiry = body.expires_in === undefined ? undefined : Number(body.expires_in)
  if (expiry !== undefined && (!Number.isFinite(expiry) || expiry <= 0)) throw new PlatformApiError("MCP_OAUTH_TOKEN_EXCHANGE_FAILED", 422)
  return {
    access_token: body.access_token,
    token_type: "Bearer",
    ...(typeof body.refresh_token === "string" && body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    ...(expiry !== undefined ? { expires_in: expiry } : {}),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
    issuer: input.client.issuer,
  }
}
