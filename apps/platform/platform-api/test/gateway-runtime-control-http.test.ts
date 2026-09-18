import assert from "node:assert/strict"
import { generateKeyPairSync, sign as signPayload } from "node:crypto"
import test from "node:test"

import fastifyWebsocket from "@fastify/websocket"
import Fastify from "fastify"
import WebSocket from "ws"

import {
  GATEWAY_RELEASE_PACKAGE_SCHEMA_VERSION,
  type GatewayReleasePackage,
} from "../src/capabilities/gateway-policy-release/package"
import { createDurableEd25519Signer } from "../src/capabilities/gateway-projection/signer"
import type { GatewayRuntimeCommand } from "../../../../packages/protocol/src/gateway-release"
import { RUNTIME_PROTOCOL_SCHEMA_VERSION } from "../../../../packages/protocol/src/gateway-release"
import { gatewayAggregateRuntimeControlHttp } from "../src/capabilities/gateway-runtime-control/http"
import { createInMemoryGatewayAggregateRuntimeControlStore } from "../src/capabilities/gateway-runtime-control/memory"
import {
  runtimeProtocolDigest,
  runtimeProtocolSignaturePayload,
} from "../src/capabilities/runtime-control/gateway-release-integrity"
import {
  createInMemoryRuntimeControlStore,
} from "../src/capabilities/runtime-control/memory"

const TENANT_ID = "tenant-http-runtime"
const RUNTIME_ID = "gateway-http-runtime"
const GATEWAY_ID = "ai-gateway"
const RELEASE_ID = "release-a"
const PACKAGE_DIGEST = "a".repeat(64)

function keyPair() {
  const { privateKey } = generateKeyPairSync("ed25519")
  const signer = createDurableEd25519Signer({
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  })
  return { signer, privateKey }
}

function releasePackage(): GatewayReleasePackage {
  return {
    schema_version: GATEWAY_RELEASE_PACKAGE_SCHEMA_VERSION,
    tenant_id: TENANT_ID,
    runtime_id: RUNTIME_ID,
    gateway_id: GATEWAY_ID,
    release_id: RELEASE_ID,
    head_revision: 1,
    package_digest: PACKAGE_DIGEST,
    projection_count: 0,
    manifest_jws: "manifest.jws.value",
    authorization_bundle_jws: "authorization.jws.value",
    processor_policy_jws: "processor.jws.value",
    gateway_routing_artifact_jws: "routing.jws.value",
    enforcement_verification_keys_json: '{"schema_version":1,"keys":[]}',
    gateway_configuration: { capture_message_content: false },
    projections: [],
  }
}

function signedReport(
  command: GatewayRuntimeCommand,
  runtime: ReturnType<typeof keyPair>,
): Record<string, unknown> {
  const unsigned = {
    schema_version: RUNTIME_PROTOCOL_SCHEMA_VERSION,
    message_type: "REPORT" as const,
    tenant_id: command.tenant_id,
    runtime_id: command.runtime_id,
    report_id: `report-${command.command_id}`,
    command_id: command.command_id,
    revision: command.revision,
    digest: "0".repeat(64),
    signature: {
      algorithm: "Ed25519" as const,
      key_id: runtime.signer.keyId,
      value: "placeholder",
    },
    runtime_kind: "GATEWAY" as const,
    observed_status: {
      state: "READY" as const,
      applied_release: command.desired_release,
      components: [
        {
          component: "AI_GATEWAY" as const,
          state: "READY" as const,
          observed_revision: command.revision,
        },
        {
          component: "AUTHORIZER" as const,
          state: "READY" as const,
          observed_revision: command.revision,
        },
        {
          component: "PROCESSOR" as const,
          state: "READY" as const,
          observed_revision: command.revision,
        },
      ],
    },
  }
  const digest = runtimeProtocolDigest(unsigned)
  const digestBearing = { ...unsigned, digest }
  const signature = signPayload(
    null,
    Buffer.from(runtimeProtocolSignaturePayload(digestBearing)),
    runtime.privateKey,
  ).toString("base64url")
  return {
    ...digestBearing,
    signature: { ...unsigned.signature, value: signature },
  }
}

