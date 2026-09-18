import { diagnoseConnection } from "./diagnostics"
import { PlatformApiError } from "../errors"
import type { ResourceRegistry } from "../resources/module"
import { isGenioBotHealthy } from "../installed-services/seed"
import type { ResourceMemoryState } from "../resources/state"
import type { ResourceConnectionRegistry } from "./module"
import {
  providerCredentialProfileForVerification,
  type ConnectionVerifier,
} from "./module"
import {
  assertInstalledConnectorConfiguration,
  canonicalizeApiRequestMapping,
  normalizeMcpToolNamespace,
  type ConnectionRegistration,
} from "./contract"
import { parseConnectionCertificate, sameConnectionCertificate } from "./certificate"
import type { ProviderProfileCatalog } from "../providers/module"
import {
  resolveProviderCredentialProfileBinding,
  type ProviderCredentialProfileStore,
} from "../provider-credentials/module"
import type { ProviderCredentialProfileReference } from "../provider-credentials/contract"
import {
  canonicalizeConnectionRegistrationInput,
  normalizeConnectionEndpoint,
} from "./registration"

export interface ConnectionMemoryOptions {
  state: ResourceMemoryState
  resources: ResourceRegistry
  providers: ProviderProfileCatalog
  providerCredentials?: ProviderCredentialProfileStore
  now?: () => number
  idFactory?: (sequence: number) => string
  verifier?: ConnectionVerifier
  installedBotHealthCheck?: (endpoint: string) => Promise<boolean> | boolean
}


async function resolveCredentialProfile(
  options: ConnectionMemoryOptions,
  tenantId: string,
  ownerOrganizationId: string,
  reference: ProviderCredentialProfileReference,
) {
  if (!options.providerCredentials) {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_STORE_UNAVAILABLE", 503)
  }
  return resolveProviderCredentialProfileBinding({
    store: options.providerCredentials,
    tenantId,
    ownerOrganizationId,
    reference,
  })
}

