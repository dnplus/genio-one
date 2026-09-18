import { providerCredentialReferences } from "../services/shared/provider-credential-reference"
import { spawn } from "node:child_process"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { isIP } from "node:net"
import { dirname, join } from "node:path"

import { stringify } from "yaml"

import type { GatewayComponentObservation } from "../../../packages/protocol/src/gateway-release"
import { POLICY_RELEASE_FILES } from "../services/shared/policy-release"
import type { HttpFetch } from "../services/shared/http-fetch"
import { mergeGatewayNativeResources } from "./native-resources"
import { withGatewayDetailCapture } from "./detail-capture"
import type { GatewayReleaseApplier } from "./runtime"

type NativeResource = Record<string, any>

interface NativeResourceIdentity {
  apiVersion: string
  kind: string
  namespace?: string
  name: string
}

export interface KubernetesCommandInput {
  args: readonly string[]
  stdin?: string
}

export type KubernetesCommandRunner = (input: KubernetesCommandInput) => Promise<void>

export interface KubernetesGatewayApplierOptions {
  credentials?: (command: Parameters<GatewayReleaseApplier["apply"]>[0]["command"], release: Parameters<GatewayReleaseApplier["apply"]>[0]["release"]) => Promise<Array<{ profile_id: string; revision: number; namespace: string; secret_name: string; credential_json: string }>>
  stateRoot: string
  kubectl?: string
  fieldManager?: string
  readinessTimeoutMs?: number
  authorizerReadinessOrigin?: string
  processorReadinessOrigin?: string
  telemetry?: {
    name: string
    namespace?: string
    host: string
    port: number
    httpPort: number
  }
  commandRunner?: KubernetesCommandRunner
  fetch?: HttpFetch
}

interface NativeResourceInventory {
  schema_version: 1
  resources: NativeResourceIdentity[]
}

function identifier(resource: NativeResource): NativeResourceIdentity {
  const apiVersion = resource.apiVersion
  const kind = resource.kind
  const name = resource.metadata?.name
  const namespace = resource.metadata?.namespace
  if (
    typeof apiVersion !== "string" || !apiVersion ||
    typeof kind !== "string" || !kind ||
    typeof name !== "string" || !name ||
    (namespace !== undefined && (typeof namespace !== "string" || !namespace))
  ) {
    throw new Error("GATEWAY_KUBERNETES_RESOURCE_IDENTITY_INVALID")
  }
  return { apiVersion, kind, name, ...(namespace ? { namespace } : {}) }
}

function identityKey(value: NativeResourceIdentity): string {
  return `${value.apiVersion}\u0000${value.kind}\u0000${value.namespace ?? ""}\u0000${value.name}`
}

function manifest(resources: readonly NativeResource[]): string {
  return stringify({
    apiVersion: "v1",
    kind: "List",
    items: resources,
  })
}

function deletionManifest(resources: readonly NativeResourceIdentity[]): string {
  return manifest(resources.map((resource) => ({
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: {
      name: resource.name,
      ...(resource.namespace ? { namespace: resource.namespace } : {}),
    },
  })))
}

function defaultCommandRunner(binary: string): KubernetesCommandRunner {
  return ({ args, stdin }) => new Promise<void>((resolvePromise, reject) => {
    const child = spawn(binary, [...args], {
      stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "pipe"],
    })
    let diagnostic = ""
    child.stderr?.on("data", (chunk) => {
      if (diagnostic.length < 8_192) diagnostic += chunk.toString("utf8")
    })
    child.once("error", reject)
    child.once("exit", (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`kubectl exited with code ${code}: ${diagnostic.trim()}`))
    })
    if (stdin !== undefined) child.stdin?.end(stdin)
  })
}

async function atomicText(path: string, value: string, mode = 0o600): Promise<void> {
  const candidate = `${path}.candidate`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(candidate, value, { encoding: "utf8", mode })
  await rename(candidate, path)
}

async function optionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

async function loadInventory(path: string): Promise<NativeResourceInventory> {
  const text = await optionalText(path)
  if (text === null) return { schema_version: 1, resources: [] }
  const value = JSON.parse(text) as NativeResourceInventory
  if (
    value.schema_version !== 1 ||
    !Array.isArray(value.resources) ||
    value.resources.some((resource) => {
      try {
        identifier({
          apiVersion: resource.apiVersion,
          kind: resource.kind,
          metadata: { name: resource.name, namespace: resource.namespace },
        })
        return false
      } catch {
        return true
      }
    })
  ) {
    throw new Error("GATEWAY_KUBERNETES_RESOURCE_INVENTORY_INVALID")
  }
  return value
}

