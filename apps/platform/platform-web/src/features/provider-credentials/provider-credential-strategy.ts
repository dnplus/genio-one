import type { ProviderCredentialStrategy } from "@/domain/contracts"

export type ProviderCredentialStrategyKind = ProviderCredentialStrategy["kind"]

export type ProviderType =
  | "GENERIC_OPENAI_COMPATIBLE"
  | "OPENAI"
  | "OMLX"
  | "OLLAMA"
  | "GCP_VERTEX_AI"
  | "ANTHROPIC"

export const defaultProviderEndpoints: Record<ProviderType, string> = {
  GENERIC_OPENAI_COMPATIBLE: "https://api.openai.com/v1",
  OPENAI: "https://api.openai.com/v1",
  OMLX: "http://127.0.0.1:8080/v1",
  OLLAMA: "http://127.0.0.1:11434/v1",
  GCP_VERTEX_AI: "https://us-central1-aiplatform.googleapis.com/v1",
  ANTHROPIC: "https://api.anthropic.com",
}

export function defaultLlmResourceName(providerDisplayName: string) {
  return `${providerDisplayName.trim()} Model`
}

export function defaultLlmConnectionName(providerDisplayName: string) {
  return `${providerDisplayName.trim()} Connection`
}

export function buildProviderCredentialStrategy(input: {
  kind: ProviderCredentialStrategyKind
  secretReference: string
  projectName: string
  region: string
  issuer: string
  clientId: string
  audience: string
  projectId: string
  poolName: string
  providerName: string
  serviceAccountName: string
}): ProviderCredentialStrategy {
  if (input.kind === "STATIC_SECRET_REFERENCE") {
    return { kind: input.kind, secret_ref: input.secretReference.trim() }
  }
  if (input.kind === "RUNTIME_IDENTITY") {
    return {
      kind: input.kind,
      adapter: "GCP_APPLICATION_DEFAULT",
      parameters: { project_name: input.projectName.trim(), region: input.region.trim() },
    }
  }
  return {
    kind: input.kind,
    source: {
      issuer: input.issuer.trim(),
      client_id: input.clientId.trim(),
      client_secret_ref: input.secretReference.trim(),
      ...(input.audience.trim() ? { audience: input.audience.trim() } : {}),
    },
    exchange: {
      adapter: "GCP_STS",
      project_name: input.projectName.trim(),
      region: input.region.trim(),
      project_id: input.projectId.trim(),
      workload_identity_pool_name: input.poolName.trim(),
      workload_identity_provider_name: input.providerName.trim(),
      ...(input.serviceAccountName.trim() ? { service_account_name: input.serviceAccountName.trim() } : {}),
    },
  }
}
