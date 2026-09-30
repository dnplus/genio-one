import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"

import { createManagementApi } from "../src/app"
import type { GatewayActivityEvent, GatewayActivityIngest } from "../src/capabilities/activities/contract"
import {
  createPostHogGatewayActivitySink,
  POSTHOG_GATEWAY_ACTIVITY_DISTINCT_ID,
} from "../src/capabilities/activities/posthog"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

type CapturedPostHogEvent = {
  url: string
  body: {
    api_key: string
    event: string
    distinct_id: string
    uuid: string
    timestamp: string
    properties: Record<string, unknown>
  }
}

function activity(overrides: Partial<GatewayActivityIngest> = {}): GatewayActivityIngest {
  return {
    correlation_id: "activity-correlation",
    resource_id: "resource-1",
    capability_id: "model.invoke",
    application_id: null,
    subject_id: null,
    acting_client_id: "gateway-client",
    session_id: null,
    entitlement_id: null,
    usage_admission_id: null,
    usage_admission_disposition: "NOT_APPLICABLE",
    usage_admission_reason: null,
    consumer_organization_id: null,
    resource_owner_organization_id: null,
    use_case_id: null,
    enforcement_point_id: "AI_GATEWAY",
    route: "MANAGED",
    method: "POST",
    path: "/v1/chat/completions",
    status_code: 200,
    outcome: "COMPLETED",
    error_code: null,
    latency_millis: 125,
    upstream_attempted: true,
    requested_model_id: "genio-chat",
    effective_model_id: "gpt-4.1",
    provider_id: "OPENAI",
    connection_id: null,
    mcp_method: "tools/call",
    mcp_tool: "mail2000__send_mail",
    mcp_backend: "mail2000",
    processor_bundle_revision: null,
    processor_request_steps: [],
    processor_response_steps: [],
    data_classifications: [],
    safety_decisions: [],
    input_tokens: 12,
    output_tokens: 7,
    total_tokens: 19,
    route_mode: null,
    route_lease_id: null,
    route_lease_reused: null,
    routing_policy_id: null,
    routing_revision: null,
    candidate_set_digest: null,
    detail_availability: "NOT_CAPTURED",
    detail_ref: null,
    detail_expires_at: null,
    occurred_at: 1_700_000_000,
    ...overrides,
  }
}

function recordedActivity(overrides: Partial<GatewayActivityIngest> = {}): GatewayActivityEvent {
  return {
    ...activity(overrides),
    tenant_id: "tenant-one",
    subject_display: null,
    downstream_identity_mode: null,
    cost_estimation_status: "NOT_APPLICABLE",
    estimated_cost_currency: null,
    estimated_cost_micros: null,
    pricing_source: null,
    pricing_version: null,
  }
}

function withoutEventIdentity(body: CapturedPostHogEvent["body"]) {
  return {
    api_key: body.api_key,
    event: body.event,
    distinct_id: body.distinct_id,
    properties: body.properties,
  }
}

async function registerRuntime(
  modules: ReturnType<typeof createInMemoryPlatformModules>,
  tenantId: string,
  runtimeId: string,
  clientId: string,
) {
  const reportPublicKeyPem = generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "pem" })
    .toString()

  await modules.runtimeControl.registerGatewayRuntime({
    tenantId,
    runtimeId,
    targetId: `${runtimeId}-target`,
    oidcClientId: clientId,
    reportKeyId: `${runtimeId}-key`,
    reportPublicKeyPem,
  })
}

async function configurePostHog(
  modules: ReturnType<typeof createInMemoryPlatformModules>,
  tenantId: string,
  projectToken: string,
) {
  await modules.postHogIntegration.update({
    tenantId,
    configuredBySubjectId: "tenant-admin",
    value: {
      enabled: true,
      host: "https://us.i.posthog.com",
      project_id: 630618,
      project_token: projectToken,
    },
  })
}

