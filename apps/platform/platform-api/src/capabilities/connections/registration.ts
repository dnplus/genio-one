import { PlatformApiError } from "../errors"
import {
  canonicalizeApiRequestMapping,
  canonicalizeDownstreamIdentity,
  type ApiUpstreamRequestMapping,
  type ConnectionKind,
  type CreateConnectionInput,
  type DownstreamIdentityProjection,
  type ProviderType,
} from "./contract"

export interface CanonicalConnectionRegistrationInput {
  connectionKind: ConnectionKind
  providerType: ProviderType | null
  downstreamIdentity: DownstreamIdentityProjection
  endpoint: string
  requestMapping: ApiUpstreamRequestMapping | null
}

export function normalizeConnectionEndpoint(value: string): string {
  let endpoint: URL
  try {
    endpoint = new URL(value.trim())
  } catch {
    throw new PlatformApiError(
      "CONNECTION_ENDPOINT_INVALID",
      422,
      "A Connection endpoint must be an absolute HTTP or HTTPS URL",
    )
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new PlatformApiError(
      "CONNECTION_ENDPOINT_PROTOCOL_UNSUPPORTED",
      422,
      "A Connection endpoint must use HTTP or HTTPS",
    )
  }
  if (endpoint.username || endpoint.password) {
    throw new PlatformApiError(
      "CONNECTION_ENDPOINT_CREDENTIALS_FORBIDDEN",
      422,
      "Provider credentials must use credential_ref and cannot be embedded in the endpoint",
    )
  }
  if (endpoint.search || endpoint.hash) {
    throw new PlatformApiError(
      "CONNECTION_ENDPOINT_SUFFIX_FORBIDDEN",
      422,
      "A Connection endpoint cannot contain query parameters or a fragment",
    )
  }
  return endpoint.toString().replace(/\/$/, "")
}

export function canonicalizeConnectionRegistrationInput(
  value: CreateConnectionInput,
): CanonicalConnectionRegistrationInput {
  const connectionKind = value.connection_kind ?? "LLM"
  const providerType = value.provider_type ?? null
  const hasProviderCredentialProfile = value.provider_credential_profile !== undefined
  const downstreamIdentity = canonicalizeDownstreamIdentity(
    value.downstream_identity ?? (hasProviderCredentialProfile
      ? { mode: "SERVICE", authentication: "PROVIDER_CREDENTIAL_PROFILE" }
      : { mode: "NONE" }),
  )
  if (!downstreamIdentity) {
    throw new PlatformApiError("MCP_IDENTITY_CONFIGURATION_INVALID", 422)
  }
  if (connectionKind === "MCP" && (providerType || value.provider_profile_id)) {
    throw new PlatformApiError(
      "MCP_PROVIDER_CONFIGURATION_INVALID",
      422,
      "MCP Connections do not use an LLM Provider Profile",
    )
  }
  if (connectionKind === "MCP" && downstreamIdentity.mode === "SERVICE" && !value.credential_ref) {
    if (!hasProviderCredentialProfile) {
      throw new PlatformApiError("MCP_SERVICE_CREDENTIAL_REQUIRED", 422)
    }
  }
  if (
    connectionKind === "MCP" &&
    downstreamIdentity.mode === "SERVICE" &&
    downstreamIdentity.authentication !== "API_KEY" &&
    downstreamIdentity.authentication !== "PROVIDER_CREDENTIAL_PROFILE"
  ) {
    throw new PlatformApiError("MCP_SERVICE_AUTHENTICATION_REQUIRED", 422)
  }
  if (
    connectionKind === "MCP" &&
    downstreamIdentity.mode === "NONE" &&
    downstreamIdentity.authentication
  ) {
    throw new PlatformApiError("MCP_IDENTITY_CONFIGURATION_INVALID", 422)
  }
  if (connectionKind === "MCP" && downstreamIdentity.mode === "NONE" && value.credential_ref) {
    throw new PlatformApiError("MCP_CREDENTIAL_WITHOUT_IDENTITY", 422)
  }
  if (
    connectionKind === "MCP" &&
    downstreamIdentity.mode === "USER_PASSTHROUGH" &&
    value.credential_ref
  ) {
    throw new PlatformApiError("MCP_PASSTHROUGH_CREDENTIAL_REFERENCE_FORBIDDEN", 422)
  }
  if (
    connectionKind === "MCP" &&
    (downstreamIdentity.mode === "USER_OAUTH" || downstreamIdentity.mode === "USER_PASSWORD") &&
    value.credential_ref
  ) {
    throw new PlatformApiError("MCP_OAUTH_CREDENTIAL_REFERENCE_FORBIDDEN", 422)
  }
  if (
    connectionKind === "LLM" &&
    downstreamIdentity.mode !== "NONE" &&
    !(
      downstreamIdentity.mode === "SERVICE" &&
      downstreamIdentity.authentication === "PROVIDER_CREDENTIAL_PROFILE"
    )
  ) {
    throw new PlatformApiError("LLM_DOWNSTREAM_IDENTITY_UNSUPPORTED", 422)
  }
  if (
    connectionKind === "API" &&
    downstreamIdentity.mode !== "NONE" &&
    !(
      downstreamIdentity.mode === "SERVICE" &&
      downstreamIdentity.authentication === "PROVIDER_CREDENTIAL_PROFILE"
    )
  ) {
    throw new PlatformApiError("API_DOWNSTREAM_IDENTITY_UNSUPPORTED", 422)
  }
  if (
    hasProviderCredentialProfile &&
    (
      downstreamIdentity.mode !== "SERVICE" ||
      downstreamIdentity.authentication !== "PROVIDER_CREDENTIAL_PROFILE"
    )
  ) {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_IDENTITY_REQUIRED", 422)
  }
  if (
    downstreamIdentity.mode === "SERVICE" &&
    downstreamIdentity.authentication === "PROVIDER_CREDENTIAL_PROFILE" &&
    !hasProviderCredentialProfile
  ) {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_BINDING_REQUIRED", 422)
  }
  if (hasProviderCredentialProfile && value.credential_ref) {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_CREDENTIAL_REFERENCE_FORBIDDEN", 422)
  }
  if (connectionKind === "LLM" && !providerType) {
    throw new PlatformApiError("PROVIDER_TYPE_REQUIRED", 422)
  }
  if (
    connectionKind === "LLM" &&
    providerType === "GCP_VERTEX_AI" &&
    !(
      downstreamIdentity.mode === "SERVICE" &&
          downstreamIdentity.authentication === "PROVIDER_CREDENTIAL_PROFILE"
    )
  ) {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_REQUIRED", 422)
  }
  if (connectionKind === "API" && (providerType || value.provider_profile_id)) {
    throw new PlatformApiError("API_PROVIDER_CONFIGURATION_INVALID", 422)
  }
  if (connectionKind === "API" && value.credential_ref) {
    throw new PlatformApiError("API_CREDENTIAL_PROJECTION_UNSUPPORTED", 422)
  }
  return {
    connectionKind,
    providerType,
    downstreamIdentity,
    endpoint: normalizeConnectionEndpoint(value.endpoint),
    requestMapping: connectionKind === "API"
      ? canonicalizeApiRequestMapping(value.request_mapping)
      : null,
  }
}
