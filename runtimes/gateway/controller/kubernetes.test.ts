import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { parse } from "yaml"

import {
  createKubernetesGatewayApplier,
  readinessWaitArgument,
  type KubernetesCommandInput,
} from "./kubernetes"

function release(releaseId: string, headRevision: number, gatewayName: string) {
  return {
    command: {
      tenant_id: "tenant-1",
      runtime_id: "runtime-1",
      command_id: `command-${releaseId}`,
      desired_release: { gateway_id: "gateway-1" },
    },
    release: {
      release_id: releaseId,
      head_revision: headRevision,
      projection_count: 1,
      manifest_jws: "manifest",
      authorization_bundle_jws: "authorization",
      processor_policy_jws: "processor",
      gateway_routing_artifact_jws: "routing",
      enforcement_verification_keys_json: "{}",
      gateway_configuration: { capture_message_content: false },
      projections: [{
        projection: {
          operation: "APPLY",
          resources: [{
            apiVersion: "gateway.networking.k8s.io/v1",
            kind: "Gateway",
            metadata: { name: gatewayName, namespace: "genio-one" },
            spec: {},
          }, {
            apiVersion: "gateway.networking.k8s.io/v1",
            kind: "HTTPRoute",
            metadata: { name: `${gatewayName}-route`, namespace: "genio-one" },
            spec: {},
          }],
        },
      }],
    },
  } as any
}

