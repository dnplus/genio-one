export const ROUTE_LEASE_ID_HEADER = "x-genio-route-lease-id"
export const ROUTE_LEASE_REUSED_HEADER = "x-genio-route-lease-reused"
export const ROUTE_CONNECTION_ID_HEADER = "x-genio-route-connection-id"
export const ROUTE_PROVIDER_MODEL_HEADER = "x-genio-route-provider-model"
export const ROUTE_PROVIDER_CREDENTIAL_PROFILE_ID_HEADER = "x-genio-route-provider-credential-profile-id"
export const ROUTE_PROVIDER_CREDENTIAL_PROFILE_REVISION_HEADER = "x-genio-route-provider-credential-profile-revision"
export const ROUTE_PROVIDER_CREDENTIAL_STRATEGY_DIGEST_HEADER = "x-genio-route-provider-credential-strategy-digest"
/** Trusted public alias selected by the processor before native AIGW routing. */
export const ROUTE_PUBLIC_MODEL_HEADER = "x-genio-route-public-model"

export const MODEL_ROUTE_HANDOFF_HEADERS = [
  ROUTE_LEASE_ID_HEADER,
  ROUTE_LEASE_REUSED_HEADER,
  ROUTE_CONNECTION_ID_HEADER,
  ROUTE_PROVIDER_MODEL_HEADER,
  ROUTE_PROVIDER_CREDENTIAL_PROFILE_ID_HEADER,
  ROUTE_PROVIDER_CREDENTIAL_PROFILE_REVISION_HEADER,
  ROUTE_PROVIDER_CREDENTIAL_STRATEGY_DIGEST_HEADER,
] as const
