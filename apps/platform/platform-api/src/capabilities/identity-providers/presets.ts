import type { IdentityProviderPreset } from "./contract"

export interface IdentityProviderPresetDefinition {
  /** The Keycloak identity provider type this preset creates. */
  providerId: "google" | "github" | "oidc"
  defaultAlias: string
  defaultDisplayName: string
  /** Scopes Keycloak requests upstream; omitted leaves the Keycloak default. */
  defaultScopes?: string
  /**
   * True when the operator must supply a discovery URL. Social providers know
   * their own endpoints; every deployment-specific provider does not.
   */
  requiresDiscoveryUrl: boolean
}

export const identityProviderPresets: Record<IdentityProviderPreset, IdentityProviderPresetDefinition> = {
  google: {
    providerId: "google",
    defaultAlias: "google",
    defaultDisplayName: "Google",
    requiresDiscoveryUrl: false,
  },
  github: {
    providerId: "github",
    defaultAlias: "github",
    defaultDisplayName: "GitHub",
    requiresDiscoveryUrl: false,
  },
  // Entra ID is per-directory, so the tenant-specific v2.0 metadata document
  // is the only way to resolve the right endpoints.
  "entra-id": {
    providerId: "oidc",
    defaultAlias: "entra-id",
    defaultDisplayName: "Microsoft Entra ID",
    defaultScopes: "openid profile email",
    requiresDiscoveryUrl: true,
  },
  okta: {
    providerId: "oidc",
    defaultAlias: "okta",
    defaultDisplayName: "Okta",
    defaultScopes: "openid profile email",
    requiresDiscoveryUrl: true,
  },
  oidc: {
    providerId: "oidc",
    defaultAlias: "oidc",
    defaultDisplayName: "OpenID Connect",
    defaultScopes: "openid profile email",
    requiresDiscoveryUrl: true,
  },
}

/** Recovers the preset for a provider Keycloak already stores. */
export function presetForStoredProvider(
  providerId: unknown,
  alias: string,
): IdentityProviderPreset {
  if (providerId === "google") return "google"
  if (providerId === "github") return "github"
  const matched = (["entra-id", "okta"] as const)
    .find((preset) => identityProviderPresets[preset].defaultAlias === alias)
  return matched ?? "oidc"
}
