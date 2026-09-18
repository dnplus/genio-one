import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

import {
  createGatewaySidecarReadinessHandler,
  startGatewaySidecarReadinessServer,
} from "./release-readiness"
import type { PolicyReleaseObservation } from "./policy-release"

const release = {
  schema_version: "genio.one.gateway-release-ref.v1" as const,
  release_id: "release-42",
  gateway_id: "gateway-ai",
  head_revision: 42,
  package_digest: "a".repeat(64),
  projection_count: 3,
}

async function startHandler(
  observation: () => Promise<PolicyReleaseObservation>,
): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer(
    createGatewaySidecarReadinessHandler("PROCESSOR", {
      releaseObservation: observation,
    }),
  )
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

test("readiness reports the exact current release without accepting desired input", async () => {
  const server = await startHandler(async () => ({
    source: "CURRENT",
    releaseReference: release,
  }))
  try {
    const response = await fetch(`${server.origin}/readyz`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      schema_version: "genio.one.gateway-sidecar-readiness.v1",
      component: "PROCESSOR",
      state: "READY",
      source: "CURRENT",
      release,
    })
    assert.equal(response.headers.get("cache-control"), "no-store")
  } finally {
    await server.close()
  }
})

test("readiness identifies a valid last-known-good observation", async () => {
  const server = await startHandler(async () => ({
    source: "LKG",
    releaseReference: release,
  }))
  try {
    const response = await fetch(`${server.origin}/readyz`)
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { source: string }).source, "LKG")
  } finally {
    await server.close()
  }
})

test("readiness stays available but unknown when no policy release can be loaded", async () => {
  const server = await startHandler(async () => {
    throw new Error("secret path and stack must not escape")
  })
  try {
    const response = await fetch(`${server.origin}/readyz`)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      schema_version: "genio.one.gateway-sidecar-readiness.v1",
      component: "PROCESSOR",
      state: "UNKNOWN",
      source: "NONE",
      error: {
        code: "POLICY_RELEASE_UNAVAILABLE",
        message: "Policy release is unavailable",
      },
    })
  } finally {
    await server.close()
  }
})

test("readiness rejects non-loopback listeners", async () => {
  await assert.rejects(
    startGatewaySidecarReadinessServer(
      "0.0.0.0:9082",
      "PROCESSOR",
      { releaseObservation: async () => ({ source: "CURRENT", releaseReference: release }) },
    ),
    /loopback/,
  )
})
