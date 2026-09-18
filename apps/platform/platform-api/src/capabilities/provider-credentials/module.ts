import type {
  CreateProviderCredentialProfileInput,
  ProviderCredentialProfileBinding,
  ProviderCredentialProfileRevision,
  ProviderCredentialProfileReference,
  ReviseProviderCredentialProfileInput,
} from "./contract"
import { PlatformApiError } from "../errors"

export interface ProviderCredentialProfileStore {
  readMaterial?(input: { tenantId: string; profileId: string; revision: number }): Promise<string | null>
  listLatest(input: { tenantId: string }): Promise<ProviderCredentialProfileRevision[]>
  getLatest(input: {
    tenantId: string
    profileId: string
  }): Promise<ProviderCredentialProfileRevision | null>
  getRevision(input: {
    tenantId: string
    profileId: string
    revision: number
  }): Promise<ProviderCredentialProfileRevision | null>
  create(input: {
    tenantId: string
    createdBySubjectId: string
    value: CreateProviderCredentialProfileInput
  }): Promise<ProviderCredentialProfileRevision>
  revise(input: {
    tenantId: string
    profileId: string
    createdBySubjectId: string
    value: ReviseProviderCredentialProfileInput
  }): Promise<ProviderCredentialProfileRevision>
}

export async function resolveProviderCredentialProfileBinding(input: {
  store: ProviderCredentialProfileStore
  tenantId: string
  ownerOrganizationId: string
  reference: ProviderCredentialProfileReference
}): Promise<ProviderCredentialProfileBinding> {
  const profile = await input.store.getRevision({
    tenantId: input.tenantId,
    profileId: input.reference.profile_id,
    revision: input.reference.revision,
  })
  if (!profile || profile.owner_organization_id !== input.ownerOrganizationId) {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_NOT_FOUND", 404)
  }
  const latest = await input.store.getLatest({
    tenantId: input.tenantId,
    profileId: input.reference.profile_id,
  })
  if (!latest || latest.state !== "ACTIVE") {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_REVOKED", 409)
  }
  return {
    profile_id: profile.profile_id,
    revision: profile.revision,
    strategy_digest: profile.strategy_digest,
  }
}
