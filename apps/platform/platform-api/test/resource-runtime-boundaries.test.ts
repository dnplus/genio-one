import assert from "node:assert/strict"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"

async function draftAiResource() {
  const modules = createInMemoryPlatformModules()
  const organization = await modules.organizations.create({
    tenantId: "tenant-acme",
    display_name: "AI Platform",
  })
  const resource = await modules.resources.createResource({
    tenantId: "tenant-acme",
    value: {
      display_name: "Corporate AI",
      kind: "LLM",
      owner_organization_id: organization.organization_id,
      authentication_strategy: "OAUTH",
      environment_id: "local",
      version: "1.0.0",
      enforcement_point_id: "ai-gateway-local",
    },
  })
  return { modules, resource }
}

test("Connection endpoints never persist embedded credentials", async () => {
  const { modules, resource } = await draftAiResource()

  await assert.rejects(
    modules.connections.create({
      tenantId: "tenant-acme",
      resourceId: resource.resource_id,
      value: {
        display_name: "Unsafe provider",
        provider_type: "OPENAI",
        endpoint: "https://api-user:raw-secret@api.openai.com/v1",
        credential_ref: "vault://tenant-acme/openai",
      },
    }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "CONNECTION_ENDPOINT_CREDENTIALS_FORBIDDEN",
  )
})

test("Draft Resource models stay out of discovery and routing", async () => {
  const { modules, resource } = await draftAiResource()
  const connection = await modules.connections.create({
    tenantId: "tenant-acme",
    resourceId: resource.resource_id,
    value: {
      display_name: "Local Ollama",
      provider_type: "OLLAMA",
      endpoint: "http://127.0.0.1:11434/v1",
    },
  })
  await modules.connections.verify({
    tenantId: "tenant-acme",
    resourceId: resource.resource_id,
    connectionId: connection.connection_id,
  })
  const failover = await modules.connections.create({
    tenantId: "tenant-acme",
    resourceId: resource.resource_id,
    value: {
      display_name: "Local Ollama failover",
      provider_type: "OLLAMA",
      endpoint: "http://127.0.0.1:11435/v1",
    },
  })
  await modules.connections.verify({
    tenantId: "tenant-acme",
    resourceId: resource.resource_id,
    connectionId: failover.connection_id,
  })
  const model = await modules.models.create({
    tenantId: "tenant-acme",
    resourceId: resource.resource_id,
    value: {
      model_name: "qwen3:8b",
      display_name: "Qwen 3 8B",
      mappings: [{
        connection_id: connection.connection_id,
        provider_model: "qwen3:8b",
      }, {
        connection_id: failover.connection_id,
        provider_model: "qwen3:8b-fallback",
      }],
      visibility: "PUBLIC",
    },
  })
  assert.deepEqual(
    (await modules.models.listMappings({
      tenantId: "tenant-acme",
      resourceId: resource.resource_id,
      publicModelId: model.model_id,
    })).map((mapping) => mapping.provider_model),
    ["qwen3:8b", "qwen3:8b-fallback"],
  )

  assert.deepEqual(await modules.models.list({ tenantId: "tenant-acme" }), [])
  assert.deepEqual(
    await modules.models.list({
      tenantId: "tenant-acme",
      includeUnpublishedResources: true,
    }),
    [model],
  )
  await assert.rejects(
    modules.modelRouter.resolve({
      tenantId: "tenant-acme",
      value: {
        subject_id: "subject-1",
        client_id: "client-1",
        public_model_id: model.model_id,
        entitled_public_model_ids: [model.model_id],
      },
    }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "NO_ELIGIBLE_MODEL",
  )
})