test("Kubernetes applier advances policy pointers and removes stale native resources", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-gateway-runtime-"))
  const commands: KubernetesCommandInput[] = []
  let expectedRelease = "release-1"
  const applier = createKubernetesGatewayApplier({
    stateRoot,
    commandRunner: async (input) => {
      if (input.args[0] === "apply") {
        assert.ok(input.args.includes("--server-side"))
        assert.ok(input.args.includes("--force-conflicts"))
      }
      if (input.args[0] === "apply" && input.stdin?.includes("kind: HTTPRoute")) {
        assert.equal(
          await readFile(join(stateRoot, "policy", "current"), "utf8"),
          `${expectedRelease}\n`,
        )
      }
      commands.push(structuredClone(input))
    },
    fetch: async () => new Response(JSON.stringify({
      state: "READY",
      release: { release_id: expectedRelease },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  })

  await applier.apply(release("release-1", 1, "gateway-old"))
  expectedRelease = "release-2"
  const components = await applier.apply(release("release-2", 2, "gateway-new"))
  assert.ok(components)

  assert.equal(
    await readFile(join(stateRoot, "policy", "current"), "utf8"),
    "release-2\n",
  )
  assert.equal(
    await readFile(join(stateRoot, "policy", "lkg"), "utf8"),
    "release-2\n",
  )
  assert.equal(components[0]?.state, "READY")
  assert.equal(components[0]?.observed_revision, "2")
  assert.equal(commands.filter((command) => command.args[0] === "apply").length, 4)
  assert.equal(commands.filter((command) => command.args[0] === "wait").length, 4)
  const deletion = commands.find((command) => command.args[0] === "delete")
  assert.match(deletion?.stdin ?? "", /name: gateway-old/)
  assert.doesNotMatch(deletion?.stdin ?? "", /name: gateway-new/)
})

test("native and Gateway API routes use their actual Accepted condition shape", () => {
  assert.equal(
    readinessWaitArgument("MCPRoute"),
    "--for=condition=Accepted",
  )
  assert.equal(
    readinessWaitArgument("AIGatewayRoute"),
    "--for=condition=Accepted",
  )
  assert.equal(
    readinessWaitArgument("HTTPRoute"),
    "--for=jsonpath={.status.parents[0].conditions[?(@.type==\"Accepted\")].status}=True",
  )
})

test("Kubernetes applier keeps LKG and does not activate routes when sidecars reject a release", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-gateway-runtime-fail-closed-"))
  const commands: KubernetesCommandInput[] = []
  let expectedRelease = "release-1"
  let sidecarsReady = true
  const applier = createKubernetesGatewayApplier({
    stateRoot,
    readinessTimeoutMs: 1,
    commandRunner: async (input) => {
      commands.push(structuredClone(input))
    },
    fetch: async () => sidecarsReady
      ? new Response(JSON.stringify({
          state: "READY",
          release: { release_id: expectedRelease },
        }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(null, { status: 503 }),
  })

  await applier.apply(release("release-1", 1, "gateway-old"))
  expectedRelease = "release-2"
  sidecarsReady = false
  const commandOffset = commands.length
  await assert.rejects(
    () => applier.apply(release("release-2", 2, "gateway-new")),
    /did not observe release release-2/,
  )

  assert.equal(
    await readFile(join(stateRoot, "policy", "current"), "utf8"),
    "release-2\n",
  )
  assert.equal(
    await readFile(join(stateRoot, "policy", "lkg"), "utf8"),
    "release-1\n",
  )
  const failedCommands = commands.slice(commandOffset)
  assert.equal(
    failedCommands.filter((command) =>
      command.args[0] === "apply" && command.stdin?.includes("kind: HTTPRoute")
    ).length,
    0,
  )
  assert.equal(failedCommands.filter((command) => command.args[0] === "delete").length, 0)
})

test("Kubernetes Runtime owns telemetry endpoints and keeps payload capture on the bounded extProc seam", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-gateway-runtime-telemetry-"))
  const commands: KubernetesCommandInput[] = []
  const input = release("release-telemetry", 3, "gateway-telemetry")
  input.release.gateway_configuration.capture_message_content = true
  const sharedResources = (host: string, grpcPort: number, httpPort: number) => [{
    apiVersion: "gateway.envoyproxy.io/v1alpha1",
    kind: "Backend",
    metadata: {
      name: "genio-one-otel-collector",
      namespace: "default",
      labels: { "genio.one/shared-component": "genio-one-otel-collector" },
    },
    spec: { endpoints: [{ fqdn: { hostname: host, port: grpcPort } }] },
  }, {
    apiVersion: "aigateway.envoyproxy.io/v1alpha1",
    kind: "GatewayConfig",
    metadata: {
      name: "gateway-1-config",
      namespace: "default",
      labels: { "genio.one/shared-component": "ai-gateway-config" },
    },
    spec: {
      extProc: {
        kubernetes: {
          env: [{
            name: "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
            value: "false",
          }, {
            name: "OTEL_EXPORTER_OTLP_ENDPOINT",
            value: `http://${host}:${httpPort}`,
          }, {
            name: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            value: `http://${host}:${httpPort}/v1/traces`,
          }],
        },
      },
    },
  }, {
    apiVersion: "gateway.envoyproxy.io/v1alpha1",
    kind: "EnvoyProxy",
    metadata: { name: "gateway-1", namespace: "default" },
    spec: {
      telemetry: {
        tracing: {
          provider: {
            type: "OpenTelemetry",
            backendRefs: [{ name: "genio-one-otel-collector", port: grpcPort }],
          },
        },
        accessLog: {
          settings: [{
            format: { type: "JSON", json: { correlation: "%REQ(X-REQUEST-ID)%" } },
            sinks: [{
              type: "OpenTelemetry",
              openTelemetry: {
                backendRefs: [{ name: "genio-one-otel-collector", port: grpcPort }],
              },
            }],
          }],
        },
      },
    },
  }]
  input.release.projection_count = 2
  input.release.projections = [{
    projection: { operation: "APPLY", resources: sharedResources("old.invalid", 14317, 14318) },
  }, {
    projection: { operation: "APPLY", resources: sharedResources("new.invalid", 24317, 24318) },
  }]
  const applier = createKubernetesGatewayApplier({
    stateRoot,
    telemetry: {
      name: "genio-one-otel-collector",
      host: "genio-one-otel-collector.genio-one.svc.cluster.local",
      port: 4317,
      httpPort: 4318,
    },
    commandRunner: async (command) => {
      commands.push(structuredClone(command))
    },
    fetch: async () => new Response(JSON.stringify({
      state: "READY",
      release: { release_id: "release-telemetry" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  })

  await applier.apply(input)

  const applied = commands.find((command) => command.args[0] === "apply")?.stdin ?? ""
  assert.equal((applied.match(/kind: Backend/g) ?? []).length, 1)
  assert.equal((applied.match(/kind: GatewayConfig/g) ?? []).length, 1)
  assert.equal((applied.match(/kind: EnvoyProxy/g) ?? []).length, 1)
  assert.match(applied, /hostname: genio-one-otel-collector\.genio-one\.svc\.cluster\.local/)
  assert.match(applied, /http:\/\/genio-one-otel-collector\.genio-one\.svc\.cluster\.local:4318\/v1\/traces/)
  assert.match(applied, /name: OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT\n\s+value: "false"/)
  assert.doesNotMatch(applied, /old\.invalid|new\.invalid|14317|14318|24317|24318/)
})

test("shared Gateway resources retain deployment ownership without injecting global credentials", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-gateway-ownership-"))
  const commands: KubernetesCommandInput[] = []
  const input = release("release-ownership", 1, "gateway-1")
  const environment = [{ name: "OTEL_RESOURCE_ATTRIBUTES", value: "service.name=genio-one" }]
  input.release.projections[0].projection.resources = [{
    apiVersion: "gateway.envoyproxy.io/v1alpha1",
    kind: "EnvoyProxy",
    metadata: { name: "gateway-1", namespace: "genio-one", labels: { "app.kubernetes.io/managed-by": "genio-one-platform" } },
    spec: { provider: { type: "Kubernetes", kubernetes: { envoyService: { type: "ClusterIP" } } } },
  }, {
    apiVersion: "aigateway.envoyproxy.io/v1beta1",
    kind: "GatewayConfig",
    metadata: { name: "gateway-1-config", namespace: "genio-one", labels: {
      "app.kubernetes.io/managed-by": "genio-one-platform",
      "genio.one/shared-component": "ai-gateway-config",
    } },
    spec: { extProc: { kubernetes: { env: environment } } },
  }]
  const applier = createKubernetesGatewayApplier({
    stateRoot,
    commandRunner: async (command) => { commands.push(structuredClone(command)) },
    fetch: async () => new Response(JSON.stringify({ state: "READY", release: { release_id: "release-ownership" } })),
  })
  await applier.apply(input)
  const items = parse(commands.find((command) => command.args[0] === "apply")!.stdin!).items
  for (const item of items) assert.equal(item.metadata.labels["app.kubernetes.io/managed-by"], undefined)
  const config = items.find((item: any) => item.kind === "GatewayConfig")
  assert.deepEqual(config.spec.extProc.kubernetes.env, environment)
  assert.equal(input.release.projections[0].projection.resources[0].metadata.labels["app.kubernetes.io/managed-by"], "genio-one-platform")
  assert.equal(environment.length, 1)
  environment.push({ name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/existing/credentials.json" })
  commands.length = 0
  await applier.apply(input)
  const again = parse(commands.find((command) => command.args[0] === "apply")!.stdin!).items.find((item: any) => item.kind === "GatewayConfig")
  assert.deepEqual(again.spec.extProc.kubernetes.env, environment)
})

test("Gateway applies profile credentials before routes and never writes them to its release inventory", async () => {
  const { providerCredentialSecretName } = await import("../services/shared/provider-credential-reference")
  const { readdir, rm } = await import("node:fs/promises")
  const stateRoot = await mkdtemp(join(tmpdir(), "gateway-credential-test-"))
  const name = providerCredentialSecretName("tenant-1", "profile-1", 2)
  const input = release("credential-release", 1, "gateway-1")
  input.release.projections[0].projection.resources.push({ apiVersion: "aigateway.envoyproxy.io/v1alpha1", kind: "BackendSecurityPolicy", metadata: { name: "policy", namespace: "genio-one", annotations: { "genio.one/credential-material-profile": "profile-1", "genio.one/credential-material-revision": "2" } }, spec: { gcpCredentials: { credentialsFile: { secretRef: { name, namespace: "genio-one" } } } } })
  const commands: KubernetesCommandInput[] = []
  const material = '{"test-secret":"never-write-to-inventory"}'
  const credential = { profile_id: "profile-1", revision: 2, namespace: "genio-one", secret_name: name, credential_json: material }
  const make = (fail: boolean) => createKubernetesGatewayApplier({ stateRoot, credentials: async () => [credential], commandRunner: async (command) => {
    commands.push(command)
    if (fail && command.stdin?.includes("kind: Secret")) throw new Error(material)
  }, fetch: async () => new Response(JSON.stringify({ state: "READY", release: { release_id: "credential-release" } })) })
  try {
    await assert.rejects(make(true).apply(input), /GATEWAY_CREDENTIAL_APPLY_FAILED/)
    assert.equal(commands.length, 1)
    commands.length = 0
    await make(false).apply(input)
    const secret = parse(commands[0]!.stdin!).items[0]
    assert.equal(Buffer.from(secret.data["service_account.json"], "base64").toString(), material)
    assert.ok(commands.findIndex((command) => command.stdin?.includes("kind: HTTPRoute")) > 0)
    async function scan(path: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name)
        if (entry.isDirectory()) await scan(child)
        else assert.doesNotMatch(await readFile(child, "utf8"), /never-write-to-inventory|service_account.json/)
      }
    }
    await scan(stateRoot)
  } finally { await rm(stateRoot, { recursive: true, force: true }) }
})
