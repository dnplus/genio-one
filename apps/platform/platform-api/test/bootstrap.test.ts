import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { DISTILLATION_EXTRACTOR_VERSION } from "@genioone/protocol/distillation-triage"
import { tmpdir } from "node:os"

import {
  bootstrapSubjectsFromEnvironment,
  createConfiguredManagementApi,
  gatewayProjectionRendererOptionsFromEnvironment,
  managementApiListenOptions,
} from "../src/bootstrap"

test("bootstrap accepts the established administrator scalars when JSON is absent", () => {
  assert.deepEqual(
    bootstrapSubjectsFromEnvironment({
      GENIO_ONE_BOOTSTRAP_TENANT_ID: "tenant-local",
      GENIO_ONE_BOOTSTRAP_ADMIN_SUBJECT_ID: "person-platform-admin",
      GENIO_ONE_BOOTSTRAP_ADMIN_EXTERNAL_SUBJECT_ID: "keycloak-admin-subject",
      GENIO_ONE_BOOTSTRAP_ADMIN_DISPLAY_NAME: "Local Platform Admin",
      GENIO_ONE_BOOTSTRAP_ADMIN_EMAIL: "admin@local.genio-one.invalid",
      GENIO_ONE_KEYCLOAK_IDENTITY_PROVIDER_ID: "keycloak-local",
    }),
    new Map([["tenant-local", [{
      subject_id: "person-platform-admin",
      kind: "PERSON",
      display_name: "Local Platform Admin",
      email: "admin@local.genio-one.invalid",
      role: "TENANT_ADMINISTRATOR",
      external_identities: [{
        provider_id: "keycloak-local",
        external_subject_id: "keycloak-admin-subject",
      }],
    }]]]),
  )
})

test("explicit bootstrap JSON is authoritative and retains its canonical binding", () => {
  const subjects = [{
    tenant_id: "tenant-local",
    subject_id: "person-platform-admin",
    kind: "PERSON",
    role: "TENANT_ADMINISTRATOR",
    external_identities: [{
      provider_id: "keycloak-local",
      external_subject_id: "keycloak-admin-subject",
    }],
  }]
  const configured = bootstrapSubjectsFromEnvironment({
    GENIO_ONE_BOOTSTRAP_SUBJECTS_JSON: JSON.stringify(subjects),
    GENIO_ONE_BOOTSTRAP_TENANT_ID: "wrong-legacy-tenant",
    GENIO_ONE_BOOTSTRAP_ADMIN_SUBJECT_ID: "wrong-legacy-subject",
    GENIO_ONE_BOOTSTRAP_ADMIN_EXTERNAL_SUBJECT_ID: "wrong-legacy-external-subject",
  })
  assert.deepEqual(configured, new Map([["tenant-local", [{
    subject_id: "person-platform-admin",
    kind: "PERSON",
    role: "TENANT_ADMINISTRATOR",
    external_identities: [{
      provider_id: "keycloak-local",
      external_subject_id: "keycloak-admin-subject",
    }],
  }]]]))
})

test("partial legacy bootstrap configuration fails before startup", () => {
  assert.throws(
    () => bootstrapSubjectsFromEnvironment({
      GENIO_ONE_BOOTSTRAP_TENANT_ID: "tenant-local",
      GENIO_ONE_BOOTSTRAP_ADMIN_SUBJECT_ID: "person-platform-admin",
    }),
    /GENIO_ONE_BOOTSTRAP_ADMIN_EXTERNAL_SUBJECT_ID is required/,
  )
})

test("tenant-only bootstrap configuration remains a valid seed target", () => {
  assert.deepEqual(
    bootstrapSubjectsFromEnvironment({ GENIO_ONE_BOOTSTRAP_TENANT_ID: "tenant-local" }),
    new Map(),
  )
})

test("memory development mode is explicit and never allowed in production", async () => {
  const app = await createConfiguredManagementApi({
    logger: false,
    environment: {
      GENIO_ONE_PLATFORM_API_MODE: "memory-dev",
      NODE_ENV: "development",
    },
  })
  const response = await app.inject({ method: "GET", url: "/healthz" })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    status: "ok",
    component: "genio-one-platform-api",
    api_mode: "unknown",
  })
  await app.close()

  await assert.rejects(
    () =>
      createConfiguredManagementApi({
        logger: false,
        environment: {
          GENIO_ONE_PLATFORM_API_MODE: "memory-dev",
          NODE_ENV: "production",
        },
      }),
    /memory-dev mode is forbidden/,
  )
})