function activityRequest(
  app: Awaited<ReturnType<typeof createManagementApi>>,
  tenantId: string,
  runtimeId: string,
  token: string,
  payload: GatewayActivityIngest,
) {
  return app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/runtime-control/GATEWAY/${runtimeId}/activities`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  })
}

test("authenticated Gateway Activity projects each tenant's enabled PostHog binding", async () => {
  const originalFetch = globalThis.fetch
  const captured: CapturedPostHogEvent[] = []
  globalThis.fetch = (async (input, init) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as CapturedPostHogEvent["body"],
    })
    return new Response("", { status: 200 })
  }) as typeof fetch
  const modules = createInMemoryPlatformModules()
  let app: Awaited<ReturnType<typeof createManagementApi>> | undefined
  try {
    await Promise.all([
      registerRuntime(modules, "tenant-disabled", "runtime-disabled", "gateway-disabled"),
      registerRuntime(modules, "tenant-one", "runtime-one", "gateway-one"),
      registerRuntime(modules, "tenant-two", "runtime-two", "gateway-two"),
    ])
    await Promise.all([
      configurePostHog(modules, "tenant-one", "phc_tenant_one"),
      configurePostHog(modules, "tenant-two", "phc_tenant_two"),
    ])
    app = await createManagementApi({
      modules,
      resourceCatalog: modules.resources,
      principalAuthenticator: createStaticPrincipalAuthenticator({
        disabled: {
          tenant_id: "tenant-disabled",
          subject_id: "gateway-disabled",
          client_id: "gateway-disabled",
          role: "USER",
          organization_ids: [],
          scopes: ["genioone-gateway-runtime"],
        },
        one: {
          tenant_id: "tenant-one",
          subject_id: "gateway-one",
          client_id: "gateway-one",
          role: "USER",
          organization_ids: [],
          scopes: ["genioone-gateway-runtime"],
        },
        two: {
          tenant_id: "tenant-two",
          subject_id: "gateway-two",
          client_id: "gateway-two",
          role: "USER",
          organization_ids: [],
          scopes: ["genioone-gateway-runtime"],
        },
      }),
    })

    assert.equal((await activityRequest(
      app,
      "tenant-disabled",
      "runtime-disabled",
      "disabled",
      activity({ correlation_id: "disabled-correlation" }),
    )).statusCode, 201)
    assert.equal(captured.length, 0)

    assert.equal((await activityRequest(
      app,
      "tenant-one",
      "runtime-one",
      "one",
      activity({
        correlation_id: "not-an-actual-model",
        upstream_attempted: false,
        effective_model_id: null,
        mcp_method: null,
        mcp_tool: null,
      }),
    )).statusCode, 201)
    assert.equal(captured.length, 0)

    assert.equal((await activityRequest(
      app,
      "tenant-one",
      "runtime-one",
      "one",
      activity({ correlation_id: "tenant-one-correlation" }),
    )).statusCode, 201)
    assert.equal((await activityRequest(
      app,
      "tenant-two",
      "runtime-two",
      "two",
      activity({
        correlation_id: "tenant-two-correlation",
        mcp_method: null,
        mcp_tool: null,
        mcp_backend: null,
      }),
    )).statusCode, 201)

    assert.equal(captured.length, 3)
    assert.ok(captured.every((event) => event.url === "https://us.i.posthog.com/i/v0/e/"))
    const generation = captured.find((event) => event.body.event === "$ai_generation")
    const toolCall = captured.find((event) => event.body.event === "$mcp_tool_call")
    const isolated = captured.find((event) => event.body.api_key === "phc_tenant_two")
    assert.ok(generation)
    assert.ok(toolCall)
    assert.match(generation.body.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.match(toolCall.body.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.notEqual(generation.body.uuid, toolCall.body.uuid)
    assert.equal(generation.body.timestamp, "2023-11-14T22:13:20.000Z")
    assert.equal(toolCall.body.timestamp, "2023-11-14T22:13:20.000Z")
    assert.deepEqual(withoutEventIdentity(generation.body), {
      api_key: "phc_tenant_one",
      event: "$ai_generation",
      distinct_id: POSTHOG_GATEWAY_ACTIVITY_DISTINCT_ID,
      properties: {
        $process_person_profile: false,
        $geoip_disable: true,
        tenant_id: "tenant-one",
        resource_id: "resource-1",
        status_code: 200,
        $ai_model: "gpt-4.1",
        $ai_http_status: 200,
        $ai_provider: "OPENAI",
        $ai_latency: 0.125,
        $ai_input_tokens: 12,
        $ai_output_tokens: 7,
        $ai_total_tokens: 19,
      },
    })
    assert.deepEqual(withoutEventIdentity(toolCall.body), {
      api_key: "phc_tenant_one",
      event: "$mcp_tool_call",
      distinct_id: POSTHOG_GATEWAY_ACTIVITY_DISTINCT_ID,
      properties: {
        $process_person_profile: false,
        $geoip_disable: true,
        tenant_id: "tenant-one",
        resource_id: "resource-1",
        status_code: 200,
        $mcp_tool_name: "mail2000__send_mail",
        $mcp_duration_ms: 125,
      },
    })
    assert.equal(isolated?.body.event, "$ai_generation")
    assert.equal(isolated?.body.properties.tenant_id, "tenant-two")
    assert.equal(JSON.stringify(generation?.body).includes("tenant-one-correlation"), false)
    assert.equal("capability_id" in (generation?.body.properties ?? {}), false)
    assert.equal("$ai_trace_id" in (generation?.body.properties ?? {}), false)
  } finally {
    await app?.close()
    globalThis.fetch = originalFetch
  }
})

test("Gateway Activity direct ingest and materializer share the live PostHog sink", async () => {
  const originalFetch = globalThis.fetch
  const captured: CapturedPostHogEvent[] = []
  const modules = createInMemoryPlatformModules()
  const sharedSink = createPostHogGatewayActivitySink({
    integrations: modules.postHogIntegration,
    request: (async (input, init) => {
      captured.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as CapturedPostHogEvent["body"],
      })
      return new Response("", { status: 200 })
    }) as typeof fetch,
  })
  let materializerCaptures = 0
  let app: Awaited<ReturnType<typeof createManagementApi>> | undefined
  globalThis.fetch = (async (_input, _init): Promise<Response> => {
    throw new Error("unexpected PostHog sink")
  }) as typeof fetch
  try {
    await registerRuntime(modules, "tenant-one", "runtime-one", "gateway-one")
    await configurePostHog(modules, "tenant-one", "phc_tenant_one")
    const materializer = {
      async refresh({ tenantId }: { tenantId: string }) {
        materializerCaptures += 1
        const event = await modules.activities.get?.({
          tenantId,
          correlationId: "direct-and-materialized-correlation",
        })
        if (event) await sharedSink.capture({ event })
      },
    }
    app = await createManagementApi({
      modules: {
        ...modules,
        activityMaterializer: materializer,
        postHogGatewayActivitySink: sharedSink,
      },
      resourceCatalog: modules.resources,
      principalAuthenticator: createStaticPrincipalAuthenticator({
        admin: {
          tenant_id: "tenant-one",
          subject_id: "tenant-admin",
          client_id: "management-client",
          role: "TENANT_ADMINISTRATOR",
          organization_ids: [],
          scopes: ["genioone-management"],
        },
        runtime: {
          tenant_id: "tenant-one",
          subject_id: "gateway-one",
          client_id: "gateway-one",
          role: "USER",
          organization_ids: [],
          scopes: ["genioone-gateway-runtime"],
        },
      }),
    })

    assert.equal((await activityRequest(
      app,
      "tenant-one",
      "runtime-one",
      "runtime",
      activity({
        correlation_id: "direct-and-materialized-correlation",
        upstream_attempted: false,
        effective_model_id: null,
        provider_id: null,
      }),
    )).statusCode, 201)
    assert.equal(captured.length, 1)

    const listed = await app.inject({
      method: "GET",
      url: "/v1/tenants/tenant-one/api-activities",
      headers: { authorization: "Bearer admin" },
    })
    assert.equal(listed.statusCode, 200)
    assert.equal(materializerCaptures, 1)
    assert.equal(captured.length, 1)
  } finally {
    await app?.close()
    globalThis.fetch = originalFetch
  }
})

test("PostHog sink omits unavailable Gateway Activity values", async () => {
  const captured: CapturedPostHogEvent[] = []
  const sink = createPostHogGatewayActivitySink({
    integrations: {
      async get() {
        return {
          enabled: true,
          host: "https://us.i.posthog.com",
          project_id: 630618,
          project_token: "phc_tenant_one",
          configured_by: "tenant-admin",
          configured_at: 1_700_000_000,
        }
      },
    },
    request: (async (input, init) => {
      captured.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as CapturedPostHogEvent["body"],
      })
      return new Response("", { status: 200 })
    }) as typeof fetch,
  })

  await sink.capture({
    event: recordedActivity({
      provider_id: null,
      mcp_tool: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
    }),
  })

  assert.equal(captured.length, 1)
  const properties = captured[0]!.body.properties
  assert.equal("$ai_provider" in properties, false)
  assert.equal("$ai_input_tokens" in properties, false)
  assert.equal("$ai_output_tokens" in properties, false)
  assert.equal("$ai_total_tokens" in properties, false)
})

test("PostHog sink suppresses repeated successful Activity captures", async () => {
  const captured: CapturedPostHogEvent[] = []
  const sink = createPostHogGatewayActivitySink({
    integrations: {
      async get() {
        return {
          enabled: true,
          host: "https://us.i.posthog.com",
          project_id: 630618,
          project_token: "phc_tenant_one",
          configured_by: "tenant-admin",
          configured_at: 1_700_000_000,
        }
      },
    },
    request: (async (input, init) => {
      captured.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as CapturedPostHogEvent["body"],
      })
      return new Response("", { status: 200 })
    }) as typeof fetch,
  })
  const event = recordedActivity({
    correlation_id: "retry-correlation",
    mcp_method: null,
    mcp_tool: null,
    mcp_backend: null,
  })

  await sink.capture({ event })
  await sink.capture({ event })

  assert.equal(captured.length, 1)
  assert.match(captured[0]?.body.uuid ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(captured[0]?.body.timestamp, "2023-11-14T22:13:20.000Z")
  assert.equal(JSON.stringify(captured[0]?.body).includes(event.correlation_id), false)
})

test("PostHog sink shares an in-flight Activity capture", async () => {
  let resolveRequest: ((response: Response) => void) | undefined
  let calls = 0
  const sink = createPostHogGatewayActivitySink({
    integrations: {
      async get() {
        return {
          enabled: true,
          host: "https://us.i.posthog.com",
          project_id: 630618,
          project_token: "phc_tenant_one",
          configured_by: "tenant-admin",
          configured_at: 1_700_000_000,
        }
      },
    },
    request: (async (_input, _init) => {
      calls += 1
      return await new Promise<Response>((resolve) => { resolveRequest = resolve })
    }) as typeof fetch,
  })
  const event = recordedActivity({ mcp_method: null, mcp_tool: null, mcp_backend: null })

  const first = sink.capture({ event })
  const second = sink.capture({ event })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls, 1)
  resolveRequest?.(new Response("", { status: 200 }))
  await Promise.all([first, second])
})

test("PostHog sink retries a failed Activity capture", async () => {
  let calls = 0
  const sink = createPostHogGatewayActivitySink({
    integrations: {
      async get() {
        return {
          enabled: true,
          host: "https://us.i.posthog.com",
          project_id: 630618,
          project_token: "phc_tenant_one",
          configured_by: "tenant-admin",
          configured_at: 1_700_000_000,
        }
      },
    },
    request: (async (_input, _init) => {
      calls += 1
      return new Response("", { status: calls === 1 ? 503 : 200 })
    }) as typeof fetch,
  })
  const event = recordedActivity({ mcp_method: null, mcp_tool: null, mcp_backend: null })

  await assert.rejects(sink.capture({ event }), /PostHog capture failed \(503\)/)
  await sink.capture({ event })
  assert.equal(calls, 2)
})

test("PostHog sink suppresses irrelevant changes and captures enrichment and binding changes", async () => {
  const captured: CapturedPostHogEvent[] = []
  let host: "https://us.i.posthog.com" | "https://eu.i.posthog.com" = "https://us.i.posthog.com"
  let projectId = 630618
  let projectToken = "phc_tenant_one"
  const sink = createPostHogGatewayActivitySink({
    integrations: {
      async get() {
        return {
          enabled: true,
          host,
          project_id: projectId,
          project_token: projectToken,
          configured_by: "tenant-admin",
          configured_at: 1_700_000_000,
        }
      },
    },
    request: (async (input, init) => {
      captured.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as CapturedPostHogEvent["body"],
      })
      return new Response("", { status: 200 })
    }) as typeof fetch,
  })
  const event = recordedActivity({
    correlation_id: "enriched-correlation",
    mcp_method: null,
    mcp_tool: null,
    mcp_backend: null,
    output_tokens: null,
  })

  await sink.capture({ event })
  await sink.capture({
    event: {
      ...event,
      subject_display: {
        subject_id: "gateway-user",
        display_name: "Gateway user",
        kind: "PERSON",
      },
    },
  })
  assert.equal(captured.length, 1)
  await sink.capture({ event: { ...event, output_tokens: 8 } })
  assert.equal(captured.length, 2)
  projectToken = "phc_tenant_one_rotated"
  await sink.capture({ event })
  assert.equal(captured.length, 3)
  assert.equal(captured[2]?.body.api_key, "phc_tenant_one_rotated")
  host = "https://eu.i.posthog.com"
  projectId = 630619
  projectToken = "phc_tenant_two"
  await sink.capture({ event })

  assert.equal(captured.length, 4)
  assert.equal(captured[1]?.body.properties.$ai_output_tokens, 8)
  assert.equal(captured[3]?.url, "https://eu.i.posthog.com/i/v0/e/")
  assert.equal(captured[3]?.body.api_key, "phc_tenant_two")
})

test("PostHog transport failure leaves an authenticated Gateway Activity successful", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input, _init): Promise<Response> => {
    throw new Error("PostHog unreachable")
  }) as typeof fetch
  const modules = createInMemoryPlatformModules()
  let app: Awaited<ReturnType<typeof createManagementApi>> | undefined
  try {
    await registerRuntime(modules, "tenant-one", "runtime-one", "gateway-one")
    await configurePostHog(modules, "tenant-one", "phc_tenant_one")
    app = await createManagementApi({
      modules,
      resourceCatalog: modules.resources,
      principalAuthenticator: createStaticPrincipalAuthenticator({
        runtime: {
          tenant_id: "tenant-one",
          subject_id: "gateway-one",
          client_id: "gateway-one",
          role: "USER",
          organization_ids: [],
          scopes: ["genioone-gateway-runtime"],
        },
      }),
    })
    const payload = activity({ correlation_id: "transport-failure-correlation" })
    const response = await activityRequest(app, "tenant-one", "runtime-one", "runtime", payload)
    assert.equal(response.statusCode, 201)
    assert.equal(
      (await modules.activities.get!({ tenantId: "tenant-one", correlationId: payload.correlation_id }))?.correlation_id,
      payload.correlation_id,
    )
  } finally {
    await app?.close()
    globalThis.fetch = originalFetch
  }
})
