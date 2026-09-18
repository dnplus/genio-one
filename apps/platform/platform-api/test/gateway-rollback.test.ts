import assert from "node:assert/strict"
import test from "node:test"

import Fastify from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import { gatewayAggregateRuntimeControlHttp } from "../src/capabilities/gateway-runtime-control/http"

const tenantId = "tenant-acme"
const runtimeId = "gateway-1"

function appliedRelease(headRevision: number) {
  return {
    schema_version: "genio.one.gateway.release.reference.v1" as const,
    release_id: "release-good",
    gateway_id: "gateway-site",
    head_revision: headRevision,
    package_digest: "a".repeat(64),
    projection_count: 3,
  }
}

async function harness(options: {
  registered?: boolean
  applied?: ReturnType<typeof appliedRelease> | null
} = {}) {
  const enqueued: Array<{ runtimeId: string; headRevision: number }> = []
  const app = Fastify().withTypeProvider<TypeBoxTypeProvider>()
  await app.register(gatewayAggregateRuntimeControlHttp, {
    store: {
      async getLatestGatewayReleaseObserved() {
        return options.applied === null
          ? { applied_release: null }
          : { applied_release: options.applied ?? appliedRelease(7) }
      },
      async enqueueGatewayRelease(input: { runtimeId: string; release: { head_revision: number } }) {
        enqueued.push({ runtimeId: input.runtimeId, headRevision: input.release.head_revision })
        return { command_id: `command-${enqueued.length}` }
      },
    } as never,
    registrations: {
      async getGatewayRuntime() {
        return (options.registered ?? true) ? { runtime_id: runtimeId } : null
      },
    } as never,
    packages: {} as never,
  } as never)
  return { app, enqueued }
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    correlation_id: "console-gateway-rollback-1",
    failed_revision: "9",
    target_revision: "7",
    runtime_ids: [runtimeId],
    ...overrides,
  }
}

test("rollback re-delivers the release the Runtime last reported as applied", async () => {
  const { app, enqueued } = await harness()
  const response = await app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/gateway-rollbacks`,
    payload: body(),
  })

  assert.equal(response.statusCode, 200)
  const result = response.json() as {
    correlation_id: string
    target_revision: string
    runtimes: Array<{ runtime_id: string; command_id: string; desired_state_revision: string }>
  }
  assert.equal(result.correlation_id, "console-gateway-rollback-1")
  assert.equal(result.target_revision, "7")
  assert.deepEqual(result.runtimes, [{
    runtime_id: runtimeId,
    command_id: "command-1",
    desired_state_revision: "7",
  }])
  // The enqueued package is the observed applied release, not a revision the
  // caller supplied, so a Runtime can only be sent back to something it proved
  // it could apply.
  assert.deepEqual(enqueued, [{ runtimeId, headRevision: 7 }])
})

test("rollback is refused when the Runtime has never reported an applied release", async () => {
  const { app, enqueued } = await harness({ applied: null })
  const response = await app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/gateway-rollbacks`,
    payload: body(),
  })

  assert.equal(response.statusCode, 409)
  assert.equal((response.json() as { code: string }).code, "GATEWAY_ROLLBACK_TARGET_UNAVAILABLE")
  assert.deepEqual(enqueued, [])
})

test("rollback is refused when the observed applied release has moved on", async () => {
  const { app, enqueued } = await harness({ applied: appliedRelease(8) })
  const response = await app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/gateway-rollbacks`,
    payload: body({ target_revision: "7" }),
  })

  // Acting on a stale view of the fleet would deliver the wrong package.
  assert.equal(response.statusCode, 409)
  assert.equal((response.json() as { code: string }).code, "GATEWAY_ROLLBACK_TARGET_STALE")
  assert.deepEqual(enqueued, [])
})

test("rollback is refused for a Runtime that is not registered", async () => {
  const { app, enqueued } = await harness({ registered: false })
  const response = await app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/gateway-rollbacks`,
    payload: body(),
  })

  assert.equal(response.statusCode, 404)
  assert.deepEqual(enqueued, [])
})

test("an empty runtime list is rejected by the schema", async () => {
  const { app, enqueued } = await harness()
  const response = await app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/gateway-rollbacks`,
    payload: body({ runtime_ids: [] }),
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(enqueued, [])
})
