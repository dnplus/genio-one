import type {
  ConnectionHealthObservation,
  ConnectionHealthBatchObservation,
  ConnectionHealthTarget,
  ConnectionLifecycleCommand,
  ConnectionRegistration,
  CreateConnectionInput,
  UpdateConnectionCertificateInput,
  UpdateConnectionInput,
} from "./contract"
import type { ProviderCredentialProfileReference, ProviderCredentialProfileRevision } from "../provider-credentials/contract"
import type { ProviderCredentialProfileStore } from "../provider-credentials/module"
import type { InstallationServiceKind } from "../resources/contract"

export interface ConnectionVerifierInput {
  connection: ConnectionRegistration
  providerCredentialProfile?: ProviderCredentialProfileRevision
}

export async function providerCredentialProfileForVerification(input: {
  store?: ProviderCredentialProfileStore
  tenantId: string
  ownerOrganizationId: string
  reference?: ProviderCredentialProfileReference | null
}): Promise<ProviderCredentialProfileRevision | undefined> {
  if (!input.store || !input.reference) return undefined
  const revision = await input.store.getRevision({
    tenantId: input.tenantId,
    profileId: input.reference.profile_id,
    revision: input.reference.revision,
  })
  if (
    !revision ||
    revision.state !== "ACTIVE" ||
    revision.owner_organization_id !== input.ownerOrganizationId
  ) return undefined
  const latest = await input.store.getLatest({
    tenantId: input.tenantId,
    profileId: input.reference.profile_id,
  })
  if (!latest || latest.state !== "ACTIVE") return undefined
  return revision
}

export interface ResourceConnectionRegistry {
  test(input: { tenantId: string; resourceId: string; connectionId: string }): ReturnType<typeof import("./diagnostics").diagnoseConnection>
  listHealthTargets(input: { tenantId: string; gatewayId: string }): Promise<ConnectionHealthTarget[]>
  list(input: { tenantId: string; resourceId: string }): Promise<ConnectionRegistration[]>
  get(input: {
    tenantId: string
    resourceId: string
    connectionId: string
  }): Promise<ConnectionRegistration>
  create(input: {
    tenantId: string
    resourceId: string
    value: CreateConnectionInput
    connectionId?: string
  }): Promise<ConnectionRegistration>
  update(input: {
    tenantId: string
    resourceId: string
    connectionId: string
    value: UpdateConnectionInput
  }): Promise<ConnectionRegistration>
  updateCertificate(input: {
    tenantId: string
    resourceId: string
    connectionId: string
    value: UpdateConnectionCertificateInput
  }): Promise<ConnectionRegistration>
  updateMcpRouting(input: {
    tenantId: string
    resourceId: string
    connectionId: string
    expectedRevision: number
    mcpToolNamespace?: string | null
  }): Promise<ConnectionRegistration>
  /** READY can only be established by a trusted provider/runtime probe. */
  verify(input: {
    tenantId: string
    resourceId: string
    connectionId: string
    serviceKind?: InstallationServiceKind | null
  }): Promise<ConnectionRegistration>
  transitionLifecycle(input: {
    tenantId: string
    resourceId: string
    connectionId: string
    value: ConnectionLifecycleCommand
  }): Promise<ConnectionRegistration>
  observeHealth(input: {
    tenantId: string
    gatewayId: string
    resourceId: string
    connectionId: string
    value: ConnectionHealthObservation
  }): Promise<ConnectionRegistration>
  observeHealthBatch(input: {
    tenantId: string
    gatewayId: string
    value: ConnectionHealthBatchObservation
  }): Promise<ConnectionRegistration[]>
  remove(input: {
    tenantId: string
    resourceId: string
    connectionId: string
  }): Promise<void>
}

export interface ConnectionVerifier {
  diagnose?(input: ConnectionVerifierInput): Promise<{ passed: boolean; reason_code: string; http_status: number | null }>
  verify(input: ConnectionVerifierInput): Promise<boolean> | boolean
}
