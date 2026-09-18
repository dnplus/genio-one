import assert from "node:assert/strict"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import { createInMemoryResourceConnectionRegistry } from "../src/capabilities/connections/memory"
import { createInMemoryOrganizationDirectory } from "../src/capabilities/organizations/memory"
import { createInMemoryProviderProfileCatalog } from "../src/capabilities/providers/memory"
import { createInMemoryResourceRegistry } from "../src/capabilities/resources/memory"
import { createResourceMemoryState } from "../src/capabilities/resources/state"

test("published Resources stage optimistic Connection lifecycle and trusted health changes", async () => {
  const tenantId = "tenant-acme"
  const now = () => 1_700_000_000
  const state = createResourceMemoryState()
  const organizations = createInMemoryOrganizationDirectory({ now })
  const organization = await organizations.create({ tenantId, display_name: "Acme", slug: "acme" })
  const resources = createInMemoryResourceRegistry({ state, organizations, now })
  const providers = createInMemoryProviderProfileCatalog({ now })
  const connections = createInMemoryResourceConnectionRegistry({
    state,
    resources,
    providers,
    now,
    verifier: { verify: () => true },
  })
  const resource = await resources.createResource({
    tenantId,
    value: {
      display_name: "Governed MCP",
      kind: "MCP",
      owner_organization_id: organization.organization_id,
      authentication_strategy: "NONE",
      environment_id: "local",
      version: "1.0.0",
      capabilities: [{ capability_id: "mcp.invoke", display_name: "Invoke" }],
      enforcement_point_id: "ai-gateway",
    },
  })
  const created = await connections.create({
    tenantId,
    resourceId: resource.resource_id,
    value: {
      display_name: "Primary",
      connection_kind: "MCP",
      endpoint: "https://primary.example.test",
      routing_priority: 10,
      region: "tw-north",
      supported_obligations: ["audit", "redaction"],
    },
  })
  const verified = await connections.verify({ tenantId, resourceId: resource.resource_id, connectionId: created.connection_id })
  assert.equal(verified.lifecycle, "ENABLED")
  assert.equal(verified.configuration_revision, 2)
  assert.deepEqual(await connections.listHealthTargets({ tenantId, gatewayId: "ai-gateway" }), [{
    resource_id: resource.resource_id,
    connection_id: created.connection_id,
    endpoint: verified.endpoint,
    credential_ref: null,
    configuration_revision: 2,
    health_state: "HEALTHY",
    health_observed_at: now(),
    health_source_revision: 1,
    certificate: {
      mode: "SYSTEM_CA",
      certificate_pem: null,
      fingerprint_sha256: null,
      subject: null,
      issuer: null,
      is_self_signed: false,
      not_before: null,
      not_after: null,
      status: "NOT_CONFIGURED",
    },
  }])

  state.resources.set(`${tenantId}:${resource.resource_id}`, { ...resource, lifecycle: "PUBLISHED" })
  const updated = await connections.update({
    tenantId,
    resourceId: resource.resource_id,
    connectionId: created.connection_id,
    value: { expected_revision: 2, routing_priority: 1 },
  })
  assert.equal(updated.routing_priority, 1)
  assert.equal(updated.configuration_revision, 3)
  await assert.rejects(
    connections.update({
      tenantId,
      resourceId: resource.resource_id,
      connectionId: created.connection_id,
      value: { expected_revision: 2, display_name: "Stale" },
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "CONNECTION_REVISION_CONFLICT",
  )

  const observed = await connections.observeHealth({
    tenantId,
    gatewayId: "gateway-ai",
    resourceId: resource.resource_id,
    connectionId: created.connection_id,
    value: { correlation_id: "health-1", source_revision: 2, state: "HEALTHY", observed_at: now() },
  })
  assert.equal(observed.health_state, "HEALTHY")
  await assert.rejects(
    connections.observeHealth({
      tenantId,
      gatewayId: "gateway-ai",
      resourceId: resource.resource_id,
      connectionId: created.connection_id,
      value: { correlation_id: "health-stale", source_revision: 2, state: "UNAVAILABLE", observed_at: now() },
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "CONNECTION_HEALTH_REVISION_CONFLICT",
  )
  const [batchObserved] = await connections.observeHealthBatch({
    tenantId,
    gatewayId: "gateway-ai",
    value: {
      correlation_id: "health-scan-1",
      observations: [{
        resource_id: resource.resource_id,
        connection_id: created.connection_id,
        source_revision: 3,
        state: "UNAVAILABLE",
        observed_at: now() + 30,
      }],
    },
  })
  assert.equal(batchObserved?.health_state, "UNAVAILABLE")
  const [batchReplay] = await connections.observeHealthBatch({
    tenantId,
    gatewayId: "gateway-ai",
    value: {
      correlation_id: "health-scan-replay",
      observations: [{
        resource_id: resource.resource_id,
        connection_id: created.connection_id,
        source_revision: 3,
        state: "HEALTHY",
        observed_at: now() + 31,
      }],
    },
  })
  assert.equal(batchReplay?.health_state, "UNAVAILABLE")

  const pending = await connections.transitionLifecycle({
    tenantId,
    resourceId: resource.resource_id,
    connectionId: created.connection_id,
    value: { correlation_id: "revoke-1", expected_revision: 3, command: "REQUEST_REVOKE" },
  })
  assert.equal(pending.lifecycle, "REVOKE_PENDING")
  assert.equal(pending.revoke_requested_after_release_revision, 0)
  await assert.rejects(
    connections.transitionLifecycle({
      tenantId,
      resourceId: resource.resource_id,
      connectionId: created.connection_id,
      value: {
        correlation_id: "revoke-stale-ack",
        expected_revision: 4,
        command: "CONFIRM_REVOKED",
        applied_release_revision: 0,
      },
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "CONNECTION_RELEASE_ACK_REQUIRED",
  )
  const revoked = await connections.transitionLifecycle({
    tenantId,
    resourceId: resource.resource_id,
    connectionId: created.connection_id,
    value: {
      correlation_id: "revoke-ack-1",
      expected_revision: 4,
      command: "CONFIRM_REVOKED",
      applied_release_revision: 8,
    },
  })
  assert.equal(revoked.lifecycle, "REVOKED")
  await assert.rejects(
    connections.remove({ tenantId, resourceId: resource.resource_id, connectionId: created.connection_id }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "PUBLISHED_RESOURCE_IMMUTABLE",
  )

  const successor = await connections.create({
    tenantId,
    resourceId: resource.resource_id,
    value: {
      display_name: "Successor",
      connection_kind: "MCP",
      endpoint: "https://successor.example.test",
      routing_priority: 0,
    },
  })
  assert.equal(successor.lifecycle, "DRAFT")
})

test("installation-owned Connections keep their singleton and lifecycle boundaries", async () => {
  const tenantId = "tenant-installed"
  const now = () => 1_700_000_000
  const state = createResourceMemoryState()
  const organizations = createInMemoryOrganizationDirectory({ now })
  const organization = await organizations.create({ tenantId, display_name: "Installed", slug: "installed" })
  const resources = createInMemoryResourceRegistry({ state, organizations, now })
  const providers = createInMemoryProviderProfileCatalog({ now })
  const connections = createInMemoryResourceConnectionRegistry({ state, resources, providers, now })
  const resource = await resources.createResource({
    tenantId,
    value: {
      display_name: "Mail2000",
      kind: "MCP",
      owner_organization_id: organization.organization_id,
      authentication_strategy: "NONE",
      environment_id: "platform",
      version: "1.0.0",
      capabilities: [{ capability_id: "mcp.invoke", display_name: "Mail2000" }],
      enforcement_point_id: "platform",
    },
  })
  const created = await connections.create({
    tenantId,
    resourceId: resource.resource_id,
    value: { display_name: "Mail2000", connection_kind: "MCP", endpoint: "https://mail.test/mcp" },
  })
  state.resources.set(`${tenantId}:${resource.resource_id}`, {
    ...resource,
    installation_owned: true,
    service_kind: "MAIL2000",
  })
  await assert.rejects(
    connections.create({
      tenantId,
      resourceId: resource.resource_id,
      value: { display_name: "Duplicate", connection_kind: "MCP", endpoint: "https://duplicate.test/mcp" },
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "INSTALLATION_OWNED_CONNECTION_SINGLETON",
  )
  await assert.rejects(
    connections.update({
      tenantId,
      resourceId: resource.resource_id,
      connectionId: created.connection_id,
      value: { expected_revision: 1, endpoint: "https://override.test/mcp" },
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "INSTALLATION_OWNED_ENDPOINT",
  )
  const disabled = await connections.transitionLifecycle({
    tenantId,
    resourceId: resource.resource_id,
    connectionId: created.connection_id,
    value: { correlation_id: "disable-installed", expected_revision: 1, command: "DISABLE" },
  })
  assert.equal(disabled.lifecycle, "DISABLED")
  await assert.rejects(
    connections.transitionLifecycle({
      tenantId,
      resourceId: resource.resource_id,
      connectionId: created.connection_id,
      value: { correlation_id: "revoke-installed", expected_revision: 2, command: "REQUEST_REVOKE" },
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "INSTALLATION_OWNED_CONNECTION_CANNOT_REVOKE",
  )
  await assert.rejects(
    connections.remove({ tenantId, resourceId: resource.resource_id, connectionId: created.connection_id }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "INSTALLATION_OWNED_CONNECTION_CANNOT_DELETE",
  )
})

test("installation-owned Resources keep identity and lifecycle under deployment control", async () => {
  const tenantId = "tenant-installed-resource"
  const now = () => 1_700_000_000
  const state = createResourceMemoryState()
  const organizations = createInMemoryOrganizationDirectory({ now })
  const owner = await organizations.create({ tenantId, display_name: "Installed", slug: "installed" })
  const successor = await organizations.create({ tenantId, display_name: "Other", slug: "other" })
  const resources = createInMemoryResourceRegistry({ state, organizations, now })
  const resource = await resources.createResource({
    tenantId,
    value: {
      display_name: "Installed Service",
      kind: "MCP",
      owner_organization_id: owner.organization_id,
      authentication_strategy: "NONE",
      environment_id: "platform",
      version: "1.0.0",
      capabilities: [{ capability_id: "mcp.invoke", display_name: "Invoke" }],
      enforcement_point_id: "platform",
    },
  })
  state.resources.set(`${tenantId}:${resource.resource_id}`, {
    ...resource,
    installation_owned: true,
    service_kind: "SERVICENOW_CSM",
  })

  await assert.rejects(
    resources.updateResource({
      tenantId,
      resourceId: resource.resource_id,
      value: { owner_organization_id: successor.organization_id },
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "INSTALLATION_OWNED_RESOURCE_IDENTITY",
  )
  await assert.rejects(
    resources.updateResource({
      tenantId,
      resourceId: resource.resource_id,
      value: { kind: "SAAS" } as never,
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "INSTALLATION_OWNED_RESOURCE_IDENTITY",
  )

  state.resources.set(`${tenantId}:${resource.resource_id}`, {
    ...state.resources.get(`${tenantId}:${resource.resource_id}`)!,
    lifecycle: "PUBLISHED",
  })
  await assert.rejects(
    resources.setLifecycle({ tenantId, resourceId: resource.resource_id, lifecycle: "DEPRECATED" }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "INSTALLATION_OWNED_RESOURCE_CANNOT_RETIRE",
  )
})

test("Genio Bot API Connections require live health on verify and every enable", async () => {
  const tenantId = "tenant-genio-bot"
  const now = () => 1_700_000_000
  const state = createResourceMemoryState()
  const organizations = createInMemoryOrganizationDirectory({ now })
  const organization = await organizations.create({ tenantId, display_name: "Platform", slug: "platform" })
  const resources = createInMemoryResourceRegistry({ state, organizations, now, idFactory: () => "genio.personal-bot" })
  const resource = await resources.createResource({
    tenantId,
    value: {
      display_name: "Genio Bot",
      kind: "MCP",
      owner_organization_id: organization.organization_id,
      authentication_strategy: "NONE",
      environment_id: "platform",
      version: "1.0.0",
      capabilities: [{ capability_id: "personal_bot.use", display_name: "Use Genio Bot" }],
      enforcement_point_id: "platform",
    },
  })
  const providers = createInMemoryProviderProfileCatalog({ now })
  let healthy = false
  const connections = createInMemoryResourceConnectionRegistry({ state, resources, providers, now, installedBotHealthCheck: () => healthy })
  const connection = await connections.create({
    tenantId,
    resourceId: "genio.personal-bot",
    value: { display_name: "Genio Bot", connection_kind: "MCP", endpoint: "http://bot.internal:5181" },
  })
  state.resources.set(`${tenantId}:${resource.resource_id}`, { ...resource, kind: "SAAS", installation_owned: true, service_kind: "GENIO_BOT" })
  state.connections.set(`${tenantId}:${connection.resource_id}:${connection.connection_id}`, { ...connection, connection_kind: "API", request_mapping: { default_action: "PASSTHROUGH", rules: [] } })

  await assert.rejects(
    connections.verify({ tenantId, resourceId: "genio.personal-bot", connectionId: connection.connection_id }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "CONNECTION_HEALTH_CHECK_FAILED",
  )
  healthy = true
  const verified = await connections.verify({ tenantId, resourceId: "genio.personal-bot", connectionId: connection.connection_id })
  assert.equal(verified.lifecycle, "ENABLED")
  const disabled = await connections.transitionLifecycle({
    tenantId,
    resourceId: "genio.personal-bot",
    connectionId: connection.connection_id,
    value: { correlation_id: "bot-disable", expected_revision: verified.configuration_revision, command: "DISABLE" },
  })
  assert.equal(disabled.lifecycle, "DISABLED")
  healthy = false
  await assert.rejects(
    connections.transitionLifecycle({
      tenantId,
      resourceId: "genio.personal-bot",
      connectionId: connection.connection_id,
      value: { correlation_id: "bot-enable", expected_revision: disabled.configuration_revision, command: "ENABLE" },
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "CONNECTION_HEALTH_CHECK_FAILED",
  )
  assert.equal((await connections.get({ tenantId, resourceId: "genio.personal-bot", connectionId: connection.connection_id })).lifecycle, "DISABLED")
})

test("installed connector Connections require their matching configuration before verify or enable", async () => {
  for (const [serviceKind, wrongKind, resourceId] of [
    ["SERVICENOW_CSM", "mail2000", "servicenow-csm"],
    ["MAIL2000", "servicenow-csm", "mail2000"],
  ] as const) {
    const tenantId = `tenant-${resourceId}`
    const now = () => 1_700_000_000
    const state = createResourceMemoryState()
    const organizations = createInMemoryOrganizationDirectory({ now })
    const organization = await organizations.create({ tenantId, display_name: "Platform", slug: "platform" })
    const resources = createInMemoryResourceRegistry({ state, organizations, now, idFactory: () => resourceId })
    const resource = await resources.createResource({
      tenantId,
      value: {
        display_name: resourceId,
        kind: "MCP",
        owner_organization_id: organization.organization_id,
        authentication_strategy: "NONE",
        environment_id: "platform",
        version: "1.0.0",
        capabilities: [{ capability_id: "mcp.invoke", display_name: "Invoke" }],
        enforcement_point_id: "platform",
      },
    })
    const providers = createInMemoryProviderProfileCatalog({ now })
    const connections = createInMemoryResourceConnectionRegistry({ state, resources, providers, now, verifier: { verify: () => true } })
    const connection = await connections.create({
      tenantId,
      resourceId: resource.resource_id,
      value: { display_name: resourceId, connection_kind: "MCP", endpoint: `https://${resourceId}.example.test/mcp` },
    })
    state.resources.set(`${tenantId}:${resource.resource_id}`, { ...resource, installation_owned: true, service_kind: serviceKind })

    await assert.rejects(
      connections.verify({ tenantId, resourceId: resource.resource_id, connectionId: connection.connection_id }),
      (error: unknown) => error instanceof PlatformApiError && error.code === "CONNECTOR_CONFIGURATION_REQUIRED",
    )
    await assert.rejects(
      connections.transitionLifecycle({
        tenantId,
        resourceId: resource.resource_id,
        connectionId: connection.connection_id,
        value: { correlation_id: `${resourceId}-enable`, expected_revision: 1, command: "ENABLE" },
      }),
      (error: unknown) => error instanceof PlatformApiError && error.code === "CONNECTOR_CONFIGURATION_REQUIRED",
    )

    state.connections.set(`${tenantId}:${resource.resource_id}:${connection.connection_id}`, {
      ...connection,
      connector_configuration: { kind: wrongKind } as never,
    })
    await assert.rejects(
      connections.verify({ tenantId, resourceId: resource.resource_id, connectionId: connection.connection_id }),
      (error: unknown) => error instanceof PlatformApiError && error.code === "CONNECTOR_CONFIGURATION_REQUIRED",
    )
  }
})
