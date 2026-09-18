import type {
  CreateProviderProfileInput,
  ProviderProfile,
  ProviderType,
} from "./contract"

export interface ProviderProfileCatalog {
  list(input: { tenantId: string }): Promise<ProviderProfile[]>
  get(input: { tenantId: string; profileId?: string }): Promise<ProviderProfile>
  findDefault(input: { tenantId: string; providerType: ProviderType }): Promise<ProviderProfile>
  create(input: {
    tenantId: string
    value: CreateProviderProfileInput
  }): Promise<ProviderProfile>
}
