import { createHash } from "node:crypto"

export interface ProviderCredentialReference {
  profile_id: string
  revision: number
  namespace: string
  secret_name: string
}

export function providerCredentialSecretName(tenantId: string, profileId: string, revision: number): string {
  return `genio-provider-${createHash("sha256").update(JSON.stringify([tenantId, profileId, revision])).digest("hex").slice(0, 32)}`
}

export function providerCredentialReferences(tenantId: string, resources: readonly Record<string, any>[]): ProviderCredentialReference[] {
  const refs = new Map<string, ProviderCredentialReference>()
  for (const resource of resources) {
    if (resource.kind !== "BackendSecurityPolicy") continue
    const id = resource.metadata?.annotations?.["genio.one/credential-material-profile"]
    if (!id) continue
    const revision = Number(resource.metadata.annotations["genio.one/credential-material-revision"])
    const namespace = resource.metadata.namespace
    const secret = resource.spec?.gcpCredentials?.credentialsFile?.secretRef
    const name = providerCredentialSecretName(tenantId, id, revision)
    if (typeof id !== "string" || !Number.isSafeInteger(revision) || revision < 1 || typeof namespace !== "string" || !namespace || secret?.name !== name || secret?.namespace !== namespace) throw new Error("GATEWAY_CREDENTIAL_REFERENCE_INVALID")
    refs.set(`${namespace}:${name}`, { profile_id: id, revision, namespace, secret_name: name })
  }
  return [...refs.values()]
}
