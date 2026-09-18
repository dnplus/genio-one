import assert from "node:assert/strict"
import test from "node:test"

import { mergeGatewayNativeResources } from "./native-resources"

test("ASR traffic policy upgrades historical buffers and rejects same-revision conflicts", () => {
  const historical = {
    apiVersion: "gateway.envoyproxy.io/v1alpha1",
    kind: "ClientTrafficPolicy",
    metadata: { name: "gateway-correlation", namespace: "default" },
    spec: { headers: { requestID: "PreserveOrGenerate" } },
  }
  const current = {
    ...historical,
    metadata: { ...historical.metadata, annotations: { "genio.one/global-contract-revision": "1" } },
    spec: { ...historical.spec, connection: { bufferLimit: "4Mi" } },
  }
  assert.deepEqual(mergeGatewayNativeResources([historical, current]), [current])
  assert.deepEqual(mergeGatewayNativeResources([current, historical]), [current])
  assert.throws(() => mergeGatewayNativeResources([
    current,
    { ...current, spec: { ...current.spec, connection: { bufferLimit: "8Mi" } } },
  ]), /GATEWAY_NATIVE_RESOURCE_CONFLICT/)
})

function envoyProxy(
  sinks: Array<Record<string, unknown>>,
  tracing?: Record<string, unknown>,
  metrics?: Record<string, unknown>,
): Record<string, any> {
  return {
    apiVersion: "gateway.envoyproxy.io/v1alpha1",
    kind: "EnvoyProxy",
    metadata: { name: "gateway-1", namespace: "default" },
    spec: {
      filterOrder: [{ name: "envoy.filters.http.ext_authz", after: "envoy.filters.http.jwt_authn" }],
      telemetry: {
        ...(tracing ? { tracing } : {}),
        ...(metrics ? { metrics } : {}),
        accessLog: {
          settings: [{
            format: { type: "JSON", json: { "x-request-id": "%REQ(X-REQUEST-ID)%" } },
            sinks,
          }],
        },
      },
    },
  }
}

test("aggregate Gateway resources compose native file and OTel sinks", () => {
  const tracing = {
    samplingRate: 100,
    provider: { type: "OpenTelemetry", backendRefs: [{ name: "otel", port: 4317 }] },
  }
  const merged = mergeGatewayNativeResources([
    envoyProxy([{ type: "File", file: { path: "/tmp/activity.jsonl" } }]),
    envoyProxy([
      { type: "File", file: { path: "/tmp/activity.jsonl" } },
      {
        type: "OpenTelemetry",
        openTelemetry: { backendRefs: [{ name: "otel", port: 4317 }] },
      },
    ], tracing),
  ])

  assert.equal(merged.length, 1)
  assert.deepEqual(
    merged[0]!.spec.telemetry.accessLog.settings[0].sinks.map(
      (sink: Record<string, unknown>) => sink.type,
    ),
    ["File", "OpenTelemetry"],
  )
  assert.deepEqual(merged[0]!.spec.telemetry.tracing, tracing)
})

