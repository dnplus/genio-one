import { PlatformApiError } from "../errors"
import type {
  CreateProviderProfileInput,
  ProviderCapability,
  ProviderProfile,
} from "./contract"
import type { ProviderProfileCatalog } from "./module"

const BUILT_IN_PROFILES: readonly Omit<ProviderProfile, "tenant_id">[] = [
  {
    profile_id: "provider-generic-openai-compatible",
    display_name: "Generic OpenAI-compatible API",
    provider_type: "GENERIC_OPENAI_COMPATIBLE",
    protocol: "OPENAI_COMPATIBLE",
    capabilities: ["CHAT", "STREAMING"],
    model_discovery: "MANUAL",
    endpoint_required: true,
    credential_required: false,
    built_in: true,
  },
  {
    profile_id: "provider-openai",
    display_name: "OpenAI",
    provider_type: "OPENAI",
    protocol: "OPENAI_COMPATIBLE",
    capabilities: ["CHAT", "STREAMING", "TOOL_CALLING", "VISION", "REASONING", "EMBEDDINGS"],
    model_discovery: "PROVIDER_API",
    endpoint_required: true,
    credential_required: true,
    built_in: true,
  },
  {
    profile_id: "provider-omlx",
    display_name: "OMLX (local)",
    provider_type: "OMLX",
    protocol: "OPENAI_COMPATIBLE",
    capabilities: ["CHAT", "STREAMING", "TOOL_CALLING", "VISION"],
    model_discovery: "MANUAL",
    endpoint_required: true,
    credential_required: false,
    built_in: true,
  },
  {
    profile_id: "provider-ollama",
    display_name: "Ollama (local)",
    provider_type: "OLLAMA",
    protocol: "OPENAI_COMPATIBLE",
    capabilities: ["CHAT", "STREAMING", "TOOL_CALLING", "VISION", "EMBEDDINGS"],
    model_discovery: "PROVIDER_API",
    endpoint_required: true,
    credential_required: false,
    built_in: true,
  },
  {
    profile_id: "provider-gcp-vertex-ai",
    display_name: "Google Vertex AI",
    provider_type: "GCP_VERTEX_AI",
    protocol: "GCP_VERTEX_AI",
    capabilities: ["CHAT", "STREAMING", "TOOL_CALLING", "VISION", "REASONING", "EMBEDDINGS"],
    model_discovery: "PROVIDER_API",
    endpoint_required: true,
    credential_required: true,
    built_in: true,
  },
  {
    profile_id: "provider-anthropic",
    display_name: "Anthropic",
    provider_type: "ANTHROPIC",
    protocol: "ANTHROPIC",
    capabilities: ["CHAT", "STREAMING", "TOOL_CALLING", "VISION", "REASONING"],
    model_discovery: "PROVIDER_API",
    endpoint_required: true,
    credential_required: true,
    built_in: true,
  },
]

export interface ProviderMemoryOptions {
  now?: () => number
  idFactory?: (sequence: number) => string
}

export function createInMemoryProviderProfileCatalog(
  options: ProviderMemoryOptions = {},
): ProviderProfileCatalog {
  const profiles = new Map<string, ProviderProfile>()
  const idFactory = options.idFactory ?? ((sequence) => `provider-profile-${sequence}`)
  let sequence = 0

  return {
    async list(input) {
      return [
        ...BUILT_IN_PROFILES.map((profile) => ({ ...profile, tenant_id: input.tenantId })),
        ...profiles.values(),
      ].sort((left, right) => left.display_name.localeCompare(right.display_name))
    },

    async get(input) {
      if (!input.profileId) {
        throw new PlatformApiError("PROVIDER_PROFILE_REQUIRED", 422)
      }
      const builtIn = BUILT_IN_PROFILES.find((profile) => profile.profile_id === input.profileId)
      if (builtIn) return { ...builtIn, tenant_id: input.tenantId }
      const profile = profiles.get(`${input.tenantId}:${input.profileId}`)
      if (!profile) throw new PlatformApiError("PROVIDER_PROFILE_NOT_FOUND", 404)
      return profile
    },

    async findDefault(input) {
      const profile = BUILT_IN_PROFILES.find(
        (candidate) => candidate.provider_type === input.providerType,
      )
      if (!profile) throw new PlatformApiError("PROVIDER_PROFILE_NOT_FOUND", 404)
      return { ...profile, tenant_id: input.tenantId }
    },

    async create(input: { tenantId: string; value: CreateProviderProfileInput }) {
      const defaults = BUILT_IN_PROFILES.find(
        (profile) => profile.provider_type === input.value.provider_type,
      )
      if (!defaults) throw new PlatformApiError("UNSUPPORTED_PROVIDER_TYPE", 422)
      if (
        input.value.protocol === "OLLAMA_NATIVE" &&
        input.value.provider_type !== "OLLAMA"
      ) {
        throw new PlatformApiError(
          "PROVIDER_PROTOCOL_NOT_SUPPORTED",
          422,
          "OLLAMA_NATIVE is only valid for an Ollama provider profile",
        )
      }
      if (
        input.value.protocol === "GCP_VERTEX_AI" &&
        input.value.provider_type !== "GCP_VERTEX_AI"
      ) {
        throw new PlatformApiError(
          "PROVIDER_PROTOCOL_NOT_SUPPORTED",
          422,
          "GCP_VERTEX_AI is only valid for a Google Vertex AI provider profile",
        )
      }
      if (
        input.value.protocol === "ANTHROPIC" &&
        input.value.provider_type !== "ANTHROPIC"
      ) {
        throw new PlatformApiError(
          "PROVIDER_PROTOCOL_NOT_SUPPORTED",
          422,
          "ANTHROPIC is only valid for an Anthropic provider profile",
        )
      }
      const capabilities: ProviderCapability[] = input.value.capabilities ?? [
        ...defaults.capabilities,
      ]
      if (capabilities.length === 0) {
        throw new PlatformApiError("PROVIDER_CAPABILITIES_REQUIRED", 422)
      }
      sequence += 1
      const profile: ProviderProfile = {
        tenant_id: input.tenantId,
        profile_id: idFactory(sequence),
        display_name: input.value.display_name.trim(),
        provider_type: input.value.provider_type,
        protocol: input.value.protocol ?? defaults.protocol,
        capabilities,
        model_discovery: input.value.model_discovery ?? defaults.model_discovery,
        endpoint_required: defaults.endpoint_required,
        credential_required: defaults.credential_required,
        built_in: false,
      }
      profiles.set(`${profile.tenant_id}:${profile.profile_id}`, profile)
      return profile
    },
  }
}
