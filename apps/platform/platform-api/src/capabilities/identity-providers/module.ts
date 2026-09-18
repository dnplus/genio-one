import type {
  CreateIdentityProviderInput,
  IdentityProvider,
  IdentityProviderList,
  UpdateIdentityProviderInput,
} from "./contract"

/**
 * Login methods for the installed Keycloak realm. Keycloak owns the records;
 * GenioOne reads and writes them through the Admin REST API rather than
 * keeping a second copy that could drift from what actually authenticates.
 */
export interface IdentityProviderRegistry {
  list(input: { tenantId: string }): Promise<IdentityProviderList>
  create(input: { tenantId: string; value: CreateIdentityProviderInput }): Promise<IdentityProvider>
  update(input: {
    tenantId: string
    alias: string
    value: UpdateIdentityProviderInput
  }): Promise<IdentityProvider>
  remove(input: { tenantId: string; alias: string }): Promise<void>
}