test("aggregate Gateway resources collapse compatible historical access-log shapes", () => {
  const historical = envoyProxy([{
    type: "OpenTelemetry",
    openTelemetry: { backendRefs: [{ name: "otel", port: 4317 }] },
  }])
  historical.spec.telemetry.accessLog.settings[0].format.json["genio.subject.id"] =
    "%DYNAMIC_METADATA(envoy.filters.http.jwt_authn:keycloak-local:sub)%"
  historical.spec.telemetry.accessLog.settings[0].format.json["genio.client.id"] =
    "%DYNAMIC_METADATA(envoy.filters.http.jwt_authn:keycloak-local:azp)%"
  const current = envoyProxy([
    { type: "File", file: { path: "/tmp/activity.jsonl" } },
    {
      type: "OpenTelemetry",
      openTelemetry: {
        backendRefs: [{ name: "otel", port: 4317 }],
        resourceAttributes: { "service.name": "genio-one-ai-gateway" },
      },
    },
  ])
  current.spec.telemetry.accessLog.settings[0].format.json["genio.tenant.id"] =
    "%REQ(X-GENIO-TRUSTED-TENANT-ID)%"
  current.spec.telemetry.accessLog.settings[0].format.json["genio.subject.id"] =
    "%DYNAMIC_METADATA(genio.one.processor:x-genio-trusted-subject-id)%"
  current.spec.telemetry.accessLog.settings[0].format.json["genio.client.id"] =
    "%DYNAMIC_METADATA(genio.one.processor:x-genio-trusted-client-id)%"

  const [merged] = mergeGatewayNativeResources([historical, current])
  const settings = merged!.spec.telemetry.accessLog.settings
  assert.equal(settings.length, 1)
  assert.deepEqual(settings[0].format.json, {
    "x-request-id": "%REQ(X-REQUEST-ID)%",
    "genio.tenant.id": "%REQ(X-GENIO-TRUSTED-TENANT-ID)%",
    "genio.subject.id": "%DYNAMIC_METADATA(genio.one.processor:x-genio-trusted-subject-id)%",
    "genio.client.id": "%DYNAMIC_METADATA(genio.one.processor:x-genio-trusted-client-id)%",
  })
  assert.deepEqual(
    settings[0].sinks.map((sink: Record<string, unknown>) => sink.type),
    ["File", "OpenTelemetry"],
  )
  assert.deepEqual(settings[0].sinks[1].openTelemetry, {
    backendRefs: [{ name: "otel", port: 4317 }],
    resourceAttributes: { "service.name": "genio-one-ai-gateway" },
  })
})

test("aggregate Gateway resources reject conflicting access-log fields", () => {
  const left = envoyProxy([{
    type: "OpenTelemetry",
    openTelemetry: { backendRefs: [{ name: "otel", port: 4317 }] },
  }])
  const right = envoyProxy([{
    type: "OpenTelemetry",
    openTelemetry: { backendRefs: [{ name: "otel", port: 4318 }] },
  }])
  right.spec.telemetry.accessLog.settings[0].format.json["x-request-id"] =
    "%REQ(X-CORRELATION-ID)%"

  assert.throws(
    () => mergeGatewayNativeResources([left, right]),
    /GATEWAY_NATIVE_RESOURCE_CONFLICT/,
  )
})

test("aggregate Gateway resources compose compatible native tracing tags", () => {
  const merged = mergeGatewayNativeResources([
    envoyProxy([], {
      samplingRate: 100,
      provider: { type: "OpenTelemetry" },
      customTags: { correlation: { type: "RequestHeader" } },
    }),
    envoyProxy([], {
      samplingRate: 100,
      provider: { type: "OpenTelemetry" },
      customTags: { tenant: { type: "Literal", literal: { value: "tenant-1" } } },
    }),
  ])
  assert.deepEqual(merged[0]!.spec.telemetry.tracing.customTags, {
    correlation: { type: "RequestHeader" },
    tenant: { type: "Literal", literal: { value: "tenant-1" } },
  })
})

test("aggregate Gateway resources compose one compatible native metrics sink", () => {
  const metrics = {
    sinks: [{ type: "OpenTelemetry", openTelemetry: { resourceAttributes: { tenant: "tenant-1" } } }],
  }
  const merged = mergeGatewayNativeResources([
    envoyProxy([]),
    envoyProxy([], undefined, metrics),
  ])
  assert.deepEqual(merged[0]!.spec.telemetry.metrics, metrics)
})