async function waitForSidecar(input: {
  fetch: HttpFetch
  origin: string
  releaseId: string
  timeoutMs: number
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await input.fetch(`${input.origin}/readyz`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok) {
        const body = await response.json() as Record<string, any>
        if (body.state === "READY" && body.release?.release_id === input.releaseId) return
      }
    } catch {
      // Sidecars may still be starting or reloading the new current pointer.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error(`Gateway policy sidecar did not observe release ${input.releaseId}`)
}

export function readinessWaitArgument(kind: string): string | null {
  if (kind === "Gateway") return "--for=condition=Programmed"
  if (kind === "AIGatewayRoute" || kind === "MCPRoute") {
    return "--for=condition=Accepted"
  }
  if (kind === "HTTPRoute") {
    return "--for=jsonpath={.status.parents[0].conditions[?(@.type==\"Accepted\")].status}=True"
  }
  return null
}

async function materializePolicyRelease(input: {
  stateRoot: string
  command: Parameters<GatewayReleaseApplier["apply"]>[0]["command"]
  release: Parameters<GatewayReleaseApplier["apply"]>[0]["release"]
}): Promise<string> {
  const policyRoot = join(input.stateRoot, "policy")
  const releasePath = join(policyRoot, "releases", input.release.release_id)
  await mkdir(releasePath, { recursive: true })
  await Promise.all([
    writeFile(join(releasePath, POLICY_RELEASE_FILES.manifest), input.release.manifest_jws),
    writeFile(join(releasePath, POLICY_RELEASE_FILES.authorizationBundle), input.release.authorization_bundle_jws),
    writeFile(join(releasePath, POLICY_RELEASE_FILES.processorPolicyBundle), input.release.processor_policy_jws),
    writeFile(join(releasePath, POLICY_RELEASE_FILES.gatewayRoutingArtifact), input.release.gateway_routing_artifact_jws),
    writeFile(join(releasePath, POLICY_RELEASE_FILES.verificationKeyRing), input.release.enforcement_verification_keys_json),
    writeFile(join(releasePath, POLICY_RELEASE_FILES.runtimeCommand), `${JSON.stringify(input.command)}\n`),
  ])
  return policyRoot
}

function isRouteResource(resource: NativeResourceIdentity): boolean {
  return ["HTTPRoute", "AIGatewayRoute", "MCPRoute"].includes(resource.kind)
}

function normalizeTelemetryReferences(
  value: unknown,
  telemetry: NonNullable<KubernetesGatewayApplierOptions["telemetry"]>,
): void {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    value.forEach((item) => normalizeTelemetryReferences(item, telemetry))
    return
  }
  const record = value as Record<string, unknown>
  if (record.name === telemetry.name && typeof record.port === "number") {
    record.port = telemetry.port
    if (telemetry.namespace && typeof record.namespace === "string") {
      record.namespace = telemetry.namespace
    }
  }
  Object.values(record).forEach((item) => normalizeTelemetryReferences(item, telemetry))
}

function runtimeOwnedResource(
  resource: NativeResource,
  options: KubernetesGatewayApplierOptions,
): NativeResource {
  const normalized = structuredClone(resource)
  const telemetry = options.telemetry
  const sharedComponent = normalized.metadata?.labels?.["genio.one/shared-component"]
  if (normalized.kind === "EnvoyProxy" || normalized.kind === "GatewayConfig") {
    if (normalized.metadata?.labels) {
      delete normalized.metadata.labels["app.kubernetes.io/managed-by"]
    }
  }
  if (!telemetry) return normalized
  if (
    normalized.kind === "Backend" &&
    normalized.metadata?.name === telemetry.name &&
    (normalized.metadata?.namespace ?? "default") === (telemetry.namespace ?? "default") &&
    sharedComponent === telemetry.name
  ) {
    normalized.spec = {
      endpoints: [isIP(telemetry.host)
        ? { ip: { address: telemetry.host, port: telemetry.port } }
        : { fqdn: { hostname: telemetry.host, port: telemetry.port } }],
    }
  }
  if (
    normalized.kind === "GatewayConfig" &&
    sharedComponent === "ai-gateway-config"
  ) {
    const environment = normalized.spec?.extProc?.kubernetes?.env
    if (Array.isArray(environment)) {
      for (const entry of environment) {
        if (entry?.name === "OTEL_EXPORTER_OTLP_ENDPOINT") {
          entry.value = `http://${telemetry.host}:${telemetry.httpPort}`
        }
        if (entry?.name === "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") {
          entry.value = `http://${telemetry.host}:${telemetry.httpPort}/v1/traces`
        }
      }
    }
  }
  if (normalized.kind === "EnvoyProxy") {
    normalizeTelemetryReferences(normalized.spec, telemetry)
  }
  return normalized
}

