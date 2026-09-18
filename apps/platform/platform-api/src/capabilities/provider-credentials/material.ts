import { PlatformApiError } from "../errors"
import type { ProviderCredentialStrategy } from "./contract"

export function validateCredentialMaterial(value: string, strategy: ProviderCredentialStrategy): string {
  if (strategy.kind !== "RUNTIME_IDENTITY") throw new PlatformApiError("PROVIDER_CREDENTIAL_MATERIAL_STRATEGY_UNSUPPORTED", 422)
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(value) } catch { throw new PlatformApiError("PROVIDER_CREDENTIAL_MATERIAL_INVALID", 422) }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PlatformApiError("PROVIDER_CREDENTIAL_MATERIAL_INVALID", 422)
  const fields = parsed.type === "authorized_user" ? ["client_id", "client_secret", "refresh_token"] : parsed.type === "service_account" ? ["client_email", "private_key", "token_uri"] : null
  if (!fields || fields.some((name) => typeof parsed[name] !== "string" || !(parsed[name] as string).trim())) throw new PlatformApiError("PROVIDER_CREDENTIAL_MATERIAL_INVALID", 422)
  if ((parsed.token_uri && parsed.token_uri !== "https://oauth2.googleapis.com/token" && parsed.token_uri !== "https://accounts.google.com/o/oauth2/token") || (parsed.universe_domain && parsed.universe_domain !== "googleapis.com") || parsed.credential_source) throw new PlatformApiError("PROVIDER_CREDENTIAL_MATERIAL_ENDPOINT_REJECTED", 422)
  return JSON.stringify(parsed)
}