test("aggregate Gateway resources upgrade incomplete historical EnvoyProxy defaults", () => {
  const historical = envoyProxy([])
  delete historical.spec.filterOrder
  const current = envoyProxy([])
  current.spec.provider = {
    type: "Kubernetes",
    kubernetes: { envoyService: { type: "ClusterIP" } },
  }
  current.spec.filterOrder = [
    { name: "envoy.filters.http.ext_authz", after: "envoy.filters.http.jwt_authn" },
    { name: "envoy.filters.http.ext_proc", after: "envoy.filters.http.ext_authz" },
  ]

  const [merged] = mergeGatewayNativeResources([historical, current])
  assert.deepEqual(merged!.spec.provider, current.spec.provider)
  assert.deepEqual(merged!.spec.filterOrder, [
    { name: "envoy.filters.http.ext_authz", after: "envoy.filters.http.jwt_authn" },
    { name: "envoy.filters.http.ext_proc", after: "envoy.filters.http.ext_authz" },
  ])
})

test("aggregate Gateway resources reject contradictory process-wide filter order", () => {
  const left = envoyProxy([])
  const right = envoyProxy([])
  right.spec.filterOrder = [{ name: "envoy.filters.http.ext_authz", before: "envoy.filters.http.router" }]
  assert.throws(() => mergeGatewayNativeResources([left, right]), /GATEWAY_NATIVE_RESOURCE_CONFLICT/)
})

test("aggregate Gateway resources reject conflicting native tracing settings", () => {
  assert.throws(() => mergeGatewayNativeResources([
    envoyProxy([], { samplingRate: 100 }),
    envoyProxy([], { samplingRate: 1 }),
  ]), /GATEWAY_NATIVE_RESOURCE_CONFLICT/)
})

test("aggregate Gateway resources reject conflicting native tracing tags", () => {
  assert.throws(() => mergeGatewayNativeResources([
    envoyProxy([], { samplingRate: 100, customTags: { tenant: { value: "tenant-1" } } }),
    envoyProxy([], { samplingRate: 100, customTags: { tenant: { value: "tenant-2" } } }),
  ]), /GATEWAY_NATIVE_RESOURCE_CONFLICT/)
})

test("aggregate Gateway resources reject conflicting native metrics sinks", () => {
  assert.throws(() => mergeGatewayNativeResources([
    envoyProxy([], undefined, { prometheus: { disable: true } }),
    envoyProxy([], undefined, { prometheus: { disable: false } }),
  ]), /GATEWAY_NATIVE_RESOURCE_CONFLICT/)
})

test("aggregate Gateway resources reject conflicting shared Backends", () => {
  const backend = (address: string) => ({
    apiVersion: "gateway.envoyproxy.io/v1alpha1",
    kind: "Backend",
    metadata: { name: "otel", namespace: "default" },
    spec: { endpoints: [{ ip: { address, port: 4317 } }] },
  })
  let message = ""
  assert.throws(() => {
    try {
      mergeGatewayNativeResources([backend("127.0.0.1"), backend("127.0.0.2")])
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
      throw error
    }
  }, /GATEWAY_NATIVE_RESOURCE_CONFLICT/)
  assert.doesNotMatch(message, /\u0000|\r|\n/)
})

test("aggregate GatewayConfig selects the highest explicit global contract revision", () => {
  const gatewayConfig = (value: string, revision?: string) => ({
    apiVersion: "aigateway.envoyproxy.io/v1beta1",
    kind: "GatewayConfig",
    metadata: {
      name: "genio-ai-mcp-gateway-config",
      namespace: "default",
      ...(revision ? { annotations: { "genio.one/global-contract-revision": revision } } : {}),
    },
    spec: { extProc: { kubernetes: { env: [{ name: "VALUE", value }] } } },
  })
  const current = gatewayConfig("current", "2")
  assert.deepEqual(mergeGatewayNativeResources([
    gatewayConfig("historical-a"),
    gatewayConfig("historical-b"),
    current,
  ]), [current])
  assert.throws(() => mergeGatewayNativeResources([
    current,
    gatewayConfig("conflict", "2"),
  ]), /GATEWAY_NATIVE_RESOURCE_CONFLICT/)
  assert.throws(() => mergeGatewayNativeResources([
    current,
    gatewayConfig("invalid", "next"),
  ]), /GATEWAY_NATIVE_RESOURCE_CONFLICT/)
})