async function fixture(options: Partial<Parameters<typeof gatewayAggregateRuntimeControlHttp>[1]> = {}) {
  const platform = keyPair()
  const runtime = keyPair()
  const registrations = createInMemoryRuntimeControlStore()
  await registrations.registerGatewayRuntime({
    tenantId: TENANT_ID,
    runtimeId: RUNTIME_ID,
    targetId: GATEWAY_ID,
    oidcClientId: "gateway-client-runtime",
    reportKeyId: runtime.signer.keyId,
    reportPublicKeyPem: runtime.signer.publicKeyPem,
  })
  const store = createInMemoryGatewayAggregateRuntimeControlStore({
    registrations,
    signer: platform.signer,
    idFactory: (prefix, sequence) => `${prefix}-${sequence}`,
  })
  const app = Fastify({ logger: false })
  await app.register(fastifyWebsocket)
  await app.register(gatewayAggregateRuntimeControlHttp, {
    store,
    registrations,
    packages: {
      async getPackage(input) {
        return input.tenantId === TENANT_ID &&
          input.runtimeId === RUNTIME_ID &&
          input.releaseId === RELEASE_ID &&
          input.headRevision === 1
          ? releasePackage()
          : null
      },
    },
    authorizeRuntime: async () => true,
    pollIntervalMs: 10,
    leaseTtlSeconds: 3,
    leaseOwnerId: "runtime-http-test-owner",
    leaseIdFactory: () => "runtime-http-test-lease",
    ...options,
  })
  return { app, store, runtime, registrations }
}

async function negotiate(app: Awaited<ReturnType<typeof fixture>>["app"]) {
  const response = await app.inject({
    method: "PUT",
    url: `/v1/tenants/${TENANT_ID}/runtime-control/GATEWAY/${RUNTIME_ID}/capabilities`,
    payload: {
      protocol_versions: ["genio.one.runtime.v1"],
      preferred_protocol_version: "genio.one.runtime.v1",
      delivery_mode: "AGGREGATE_RELEASE",
    },
  })
  assert.equal(response.statusCode, 200, response.body)
}

async function enqueue(store: Awaited<ReturnType<typeof fixture>>["store"], projectionCount = 0) {
  return store.enqueueGatewayRelease({
    tenantId: TENANT_ID,
    runtimeId: RUNTIME_ID,
    release: {
      schema_version: "genio.one.gateway-release-ref.v1",
      release_id: RELEASE_ID,
      gateway_id: GATEWAY_ID,
      head_revision: 1,
      package_digest: PACKAGE_DIGEST,
      projection_count: projectionCount,
    },
  })
}

function waitForCommand(socket: WebSocket): Promise<GatewayRuntimeCommand> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for runtime command")), 2_000)
    socket.once("message", (data) => {
      clearTimeout(timeout)
      resolve(JSON.parse(data.toString("utf8")) as GatewayRuntimeCommand)
    })
  })
}

test("runtime capability negotiation and command-bound package fetch are isolated", async () => {
  const { app, store } = await fixture()
  await app.ready()
  try {
    await negotiate(app)
    const command = await enqueue(store)
    const fetched = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/runtime-control/GATEWAY/${RUNTIME_ID}/aggregate/releases/${RELEASE_ID}/package?command_id=${command.command_id}`,
    })
    assert.equal(fetched.statusCode, 200, fetched.body)
    assert.equal(fetched.headers.etag, `\"${PACKAGE_DIGEST}\"`)
    assert.equal(fetched.json().projection_count, 0)

    const wrongCommand = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/runtime-control/GATEWAY/${RUNTIME_ID}/aggregate/releases/${RELEASE_ID}/package?command_id=unknown`,
    })
    assert.equal(wrongCommand.statusCode, 403)
  } finally {
    await app.close()
  }
})

test("runtime HTTP heartbeat claims the same runtime session lease used by inventory", async () => {
  const { app, registrations } = await fixture()
  await app.ready()
  try {
    await negotiate(app)
    const response = await app.inject({
      method: "PUT",
      url: `/v1/tenants/${TENANT_ID}/runtime-control/GATEWAY/${RUNTIME_ID}/aggregate/heartbeat`,
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().runtime_id, RUNTIME_ID)
    assert.ok(response.json().expires_at > 0)
    assert.ok(await registrations.getGatewaySessionLease({
      tenantId: TENANT_ID,
      runtimeId: RUNTIME_ID,
    }))
  } finally {
    await app.close()
  }
})

test("runtime websocket sends only the release reference and records READY", async () => {
  const { app, store, runtime } = await fixture()
  await app.ready()
  await app.listen({ port: 0, host: "127.0.0.1" })
  const address = app.server.address()
  assert.ok(address && typeof address === "object")
  let socket: WebSocket | undefined
  try {
    await negotiate(app)
    const record = await enqueue(store)
    socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/tenants/${TENANT_ID}/runtime-control/GATEWAY/${RUNTIME_ID}/aggregate/connect`,
    )
    await new Promise<void>((resolve, reject) => {
      socket?.once("open", resolve)
      socket?.once("error", reject)
    })
    const command = await waitForCommand(socket)
    assert.equal(command.command_id, record.command_id)
    assert.equal(command.desired_release.release_id, RELEASE_ID)
    assert.equal("projections" in command, false)

    socket.send(JSON.stringify(signedReport(command, runtime)))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const observed = await store.getLatestGatewayReleaseObserved({
      tenantId: TENANT_ID,
      runtimeKind: "GATEWAY",
      runtimeId: RUNTIME_ID,
    })
    assert.equal(observed?.applied_release?.release_id, RELEASE_ID)
    assert.equal((await store.getGatewayReleaseCommand({
      tenantId: TENANT_ID,
      runtimeKind: "GATEWAY",
      runtimeId: RUNTIME_ID,
      commandId: command.command_id,
    }))?.state, "ACKNOWLEDGED")
  } finally {
    socket?.close()
    await app.close()
  }
})