test("configured memory API uses its Bot service endpoint without reading the process environment", async () => {
  const tenantId = "tenant-configured-evidence"
  const digest = "a".repeat(64)
  const principals = {
    admin: {
      tenant_id: tenantId,
      subject_id: "admin",
      client_id: "management-ui",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: [],
      scopes: ["genioone-management"],
    },
    owner: {
      tenant_id: tenantId,
      subject_id: "owner",
      client_id: "management-ui",
      role: "USER",
      organization_ids: [],
      scopes: ["genioone-management", "genioone-invocation"],
    },
    maintainer: {
      tenant_id: tenantId,
      subject_id: "maintainer",
      client_id: "management-ui",
      role: "USER",
      organization_ids: [],
      scopes: ["genioone-management"],
    },
  }
  const previousBotEndpoint = process.env.GENIO_BOT_SERVICE_ENDPOINT
  const originalFetch = globalThis.fetch
  let app: Awaited<ReturnType<typeof createConfiguredManagementApi>> | null = null
  let candidate: { knowledge_id: string; tenant_id: string; workspace_id: string | null; content_digest: string } | null = null
  let requestedUrl = ""
  try {
    delete process.env.GENIO_BOT_SERVICE_ENDPOINT
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input)
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer maintainer")
      assert.ok(candidate)
      return Response.json({
        knowledge_id: candidate.knowledge_id,
        tenant_id: candidate.tenant_id,
        workspace_id: candidate.workspace_id,
        content_digest: candidate.content_digest,
        turns: [{ turn_id: "turn-1", text: "configured evidence", truncated: false }],
      })
    }) as typeof fetch
    const configured = await createConfiguredManagementApi({
      logger: false,
      environment: {
        NODE_ENV: "development",
        GENIO_ONE_PLATFORM_API_MODE: "memory-dev",
        GENIO_ONE_MANAGEMENT_API_AUTH_MODE: "static-dev",
        GENIO_ONE_MANAGEMENT_API_PRINCIPALS_JSON: JSON.stringify(principals),
        GENIO_ONE_TYPESCRIPT_PILOT_TENANT_ID: tenantId,
        GENIO_BOT_SERVICE_ENDPOINT: "https://configured-bot.example/service",
      },
    })
    app = configured
    const adminHeaders = { authorization: "Bearer admin" }
    for (const subjectId of ["owner", "maintainer"]) {
      const subject = await configured.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/identity/subjects`,
        headers: adminHeaders,
        payload: { subject_id: subjectId, kind: "AGENT", display_name: subjectId },
      })
      assert.equal(subject.statusCode, 201)
    }
    const organization = await configured.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/organizations`,
      headers: adminHeaders,
      payload: { display_name: "Evidence" },
    })
    assert.equal(organization.statusCode, 201)
    for (const [id, name] of [["readers", "Readers"], ["contributors", "Contributors"], ["maintainers", "Maintainers"]] as const) {
      const group = await configured.inject({
        method: "PUT",
        url: `/v1/tenants/${tenantId}/access-groups/${id}`,
        headers: adminHeaders,
        payload: { expected_revision: 0, display_name: name, description: "", enabled: true },
      })
      assert.equal(group.statusCode, 200)
    }
    for (const [id, subjectIds] of [["readers", []], ["contributors", ["owner"]], ["maintainers", ["maintainer"]]] as const) {
      const members = await configured.inject({
        method: "PUT",
        url: `/v1/tenants/${tenantId}/access-groups/${id}/members`,
        headers: adminHeaders,
        payload: { expected_group_revision: 1, expected_source_revision: 0, subject_ids: subjectIds },
      })
      assert.equal(members.statusCode, 200)
    }
    const workspace = await configured.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/team-workspaces`,
      headers: adminHeaders,
      payload: {
        organization_id: (organization.json() as { organization_id: string }).organization_id,
        display_name: "Evidence workspace",
        reader_access_group_id: "readers",
        contributor_access_group_id: "contributors",
        maintainer_access_group_id: "maintainers",
      },
    })
    assert.equal(workspace.statusCode, 200)
    const marker = await configured.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/distillation-markers`,
      headers: { authorization: "Bearer owner" },
      payload: {
        bot_id: "bot-1",
        thread_id: "thread-1",
        turn_ids: ["turn-1"],
        source_revision: digest,
        content_digest: digest,
        scope_hint: "process",
        sensitivity: "standard",
        knowledge_type: "PROCEDURE",
        representation: "BOTH",
        classifier_version: "jev-distillation-1",
        extractor_version: DISTILLATION_EXTRACTOR_VERSION,
        evidence: [],
        excerpt_truncated: false,
        workspace_id: (workspace.json() as { workspace_id: string }).workspace_id,
      },
    })
    assert.equal(marker.statusCode, 200)
    const claim = await configured.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/distillation-markers/claim`,
      headers: { authorization: "Bearer owner" },
      payload: { bot_id: "bot-1", lease_owner: "configured-test" },
    })
    assert.equal(claim.statusCode, 200)
    const complete = await configured.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/distillation-markers/${(marker.json() as { marker_id: string }).marker_id}/result`,
      headers: { authorization: "Bearer owner" },
      payload: {
        lease_token: (claim.json() as { lease_token: string }).lease_token,
        outcome: "CANDIDATE_CREATED",
        content_digest: digest,
      },
    })
    assert.equal(complete.statusCode, 200)
    candidate = (complete.json() as { candidate: { knowledge_id: string; tenant_id: string; workspace_id: string | null; content_digest: string } }).candidate
    const evidence = await configured.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/knowledge-candidates/${candidate!.knowledge_id}/evidence`,
      headers: { authorization: "Bearer maintainer" },
    })
    assert.equal(evidence.statusCode, 200)
    assert.equal(requestedUrl, `https://configured-bot.example/api/knowledge-candidates/${candidate!.knowledge_id}/evidence`)
  } finally {
    globalThis.fetch = originalFetch
    if (previousBotEndpoint === undefined) delete process.env.GENIO_BOT_SERVICE_ENDPOINT
    else process.env.GENIO_BOT_SERVICE_ENDPOINT = previousBotEndpoint
    await app?.close()
  }
})

