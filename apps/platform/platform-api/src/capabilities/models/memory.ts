import { PlatformApiError } from "../errors"
import type { ResourceRegistry } from "../resources/module"
import type { ResourceConnectionRegistry } from "../connections/module"
import type { ProviderProfileCatalog } from "../providers/module"
import type { ConnectionModelMapping, CreatePublicModelInput, PublicModel } from "./contract"
import type { PublicModelCatalog } from "./module"
import type { ModelMemoryState } from "./state"

export interface ModelMemoryOptions {
  state: ModelMemoryState
  resources: ResourceRegistry
  connections: ResourceConnectionRegistry
  providers: ProviderProfileCatalog
  now?: () => number
  idFactory?: (sequence: number) => string
  mappingIdFactory?: (sequence: number) => string
}

export function createInMemoryPublicModelCatalog(
  options: ModelMemoryOptions,
): PublicModelCatalog {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((sequence) => `model-${sequence}`)
  const mappingIdFactory =
    options.mappingIdFactory ?? ((sequence) => `model-mapping-${sequence}`)

  const mappingsFor = (model: PublicModel): ConnectionModelMapping[] =>
    [...options.state.mappings.values()]
      .filter(
        (mapping) =>
          mapping.tenant_id === model.tenant_id && mapping.public_model_id === model.model_id,
      )
      .sort((left, right) => left.mapping_id.localeCompare(right.mapping_id))

  return {
    async list(input) {
      const configured = [...options.state.models.values()]
        .filter(
          (model) =>
            model.tenant_id === input.tenantId &&
            model.visibility === (input.visibility ?? "PUBLIC") &&
            (input.resourceId === undefined || model.resource_id === input.resourceId),
        )
        .filter((model) => mappingsFor(model).length > 0)
      const routable = (
        await Promise.all(
          configured.map(async (model) => {
            const ready = await Promise.all(
              mappingsFor(model).map(async (mapping) => {
                try {
                  const connection = await options.connections.get({
                    tenantId: input.tenantId,
                    resourceId: model.resource_id,
                    connectionId: mapping.connection_id,
                  })
                  return connection.status === "READY"
                } catch {
                  return false
                }
              }),
            )
            return ready.some(Boolean) ? model : undefined
          }),
        )
      ).filter((model): model is PublicModel => model !== undefined)
      const effective = input.includeUnpublishedResources
        ? routable
        : (
            await Promise.all(
              routable.map(async (model) => ({
                model,
                resource: await options.resources.getResource({
                  tenantId: input.tenantId,
                  resourceId: model.resource_id,
                }),
              })),
            )
          )
            .filter(({ resource }) => resource.lifecycle === "PUBLISHED")
            .map(({ model }) => model)
      return effective.sort((left, right) => left.model_id.localeCompare(right.model_id))
    },

    async get(input) {
      const model = options.state.models.get(`${input.tenantId}:${input.modelId}`)
      if (!model) throw new PlatformApiError("MODEL_NOT_FOUND", 404)
      return model
    },

    async listMappings(input) {
      const mappings = [...options.state.mappings.values()]
        .filter(
          (mapping) =>
            mapping.tenant_id === input.tenantId &&
            (input.resourceId === undefined || mapping.resource_id === input.resourceId) &&
            (input.publicModelId === undefined || mapping.public_model_id === input.publicModelId),
        )
      if (input.readyOnly) {
        const usable = await Promise.all(
          mappings.map(async (mapping) => {
            try {
              const connection = await options.connections.get({
                tenantId: input.tenantId,
                resourceId: mapping.resource_id,
                connectionId: mapping.connection_id,
              })
              return connection.status === "READY" ? mapping : undefined
            } catch {
              return undefined
            }
          }),
        )
        return usable
          .filter((mapping): mapping is ConnectionModelMapping => mapping !== undefined)
          .sort((left, right) => left.mapping_id.localeCompare(right.mapping_id))
      }
      return mappings.sort((left, right) => left.mapping_id.localeCompare(right.mapping_id))
    },

    async create(input: {
      tenantId: string
      resourceId: string
      value: CreatePublicModelInput
    }) {
      const modelName = input.value.model_name.trim()
      const displayName = input.value.display_name.trim()
      if (!modelName) throw new PlatformApiError("INVALID_MODEL_NAME", 422)
      if (!displayName) throw new PlatformApiError("INVALID_MODEL_DISPLAY_NAME", 422)
      if (input.value.mappings.length === 0) {
        throw new PlatformApiError("MODEL_MAPPING_REQUIRED", 422)
      }

      const resource = await options.resources.getResource({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
      })
      if (resource.kind !== "LLM") {
        throw new PlatformApiError("AI_MODEL_REQUIRES_LLM_RESOURCE", 422)
      }
      if (resource.lifecycle !== "DRAFT") {
        throw new PlatformApiError(
          "PUBLISHED_RESOURCE_IMMUTABLE",
          409,
          "Public Models can only be configured while the Resource is a draft",
        )
      }
      const connectionIds = input.value.mappings.map((mapping) => mapping.connection_id)
      if (new Set(connectionIds).size !== connectionIds.length) {
        throw new PlatformApiError("MODEL_MAPPING_DUPLICATE_CONNECTION", 409)
      }

      const connections = await Promise.all(
        input.value.mappings.map(async (mapping) => {
          const providerModel = mapping.provider_model.trim()
          if (!providerModel) throw new PlatformApiError("PROVIDER_MODEL_REQUIRED", 422)
          const connection = await options.connections.get({
            tenantId: input.tenantId,
            resourceId: input.resourceId,
            connectionId: mapping.connection_id,
          })
          if (connection.status !== "READY") {
            throw new PlatformApiError(
              "CONNECTION_NOT_READY",
              409,
              "A Public Model mapping requires a ready Connection",
            )
          }
          if (
            connection.connection_kind !== "LLM" ||
            connection.provider_profile_id === null ||
            connection.provider_type === null
          ) {
            throw new PlatformApiError("MODEL_MAPPING_REQUIRES_LLM_CONNECTION", 422)
          }
          const profile = await options.providers.get({
            tenantId: input.tenantId,
            profileId: connection.provider_profile_id,
          })
          if (profile.provider_type !== connection.provider_type) {
            throw new PlatformApiError("PROVIDER_PROFILE_TYPE_MISMATCH", 422)
          }
          return { connection, providerModel, profile }
        }),
      )
      const duplicate = [...options.state.models.values()].some(
        (model) =>
          model.tenant_id === input.tenantId &&
          model.model_name === modelName,
      )
      if (duplicate) throw new PlatformApiError("MODEL_NAME_EXISTS", 409)
      options.state.modelSequence += 1
      const model: PublicModel = {
        tenant_id: input.tenantId,
        model_id: idFactory(options.state.modelSequence),
        model_name: modelName,
        display_name: displayName,
        resource_id: input.resourceId,
        visibility: input.value.visibility ?? "PUBLIC",
        lifecycle: "PUBLISHED",
        capabilities: input.value.capabilities ?? [...connections[0]!.profile.capabilities],
        created_at: now(),
      }
      options.state.models.set(`${model.tenant_id}:${model.model_id}`, model)
      for (const { connection, providerModel } of connections) {
        options.state.mappingSequence += 1
        const mapping: ConnectionModelMapping = {
          tenant_id: input.tenantId,
          mapping_id: mappingIdFactory(options.state.mappingSequence),
          public_model_id: model.model_id,
          resource_id: input.resourceId,
          connection_id: connection.connection_id,
          provider_model: providerModel,
          mapping_revision: 1,
          created_at: now(),
        }
        options.state.mappings.set(`${mapping.tenant_id}:${mapping.mapping_id}`, mapping)
      }
      return model
    },

    async addMapping(input) {
      const model = await this.get({ tenantId: input.tenantId, modelId: input.modelId })
      if (model.resource_id !== input.resourceId) throw new PlatformApiError("MODEL_NOT_FOUND", 404)
      const connection = await options.connections.get({
        tenantId: input.tenantId,
        resourceId: input.resourceId,
        connectionId: input.value.connection_id,
      })
      if (connection.configuration_revision !== input.value.expected_connection_revision) {
        throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
      }
      if (
        connection.status !== "READY" ||
        connection.lifecycle !== "ENABLED" ||
        connection.verification_state !== "VERIFIED"
      ) {
        throw new PlatformApiError("CONNECTION_NOT_READY", 409)
      }
      if (mappingsFor(model).some((mapping) => mapping.connection_id === connection.connection_id)) {
        throw new PlatformApiError("MODEL_MAPPING_DUPLICATE_CONNECTION", 409)
      }
      options.state.mappingSequence += 1
      const mapping: ConnectionModelMapping = {
        tenant_id: input.tenantId,
        mapping_id: mappingIdFactory(options.state.mappingSequence),
        public_model_id: input.modelId,
        resource_id: input.resourceId,
        connection_id: connection.connection_id,
        provider_model: input.value.provider_model.trim(),
        mapping_revision: 1,
        created_at: now(),
      }
      options.state.mappings.set(`${mapping.tenant_id}:${mapping.mapping_id}`, mapping)
      return mapping
    },
  }
}
