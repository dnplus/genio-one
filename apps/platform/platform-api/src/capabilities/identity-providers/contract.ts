import { Type, type Static } from "typebox"

const Alias = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$" })
const DisplayName = Type.String({ minLength: 1, maxLength: 128 })
const HttpsUrl = Type.String({ minLength: 1, maxLength: 2048 })
const Secret = Type.String({ minLength: 1, maxLength: 4096 })

/**
 * The login methods GenioOne offers in the Management console. Every preset
 * resolves to a Keycloak identity provider type: `google` and `github` are
 * Keycloak social providers, while Entra ID and Okta are per-deployment
 * installations that only a discovery URL can resolve, so they broker as
 * generic OpenID Connect.
 */
export const IdentityProviderPresetSchema = Type.Union([
  Type.Literal("google"),
  Type.Literal("github"),
  Type.Literal("entra-id"),
  Type.Literal("okta"),
  Type.Literal("oidc"),
])

export const IdentityProviderKindSchema = Type.Union([
  Type.Literal("SOCIAL"),
  Type.Literal("OIDC"),
])

/**
 * A login method as it exists in Keycloak right now. `client_secret` is never
 * part of this shape: Keycloak returns it masked, and GenioOne does not
 * re-publish upstream credentials to the browser.
 */
export const IdentityProviderSchema = Type.Object({
  alias: Alias,
  preset: IdentityProviderPresetSchema,
  kind: IdentityProviderKindSchema,
  display_name: DisplayName,
  enabled: Type.Boolean(),
  /** Keycloak hides the provider's buttons on the login page when true. */
  hidden_on_login_page: Type.Boolean(),
  trust_email: Type.Boolean(),
  client_id: Type.String({ maxLength: 512 }),
  /** Absent for social presets, which use Keycloak's built-in endpoints. */
  discovery_url: Type.Optional(HttpsUrl),
  authorization_url: Type.Optional(HttpsUrl),
  token_url: Type.Optional(HttpsUrl),
  /** The URI the upstream provider must allow-list for this login method. */
  redirect_uri: HttpsUrl,
}, { additionalProperties: false })

export const IdentityProviderListSchema = Type.Object({
  tenant_id: Type.String({ minLength: 1, maxLength: 256 }),
  realm: Type.String({ minLength: 1, maxLength: 256 }),
  providers: Type.Array(IdentityProviderSchema, { maxItems: 100 }),
}, { additionalProperties: false })

export const CreateIdentityProviderSchema = Type.Object({
  preset: IdentityProviderPresetSchema,
  /** Defaults to the preset alias, so the common case needs no alias. */
  alias: Type.Optional(Alias),
  display_name: Type.Optional(DisplayName),
  client_id: Type.String({ minLength: 1, maxLength: 512 }),
  client_secret: Secret,
  /**
   * Required for every preset except `google` and `github`. Keycloak resolves
   * the provider's endpoints from it, so GenioOne never hardcodes an issuer.
   */
  discovery_url: Type.Optional(HttpsUrl),
  enabled: Type.Optional(Type.Boolean()),
  hidden_on_login_page: Type.Optional(Type.Boolean()),
  trust_email: Type.Optional(Type.Boolean()),
}, { additionalProperties: false })

export const UpdateIdentityProviderSchema = Type.Object({
  display_name: Type.Optional(DisplayName),
  client_id: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  /** Omit to keep the stored secret; Keycloak never returns it in clear. */
  client_secret: Type.Optional(Secret),
  discovery_url: Type.Optional(HttpsUrl),
  enabled: Type.Optional(Type.Boolean()),
  hidden_on_login_page: Type.Optional(Type.Boolean()),
  trust_email: Type.Optional(Type.Boolean()),
}, { additionalProperties: false })

export const IdentityProviderPathSchema = Type.Object({
  tenant_id: Type.String({ minLength: 1, maxLength: 256 }),
}, { additionalProperties: false })

export const IdentityProviderAliasPathSchema = Type.Object({
  tenant_id: Type.String({ minLength: 1, maxLength: 256 }),
  alias: Alias,
}, { additionalProperties: false })

export type IdentityProvider = Static<typeof IdentityProviderSchema>
export type IdentityProviderList = Static<typeof IdentityProviderListSchema>
export type IdentityProviderPreset = Static<typeof IdentityProviderPresetSchema>
export type CreateIdentityProviderInput = Static<typeof CreateIdentityProviderSchema>
export type UpdateIdentityProviderInput = Static<typeof UpdateIdentityProviderSchema>