export function createKubernetesGatewayApplier(
  options: KubernetesGatewayApplierOptions,
): GatewayReleaseApplier & { close(): Promise<void> } {
  const run = options.commandRunner ?? defaultCommandRunner(options.kubectl ?? "kubectl")
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const timeoutMs = options.readinessTimeoutMs ?? 120_000
  const inventoryPath = join(options.stateRoot, "kubernetes-native-resources.json")

  async function applyAndWait(resources: readonly NativeResource[]): Promise<void> {
    if (resources.length === 0) return
    await run({
      args: [
        "apply",
        "--server-side",
        // Native resources in a signed release are owned by this Gateway
        // Runtime.  The Platform may have created an earlier projection (or
        // a local operator may have patched it), but leaving field ownership
        // split makes a valid release fail before its current pointer moves.
        "--force-conflicts",
        `--field-manager=${options.fieldManager ?? "genio-one-gateway-runtime"}`,
        "--filename=-",
      ],
      stdin: manifest(resources),
    })
    for (const resource of resources.map(identifier)) {
      const waitArgument = readinessWaitArgument(resource.kind)
      if (!waitArgument) continue
      await run({
        args: [
          "wait",
          waitArgument,
          `--timeout=${Math.ceil(timeoutMs / 1_000)}s`,
          `${resource.kind}/${resource.name}`,
          ...(resource.namespace ? ["--namespace", resource.namespace] : []),
        ],
      })
    }
  }

  return {
    async apply({ command, release }) {
      const resources = mergeGatewayNativeResources(
        withGatewayDetailCapture(
          release.projections.flatMap(({ projection }) =>
            projection.operation === "APPLY" ? projection.resources : []
          ),
          release.gateway_configuration.capture_message_content,
          command.desired_release.gateway_id,
        ).map((resource) => runtimeOwnedResource(resource as NativeResource, options)),
      )
      const credentialRefs = providerCredentialReferences(command.tenant_id, resources)
      if (credentialRefs.length) {
        if (!options.credentials) throw new Error("GATEWAY_CREDENTIAL_RESOLVER_UNAVAILABLE")
        const credentials = await options.credentials(command, release)
        if (credentials.length !== credentialRefs.length) throw new Error("GATEWAY_CREDENTIAL_MATERIAL_MISMATCH")
        const secrets = credentialRefs.map((ref) => {
          const values = credentials.filter((item) => item.profile_id === ref.profile_id && item.revision === ref.revision && item.namespace === ref.namespace && item.secret_name === ref.secret_name)
          if (values.length !== 1 || typeof values[0]!.credential_json !== "string") throw new Error("GATEWAY_CREDENTIAL_MATERIAL_MISMATCH")
          return { apiVersion: "v1", kind: "Secret", metadata: { name: ref.secret_name, namespace: ref.namespace, labels: { "app.kubernetes.io/managed-by": "genio-one-gateway-runtime" } }, type: "Opaque", data: { "service_account.json": Buffer.from(values[0]!.credential_json).toString("base64") } }
        })
        try {
          await run({ args: ["apply", "--server-side", `--field-manager=${options.fieldManager ?? "genio-one-gateway-runtime"}`, "--filename=-"], stdin: manifest(secrets) })
        } catch { throw new Error("GATEWAY_CREDENTIAL_APPLY_FAILED") }
      }
      const desiredIdentities = resources.map(identifier)
      const previousInventory = await loadInventory(inventoryPath)
      const desiredKeys = new Set(desiredIdentities.map(identityKey))
      const stale = previousInventory.resources.filter((resource) => !desiredKeys.has(identityKey(resource)))
      const policyRoot = await materializePolicyRelease({
        stateRoot: options.stateRoot,
        command,
        release,
      })
      const currentPointer = join(policyRoot, "current")

      const prerequisiteResources = resources.filter(
        (resource) => !isRouteResource(identifier(resource)),
      )
      const routeResources = resources.filter(
        (resource) => isRouteResource(identifier(resource)),
      )

      // New backends and policies are admitted before traffic can reference
      // them. The signed policy pointer then advances and both sidecars must
      // observe the exact release before any Route is created or updated.
      await applyAndWait(prerequisiteResources)
      await atomicText(currentPointer, `${release.release_id}\n`, 0o644)
      await Promise.all([
        waitForSidecar({
          fetch: fetchImplementation,
          origin: options.authorizerReadinessOrigin ?? "http://127.0.0.1:9081",
          releaseId: release.release_id,
          timeoutMs,
        }),
        waitForSidecar({
          fetch: fetchImplementation,
          origin: options.processorReadinessOrigin ?? "http://127.0.0.1:9082",
          releaseId: release.release_id,
          timeoutMs,
        }),
      ])
      await applyAndWait(routeResources)

      if (stale.length > 0) {
        await run({
          args: ["delete", "--ignore-not-found=true", "--filename=-"],
          stdin: deletionManifest(stale),
        })
      }
      await atomicText(inventoryPath, `${JSON.stringify({
        schema_version: 1,
        resources: desiredIdentities,
      } satisfies NativeResourceInventory)}\n`)
      await atomicText(join(policyRoot, "lkg"), `${release.release_id}\n`, 0o644)

      return [
        {
          component: "AI_GATEWAY",
          state: "READY",
          observed_revision: String(release.head_revision),
          payload: { active_routes: release.projection_count },
        } satisfies GatewayComponentObservation,
      ]
    },
    async close() {},
  }
}