export function createInMemoryResourceConnectionRegistry(
  options: ConnectionMemoryOptions,
): ResourceConnectionRegistry {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((sequence) => `connection-${sequence}`)

  return {
    async listHealthTargets(input) {
      return [...options.state.connections.values()]
        .filter((connection) =>
          connection.tenant_id === input.tenantId &&
          connection.lifecycle === "ENABLED" &&
          connection.verification_state === "VERIFIED"
        )
        .map((connection) => ({
          resource_id: connection.resource_id,
          connection_id: connection.connection_id,
          endpoint: connection.endpoint,
          credential_ref: connection.credential_ref ?? null,
          configuration_revision: connection.configuration_revision,
          health_state: connection.health_state,
          health_observed_at: connection.health_observed_at,
          health_source_revision: connection.health_source_revision,
          certificate: connection.certificate,
        }))
        .sort((left, right) => left.connection_id.localeCompare(right.connection_id))
    },

    async list(input) {
      await options.resources.getResource({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
      })
      return [...options.state.connections.values()]
        .filter(
          (connection) =>
            connection.tenant_id === input.tenantId &&
            connection.resource_id === input.resourceId,
        )
        .sort((left, right) => left.display_name.localeCompare(right.display_name))
    },

    async get(input) {
      const connection = options.state.connections.get(
        `${input.tenantId}:${input.resourceId}:${input.connectionId}`,
      )
      if (!connection) {
        throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
      }
      return connection
    },

    async create(input) {
      const resource = await options.resources.getResource({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
      })
      const connectionKind = input.value.connection_kind ?? "LLM"
      if (resource.installation_owned) {
        throw new PlatformApiError("INSTALLATION_OWNED_CONNECTION_SINGLETON", 409)
      }
      if (resource.kind !== connectionKind) {
        throw new PlatformApiError(
          "CONNECTION_RESOURCE_KIND_MISMATCH",
          422,
          "Connection kind must match its owning Resource",
        )
      }
      const canonical = canonicalizeConnectionRegistrationInput(input.value)
      const {
        providerType,
        downstreamIdentity,
        endpoint,
        requestMapping,
      } = canonical
      const profile = connectionKind === "LLM"
        ? input.value.provider_profile_id
          ? await options.providers.get({
              tenantId: input.tenantId,
              profileId: input.value.provider_profile_id,
            })
          : await options.providers.findDefault({
              tenantId: input.tenantId,
              providerType: providerType!,
            })
        : null
      if (profile && profile.provider_type !== providerType) {
        throw new PlatformApiError("PROVIDER_PROFILE_TYPE_MISMATCH", 422)
      }
      const providerCredentialProfile = input.value.provider_credential_profile
        ? await resolveCredentialProfile(
            options,
            input.tenantId,
            resource.owner_organization_id,
            input.value.provider_credential_profile,
          )
        : null
      const certificate = parseConnectionCertificate({
        mode: input.value.certificate_mode ?? (input.value.certificate_pem ? "CUSTOM_CA" : "SYSTEM_CA"),
        certificate_pem: input.value.certificate_pem,
      }, now())
      const connectionId = input.connectionId?.trim()
      if (connectionId && options.state.connections.has(`${input.tenantId}:${input.resourceId}:${connectionId}`)) {
        throw new PlatformApiError("CONNECTION_ID_EXISTS", 409)
      }
      options.state.connectionSequence += 1
      const connection: ConnectionRegistration = {
        tenant_id: input.tenantId,
        connection_id: connectionId || idFactory(options.state.connectionSequence),
        resource_id: input.resourceId,
        display_name: input.value.display_name.trim(),
        connection_kind: connectionKind,
        provider_type: providerType,
        provider_profile_id: profile?.profile_id ?? null,
        ...(input.value.connector_configuration ? { connector_configuration: input.value.connector_configuration } : {}),
        endpoint,
        mcp_tool_namespace: connectionKind === "MCP"
          ? normalizeMcpToolNamespace(input.value.mcp_tool_namespace)
          : null,
        mcp_selected_tools: [],
        mcp_tool_selection_operation_id: null,
        credential_ref: input.value.credential_ref ?? null,
        provider_credential_profile: providerCredentialProfile,
        downstream_identity: downstreamIdentity,
        request_mapping: requestMapping,
        certificate,
        status: "DRAFT",
        configuration_revision: 1,
        lifecycle: "DRAFT",
        revoke_requested_after_release_revision: null,
        verification_state: "UNVERIFIED",
        health_state: "UNKNOWN",
        health_observed_at: null,
        health_source_revision: null,
        routing_priority: input.value.routing_priority ?? 0,
        region: input.value.region?.trim() || null,
        supported_obligations: [...new Set(input.value.supported_obligations ?? [])].sort(),
        created_at: now(),
      }
      options.state.connections.set(
        `${connection.tenant_id}:${connection.resource_id}:${connection.connection_id}`,
        connection,
      )
      return connection
    },

    async update(input) {
      const resource = await options.resources.getResource({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
      })
      const current = await this.get(input)
      if (current.connector_configuration && input.value.connector_configuration && input.value.endpoint !== current.endpoint && resource.lifecycle !== "DRAFT") throw new PlatformApiError("CONNECTOR_SITE_CHANGE_REQUIRES_NEW_CONNECTION", 409)
      if (current.configuration_revision !== input.value.expected_revision) {
        throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
      }
      if (current.lifecycle === "REVOKED") throw new PlatformApiError("CONNECTION_REVOKED", 409)
      if (current.lifecycle === "REVOKE_PENDING") throw new PlatformApiError("CONNECTION_LIFECYCLE_CONFLICT", 409)
      if (resource.installation_owned && input.value.endpoint !== undefined && input.value.connector_configuration === undefined) {
        throw new PlatformApiError("INSTALLATION_OWNED_ENDPOINT", 409)
      }
      if (input.value.request_mapping !== undefined && current.connection_kind !== "API") {
        throw new PlatformApiError("API_REQUEST_MAPPING_UNSUPPORTED", 422)
      }
      const providerCredentialProfile = input.value.provider_credential_profile === undefined
        ? undefined
        : input.value.provider_credential_profile === null
          ? null
          : await resolveCredentialProfile(
              options,
              input.tenantId,
              resource.owner_organization_id,
              input.value.provider_credential_profile,
            )
      const effectiveProviderCredentialProfile = providerCredentialProfile === undefined
        ? current.provider_credential_profile
        : providerCredentialProfile
      const effectiveDownstreamIdentity = providerCredentialProfile === undefined
        ? input.value.downstream_identity ?? current.downstream_identity
        : providerCredentialProfile
          ? { mode: "SERVICE" as const, authentication: "PROVIDER_CREDENTIAL_PROFILE" as const }
          : current.downstream_identity.authentication === "PROVIDER_CREDENTIAL_PROFILE"
            ? { mode: "NONE" as const }
            : current.downstream_identity
      const canonical = canonicalizeConnectionRegistrationInput({
        display_name: input.value.display_name ?? current.display_name,
        connection_kind: current.connection_kind,
        ...(current.provider_type ? { provider_type: current.provider_type } : {}),
        ...(current.provider_profile_id ? { provider_profile_id: current.provider_profile_id } : {}),
        endpoint: input.value.endpoint ?? current.endpoint,
        ...(input.value.credential_ref === undefined
          ? current.credential_ref ? { credential_ref: current.credential_ref } : {}
          : input.value.credential_ref ? { credential_ref: input.value.credential_ref } : {}),
        ...(effectiveProviderCredentialProfile
          ? { provider_credential_profile: {
              profile_id: effectiveProviderCredentialProfile.profile_id,
              revision: effectiveProviderCredentialProfile.revision,
            } }
          : {}),
        downstream_identity: effectiveDownstreamIdentity,
        ...(input.value.request_mapping ?? current.request_mapping
          ? { request_mapping: input.value.request_mapping ?? current.request_mapping ?? undefined }
          : {}),
      })
      const updated: ConnectionRegistration = {
        ...current,
        ...(input.value.connector_configuration ? { connector_configuration: input.value.connector_configuration } : {}),
        ...(input.value.downstream_identity ? { downstream_identity: canonical.downstreamIdentity, verification_state: "UNVERIFIED" as const, health_state: "UNKNOWN" as const, health_observed_at: null, health_source_revision: null } : {}),
        ...(input.value.display_name === undefined
          ? {}
          : { display_name: input.value.display_name.trim() }),
        ...(input.value.endpoint === undefined
          ? {}
          : {
              endpoint: normalizeConnectionEndpoint(input.value.endpoint),
              verification_state: "UNVERIFIED" as const,
              health_state: "UNKNOWN" as const,
              health_observed_at: null,
              health_source_revision: null,
            }),
        ...(input.value.mcp_tool_namespace === undefined
          ? {}
          : { mcp_tool_namespace: normalizeMcpToolNamespace(input.value.mcp_tool_namespace) }),
        ...(input.value.credential_ref === undefined
          ? {}
          : { credential_ref: input.value.credential_ref }),
        ...(providerCredentialProfile === undefined
          ? {}
          : {
              provider_credential_profile: providerCredentialProfile,
              downstream_identity: canonical.downstreamIdentity,
              verification_state: "UNVERIFIED" as const,
              health_state: "UNKNOWN" as const,
              health_observed_at: null,
              health_source_revision: null,
            }),
        ...(input.value.request_mapping === undefined
          ? {}
          : { request_mapping: canonicalizeApiRequestMapping(input.value.request_mapping) }),
        ...(input.value.routing_priority === undefined ? {} : { routing_priority: input.value.routing_priority }),
        ...(input.value.region === undefined ? {} : { region: input.value.region?.trim() || null }),
        ...(input.value.supported_obligations === undefined
          ? {}
          : { supported_obligations: [...new Set(input.value.supported_obligations)].sort() }),
        configuration_revision: current.configuration_revision + 1,
      }
      options.state.connections.set(
        `${updated.tenant_id}:${updated.resource_id}:${updated.connection_id}`,
        updated,
      )
      return updated
    },

    async updateCertificate(input) {
      await options.resources.getResource({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
      })
      const current = await this.get(input)
      if (current.configuration_revision !== input.value.expected_revision) {
        throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
      }
      if (current.lifecycle === "REVOKED" || current.lifecycle === "REVOKE_PENDING") {
        throw new PlatformApiError("CONNECTION_LIFECYCLE_CONFLICT", 409)
      }
      const certificate = parseConnectionCertificate(input.value, now())
      if (sameConnectionCertificate(current.certificate, certificate)) return current
      const updated: ConnectionRegistration = {
        ...current,
        certificate,
        verification_state: "UNVERIFIED",
        health_state: "UNKNOWN",
        health_observed_at: null,
        health_source_revision: null,
        configuration_revision: current.configuration_revision + 1,
      }
      options.state.connections.set(
        `${updated.tenant_id}:${updated.resource_id}:${updated.connection_id}`,
        updated,
      )
      return updated
    },

    async test(input) {
      const current = await this.get(input)
      const resource = await options.resources?.getResource(input)
      const providerCredentialProfile = await providerCredentialProfileForVerification({
        store: options.providerCredentials,
        tenantId: input.tenantId,
        ownerOrganizationId: resource?.owner_organization_id ?? "",
        reference: current.provider_credential_profile,
      })
      return diagnoseConnection({ connection: current, verifier: options.verifier, providerCredentialProfile })
    },

    async verify(input) {
      const resource = await options.resources.getResource(input)
      const current = await this.get(input)
      const serviceKind = input.serviceKind ?? resource.service_kind
      assertInstalledConnectorConfiguration(serviceKind, current.connector_configuration)
      if (serviceKind === "GENIO_BOT") {
        const healthy = await (options.installedBotHealthCheck ?? isGenioBotHealthy)(current.endpoint)
        if (!healthy) throw new PlatformApiError("CONNECTION_HEALTH_CHECK_FAILED", 422)
      } else if (!options.verifier) {
        throw new PlatformApiError("CONNECTION_VERIFIER_UNAVAILABLE", 503)
      }
      if (["EXPIRED", "NOT_YET_VALID", "INVALID"].includes(current.certificate?.status ?? "")) {
        throw new PlatformApiError("CONNECTION_CERTIFICATE_NOT_USABLE", 422)
      }
      const providerCredentialProfile = await providerCredentialProfileForVerification({
        store: options.providerCredentials,
        tenantId: input.tenantId,
        ownerOrganizationId: resource.owner_organization_id,
        reference: current.provider_credential_profile,
      })
      if (serviceKind !== "GENIO_BOT" && !await options.verifier!.verify({
          connection: current,
          ...(providerCredentialProfile ? { providerCredentialProfile } : {}),
        })) throw new PlatformApiError("CONNECTION_VERIFICATION_FAILED", 422)
      const ready = {
        ...current,
        status: "READY" as const,
        lifecycle: "ENABLED" as const,
        verification_state: "VERIFIED" as const,
        health_state: "HEALTHY" as const,
        health_observed_at: now(),
        health_source_revision: (current.health_source_revision ?? 0) + 1,
        configuration_revision: current.configuration_revision + 1,
      }
      options.state.connections.set(
        `${ready.tenant_id}:${ready.resource_id}:${ready.connection_id}`,
        ready,
      )
      return ready
    },

    async updateMcpRouting(input) {
      const current = [...options.state.connections.values()].find(
        (candidate) =>
          candidate.tenant_id === input.tenantId &&
          candidate.resource_id === input.resourceId &&
          candidate.connection_id === input.connectionId,
      )
      if (!current) throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
      if (current.connection_kind !== "MCP") {
        throw new PlatformApiError("CONNECTION_NOT_MCP", 422)
      }
      await options.resources.getResource({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
      })
      if (current.configuration_revision !== input.expectedRevision) {
        throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
      }
      if (input.mcpToolNamespace === undefined) return current
      const updated = {
        ...current,
        ...(input.mcpToolNamespace === undefined
          ? {}
          : { mcp_tool_namespace: normalizeMcpToolNamespace(input.mcpToolNamespace) }),
        configuration_revision: current.configuration_revision + 1,
      }
      options.state.connections.set(
        `${updated.tenant_id}:${updated.resource_id}:${updated.connection_id}`,
        updated,
      )
      return updated
    },

    async transitionLifecycle(input) {
      const resource = await options.resources.getResource(input)
      const current = await this.get(input)
      if (current.configuration_revision !== input.value.expected_revision) {
        throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
      }
      if (resource.installation_owned && ["REQUEST_REVOKE", "CONFIRM_REVOKED"].includes(input.value.command)) {
        throw new PlatformApiError("INSTALLATION_OWNED_CONNECTION_CANNOT_REVOKE", 409)
      }
      let lifecycle: ConnectionRegistration["lifecycle"]
      if (input.value.command === "ENABLE") {
        if (!['DRAFT', 'DISABLED'].includes(current.lifecycle)) throw new PlatformApiError("CONNECTION_LIFECYCLE_CONFLICT", 409)
        assertInstalledConnectorConfiguration(resource.service_kind, current.connector_configuration)
        if (current.verification_state !== "VERIFIED") throw new PlatformApiError("CONNECTION_NOT_VERIFIED", 409)
        if (resource.service_kind === "GENIO_BOT" && !await (options.installedBotHealthCheck ?? isGenioBotHealthy)(current.endpoint)) throw new PlatformApiError("CONNECTION_HEALTH_CHECK_FAILED", 422)
        lifecycle = "ENABLED"
      } else if (input.value.command === "DISABLE") {
        if (!['DRAFT', 'ENABLED', 'DISABLED'].includes(current.lifecycle)) throw new PlatformApiError("CONNECTION_LIFECYCLE_CONFLICT", 409)
        lifecycle = "DISABLED"
      } else if (input.value.command === "REQUEST_REVOKE") {
        if (current.lifecycle === "REVOKED") throw new PlatformApiError("CONNECTION_REVOKED", 409)
        if (current.lifecycle === "REVOKE_PENDING") return current
        lifecycle = "REVOKE_PENDING"
      } else {
        if (
          current.lifecycle !== "REVOKE_PENDING" ||
          input.value.applied_release_revision === undefined ||
          input.value.applied_release_revision <= (current.revoke_requested_after_release_revision ?? 0)
        ) {
          throw new PlatformApiError("CONNECTION_RELEASE_ACK_REQUIRED", 409)
        }
        lifecycle = "REVOKED"
      }
      const updated: ConnectionRegistration = {
        ...current,
        lifecycle,
        revoke_requested_after_release_revision: input.value.command === "REQUEST_REVOKE"
          ? 0
          : current.revoke_requested_after_release_revision,
        status: lifecycle === "ENABLED" ? "READY" : "DISABLED",
        configuration_revision: current.configuration_revision + 1,
      }
      options.state.connections.set(`${updated.tenant_id}:${updated.resource_id}:${updated.connection_id}`, updated)
      return updated
    },

    async observeHealth(input) {
      await options.resources.getResource(input)
      const current = await this.get(input)
      if (input.value.source_revision <= (current.health_source_revision ?? 0)) {
        throw new PlatformApiError("CONNECTION_HEALTH_REVISION_CONFLICT", 409)
      }
      const updated: ConnectionRegistration = {
        ...current,
        health_state: input.value.state,
        health_observed_at: input.value.observed_at,
        health_source_revision: input.value.source_revision,
      }
      options.state.connections.set(`${updated.tenant_id}:${updated.resource_id}:${updated.connection_id}`, updated)
      return updated
    },

    async observeHealthBatch(input) {
      const observed: ConnectionRegistration[] = []
      const keys = new Set<string>()
      for (const value of [...input.value.observations].sort((left, right) =>
        left.resource_id.localeCompare(right.resource_id) ||
        left.connection_id.localeCompare(right.connection_id)
      )) {
        const key = `${value.resource_id}\u0000${value.connection_id}`
        if (keys.has(key)) throw new PlatformApiError("CONNECTION_HEALTH_BATCH_DUPLICATE", 422)
        keys.add(key)
        await options.resources.getResource({ tenantId: input.tenantId, resourceId: value.resource_id })
        const current = await this.get({
          tenantId: input.tenantId,
          resourceId: value.resource_id,
          connectionId: value.connection_id,
        })
        if (value.source_revision <= (current.health_source_revision ?? 0)) {
          observed.push(current)
          continue
        }
        const updated: ConnectionRegistration = {
          ...current,
          health_state: value.state,
          health_observed_at: value.observed_at,
          health_source_revision: value.source_revision,
        }
        options.state.connections.set(`${updated.tenant_id}:${updated.resource_id}:${updated.connection_id}`, updated)
        observed.push(updated)
      }
      return observed
    },

    async remove(input) {
      const resource = await options.resources.getResource({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
      })
      if (resource.installation_owned) {
        throw new PlatformApiError("INSTALLATION_OWNED_CONNECTION_CANNOT_DELETE", 409)
      }
      if (resource.lifecycle !== "DRAFT") {
        throw new PlatformApiError(
          "PUBLISHED_RESOURCE_IMMUTABLE",
          409,
          "Connections cannot be deleted after Resource publication",
        )
      }
      const connection = await this.get(input)
      const inUse = [...options.state.connections.values()].some(
        (candidate) =>
          candidate.connection_id === connection.connection_id &&
          candidate.resource_id === connection.resource_id,
      )
      if (!inUse) {
        throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
      }
      options.state.connections.delete(
        `${input.tenantId}:${input.resourceId}:${input.connectionId}`,
      )
    },
  }
}