test("runtime websocket fails closed before capability negotiation", async () => {
  const { app } = await fixture()
  await app.ready()
  await app.listen({ port: 0, host: "127.0.0.1" })
  const address = app.server.address()
  assert.ok(address && typeof address === "object")
  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/v1/tenants/${TENANT_ID}/runtime-control/GATEWAY/${RUNTIME_ID}/aggregate/connect`,
  )
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for socket close")), 2_000)
      socket.once("close", (value) => {
        clearTimeout(timeout)
        resolve(value)
      })
      socket.once("error", () => undefined)
    })
    assert.equal(code, 1008)
  } finally {
    socket.close()
    await app.close()
  }
})

test("credential delivery requires the authorized runtime command and returns only pinned release references", async () => {
  const { providerCredentialSecretName } = await import("../../../../runtimes/gateway/services/shared/provider-credential-reference")
  const { createInMemoryProviderCredentialProfileStore } = await import("../src/capabilities/provider-credentials/memory")
  const credentials = createInMemoryProviderCredentialProfileStore()
  const material = JSON.stringify({ type: "authorized_user", client_id: "client", client_secret: "secret", refresh_token: "refresh" })
  const profile = await credentials.create({ tenantId: TENANT_ID, createdBySubjectId: "admin", value: { profile_id: "profile", display_name: "ADC", owner_organization_id: "org", credential_material: material, strategy: { kind: "RUNTIME_IDENTITY", adapter: "GCP_APPLICATION_DEFAULT", parameters: { project_name: "project", region: "us-central1" } } } })
  const value = releasePackage()
  value.projection_count = 1
  value.projections = [{ projection: { operation: "APPLY", resources: [{ kind: "BackendSecurityPolicy", metadata: { namespace: "genio-one", annotations: { "genio.one/credential-material-profile": "profile", "genio.one/credential-material-revision": "1" } }, spec: { gcpCredentials: { credentialsFile: { secretRef: { namespace: "genio-one", name: providerCredentialSecretName(TENANT_ID, "profile", 1) } } } } }] } }] as any
  let allowed = true
  const { app, store } = await fixture({ credentials, authorizeRuntime: async () => allowed, packages: { getPackage: async () => value } })
  try {
    await negotiate(app)
    const command = await enqueue(store, 1)
    const url = `/v1/tenants/${TENANT_ID}/runtime-control/GATEWAY/${RUNTIME_ID}/aggregate/releases/${RELEASE_ID}/credentials?command_id=${command.command_id}`
    const response = await app.inject({ url })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers["cache-control"], "no-store")
    assert.equal(response.json().length, 1)
    assert.equal(response.json()[0].credential_json, material)
    assert.equal((await app.inject({ url: url.replace(command.command_id, "unknown") })).statusCode, 403)
    allowed = false
    assert.equal((await app.inject({ url })).statusCode, 403)
    allowed = true
    value.runtime_id = "other-runtime"
    assert.equal((await app.inject({ url })).statusCode, 409)
    value.runtime_id = RUNTIME_ID
    await credentials.revise({ tenantId: TENANT_ID, profileId: "profile", createdBySubjectId: "admin", value: { expected_revision: 1, display_name: "ADC", strategy: profile.strategy, state: "REVOKED" } })
    assert.equal((await app.inject({ url })).statusCode, 409)
  } finally { await app.close() }
})