test("configured processor adapter registry is validated during memory API bootstrap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "genio-one-processor-adapters-"))
  const registryPath = join(directory, "registry.json")
  try {
    await writeFile(registryPath, JSON.stringify({
      schema_version: 1,
      adapters: [{ id: "jev", tenant_id: "tenant-local", kind: "JEV" }],
    }))
    const app = await createConfiguredManagementApi({
      logger: false,
      environment: {
        GENIO_ONE_PLATFORM_API_MODE: "memory-dev",
        NODE_ENV: "development",
        GENIO_ONE_PROCESSOR_ADAPTERS_FILE: registryPath,
      },
    })
    await app.close()

    await writeFile(registryPath, JSON.stringify({ schema_version: 1, adapters: [{}] }))
    await assert.rejects(
      () => createConfiguredManagementApi({
        logger: false,
        environment: {
          GENIO_ONE_PLATFORM_API_MODE: "memory-dev",
          NODE_ENV: "development",
          GENIO_ONE_PROCESSOR_ADAPTERS_FILE: registryPath,
        },
      }),
      /processor adapter registry is invalid/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("durable mode fails before startup when required stores or signer are absent", async () => {
  await assert.rejects(
    () =>
      createConfiguredManagementApi({
        logger: false,
        environment: {},
      }),
    /GENIO_ONE_DATABASE_URL is required/,
  )
  await assert.rejects(
    () =>
      createConfiguredManagementApi({
        logger: false,
        environment: { GENIO_ONE_DATABASE_URL: "postgres://unused" },
      }),
    /GENIO_ONE_VALKEY_URL is required/,
  )
  await assert.rejects(
    () =>
      createConfiguredManagementApi({
        logger: false,
        environment: { GENIO_ONE_PLATFORM_API_MODE: "postgres" },
      }),
    /GENIO_ONE_DATABASE_URL is required/,
  )
  await assert.rejects(
    () =>
      createConfiguredManagementApi({
        logger: false,
        environment: {
          GENIO_ONE_PLATFORM_API_MODE: "postgres",
          GENIO_ONE_DATABASE_URL: "postgres://unused",
        },
      }),
    /GENIO_ONE_VALKEY_URL is required/,
  )
  await assert.rejects(
    () =>
      createConfiguredManagementApi({
        logger: false,
        environment: {
          GENIO_ONE_PLATFORM_API_MODE: "postgres",
          GENIO_ONE_DATABASE_URL: "postgres://unused",
          GENIO_ONE_VALKEY_URL: "redis://unused",
        },
      }),
    /GENIO_ONE_GATEWAY_SIGNING_PRIVATE_KEY_FILE is required/,
  )
  await assert.rejects(
    () =>
      createConfiguredManagementApi({
        logger: false,
        environment: {
          GENIO_ONE_PLATFORM_API_MODE: "postgres",
          GENIO_ONE_DATABASE_URL: "postgres://unused",
          GENIO_ONE_VALKEY_URL: "redis://unused",
          GENIO_ONE_GATEWAY_SIGNING_PRIVATE_KEY_FILE: "/unused-projection.pem",
        },
      }),
    /GENIO_ONE_RUNTIME_COMMAND_SIGNING_PRIVATE_KEY_FILE is required/,
  )
  await assert.rejects(
    () =>
      createConfiguredManagementApi({
        logger: false,
        environment: {
          GENIO_ONE_PLATFORM_API_MODE: "postgres",
          GENIO_ONE_DATABASE_URL: "postgres://unused",
          GENIO_ONE_VALKEY_URL: "redis://unused",
          GENIO_ONE_GATEWAY_SIGNING_PRIVATE_KEY_FILE: "/unused-projection.pem",
          GENIO_ONE_RUNTIME_COMMAND_SIGNING_PRIVATE_KEY_FILE: "/unused-runtime-command.pem",
        },
      }),
    /GENIO_ONE_POLICY_ARTIFACT_SIGNING_PRIVATE_KEY_FILE is required/,
  )
  await assert.rejects(
    () =>
      createConfiguredManagementApi({
        logger: false,
        environment: {
          GENIO_ONE_PLATFORM_API_MODE: "postgres",
          GENIO_ONE_DATABASE_URL: "postgres://unused",
          GENIO_ONE_VALKEY_URL: "redis://unused",
          GENIO_ONE_GATEWAY_SIGNING_PRIVATE_KEY_FILE: "/unused-projection.pem",
          GENIO_ONE_RUNTIME_COMMAND_SIGNING_PRIVATE_KEY_FILE: "/unused-runtime-command.pem",
          GENIO_ONE_POLICY_ARTIFACT_SIGNING_PRIVATE_KEY_FILE: "/unused-policy-artifact.pem",
        },
      }),
    /GENIO_ONE_RELEASE_ROOT_SIGNING_PRIVATE_KEY_FILE is required/,
  )
})

test("production durable mode refuses to start without OIDC authentication", async () => {
  await assert.rejects(
    () =>
      createConfiguredManagementApi({
        logger: false,
        environment: {
          NODE_ENV: "production",
          GENIO_ONE_PLATFORM_API_MODE: "postgres",
          GENIO_ONE_DATABASE_URL: "postgres://unused",
          GENIO_ONE_VALKEY_URL: "redis://unused",
          GENIO_ONE_GATEWAY_SIGNING_PRIVATE_KEY_FILE: "/not-read-before-auth-check.pem",
        },
      }),
    /AUTH_MODE=oidc is required in production/,
  )
})

test("listen options validate the port instead of accepting a partial number", () => {
  assert.deepEqual(managementApiListenOptions({}), {
    host: "127.0.0.1",
    port: 58_082,
  })
  assert.throws(
    () => managementApiListenOptions({ GENIO_ONE_MANAGEMENT_API_PORT: "58082junk" }),
    /valid TCP port/,
  )
})

test("Gateway projection sidecar targets are explicit deployment inputs", () => {
  assert.deepEqual(gatewayProjectionRendererOptionsFromEnvironment({}), {
    namespace: "default",
    aigwRootPrefix: "/",
    extAuth: { name: "genio-one-authorizer", port: 8081 },
    processor: { name: "genio-one-processor-http", port: 8182 },
    processorGrpc: { name: "genio-one-processor", port: 8082 },
  })
  assert.deepEqual(
    gatewayProjectionRendererOptionsFromEnvironment({
      GENIO_ONE_GATEWAY_NAMESPACE: "genio-canary",
      GENIO_ONE_AIGW_ROOT_PREFIX: "/ai",
      GENIO_ONE_GATEWAY_EXT_AUTH_BACKEND_NAME: "release-authorizer",
      GENIO_ONE_GATEWAY_EXT_AUTH_BACKEND_PORT: "18081",
      GENIO_ONE_GATEWAY_PROCESSOR_BACKEND_NAME: "release-processor",
      GENIO_ONE_GATEWAY_PROCESSOR_BACKEND_PORT: "18182",
      GENIO_ONE_GATEWAY_PROCESSOR_GRPC_BACKEND_NAME: "release-processor-grpc",
      GENIO_ONE_GATEWAY_PROCESSOR_GRPC_BACKEND_PORT: "18082",
      GENIO_ONE_GATEWAY_OTEL_BACKEND_NAME: "release-otel",
      GENIO_ONE_GATEWAY_OTEL_HOST: "otel.monitoring.svc.cluster.local",
      GENIO_ONE_GATEWAY_OTEL_PORT: "14317",
    }),
    {
      namespace: "genio-canary",
      aigwRootPrefix: "/ai",
      extAuth: { name: "release-authorizer", port: 18081 },
      processor: { name: "release-processor", port: 18182 },
      processorGrpc: { name: "release-processor-grpc", port: 18082 },
      telemetry: {
        name: "release-otel",
        host: "otel.monitoring.svc.cluster.local",
        port: 14317,
        httpPort: 4318,
      },
    },
  )
  assert.throws(
    () => gatewayProjectionRendererOptionsFromEnvironment({
      GENIO_ONE_GATEWAY_EXT_AUTH_BACKEND_PORT: "8081junk",
    }),
    /valid TCP port/,
  )
})
