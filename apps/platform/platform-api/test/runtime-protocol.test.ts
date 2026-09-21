import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { Check } from "typebox/value"

import {
  RuntimeProtocolSchema as EndpointRuntimeProtocolSchema,
  RuntimeProtocolValidationError as EndpointRuntimeProtocolValidationError,
  isRuntimeProtocolMessage as isEndpointRuntimeProtocolMessage,
  parseRuntimeProtocolMessage as parseEndpointRuntimeProtocolMessage,
} from "@genioone/protocol/endpoint"
import {
  RuntimeProtocolSchema as GatewayRuntimeProtocolSchema,
  RuntimeProtocolValidationError as GatewayRuntimeProtocolValidationError,
  isRuntimeProtocolMessage as isGatewayRuntimeProtocolMessage,
  parseRuntimeProtocolMessage as parseGatewayRuntimeProtocolMessage,
} from "@genioone/protocol/gateway-release"

async function loadJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8"),
  ) as Record<string, unknown>
}

test("committed Endpoint and Gateway Runtime schemas match their TypeBox authorities", async () => {
  const endpoint = await loadJson("../../../../packages/protocol/schema/runtime-protocol.endpoint.v1.json")
  const gateway = await loadJson("../../../../packages/protocol/schema/runtime-protocol.gateway.v1.json")
  assert.deepEqual(endpoint, EndpointRuntimeProtocolSchema)
  assert.deepEqual(gateway, GatewayRuntimeProtocolSchema)
  assert.notEqual(endpoint.$id, gateway.$id)
})

test("Endpoint and aggregate Gateway fixtures satisfy only their owning protocol", async () => {
  const endpointFixtures = [
    "../../../../packages/protocol/schema/fixtures/runtime-command-endpoint.json",
    "../../../../packages/protocol/schema/fixtures/runtime-report-endpoint.json",
  ]
  const gatewayFixtures = [
    "../../../../packages/protocol/schema/fixtures/runtime-command-gateway.json",
    "../../../../packages/protocol/schema/fixtures/runtime-report-gateway.json",
  ]

  for (const fixturePath of endpointFixtures) {
    const fixture = await loadJson(fixturePath)
    assert.equal(Check(EndpointRuntimeProtocolSchema, fixture), true, fixturePath)
    assert.equal(Check(GatewayRuntimeProtocolSchema, fixture), false, fixturePath)
    assert.equal(isEndpointRuntimeProtocolMessage(fixture), true, fixturePath)
    assert.deepEqual(parseEndpointRuntimeProtocolMessage(fixture), fixture)
  }

  for (const fixturePath of gatewayFixtures) {
    const fixture = await loadJson(fixturePath)
    assert.equal(Check(GatewayRuntimeProtocolSchema, fixture), true, fixturePath)
    assert.equal(Check(EndpointRuntimeProtocolSchema, fixture), false, fixturePath)
    assert.equal(isGatewayRuntimeProtocolMessage(fixture), true, fixturePath)
    assert.deepEqual(parseGatewayRuntimeProtocolMessage(fixture), fixture)
  }
})

test("both Runtime envelopes require revision, digest, and signature", async () => {
  const fixtures = [
    [EndpointRuntimeProtocolSchema, await loadJson("../../../../packages/protocol/schema/fixtures/runtime-command-endpoint.json")],
    [EndpointRuntimeProtocolSchema, await loadJson("../../../../packages/protocol/schema/fixtures/runtime-report-endpoint.json")],
    [GatewayRuntimeProtocolSchema, await loadJson("../../../../packages/protocol/schema/fixtures/runtime-command-gateway.json")],
    [GatewayRuntimeProtocolSchema, await loadJson("../../../../packages/protocol/schema/fixtures/runtime-report-gateway.json")],
  ] as const

  for (const [schema, fixture] of fixtures) {
    for (const field of ["revision", "digest", "signature"] as const) {
      const invalid = structuredClone(fixture)
      delete invalid[field]
      assert.equal(Check(schema, invalid), false, field)
    }
  }
})

test("unknown protocol versions fail closed before Endpoint or Gateway validation", async () => {
  const endpoint = await loadJson("../../../../packages/protocol/schema/fixtures/runtime-command-endpoint.json")
  const gateway = await loadJson("../../../../packages/protocol/schema/fixtures/runtime-command-gateway.json")

  assert.throws(
    () => parseEndpointRuntimeProtocolMessage({ ...endpoint, schema_version: "genio.one.runtime.v999" }),
    (error: unknown) =>
      error instanceof EndpointRuntimeProtocolValidationError &&
      error.code === "UNSUPPORTED_SCHEMA_VERSION",
  )
  assert.throws(
    () => parseGatewayRuntimeProtocolMessage({ ...gateway, schema_version: "genio.one.runtime.v999" }),
    (error: unknown) =>
      error instanceof GatewayRuntimeProtocolValidationError &&
      error.code === "UNSUPPORTED_SCHEMA_VERSION",
  )
})

test("Gateway command references one immutable aggregate release", async () => {
  const command = await loadJson("../../../../packages/protocol/schema/fixtures/runtime-command-gateway.json")
  const desired = command.desired_release as Record<string, unknown>

  for (const requiredField of [
    "schema_version",
    "release_id",
    "gateway_id",
    "head_revision",
    "package_digest",
    "projection_count",
  ]) {
    const invalid = structuredClone(command)
    delete (invalid.desired_release as Record<string, unknown>)[requiredField]
    assert.equal(Check(GatewayRuntimeProtocolSchema, invalid), false, requiredField)
  }

  desired.resource = { owner_organization_id: "org-added-outside-release" }
  assert.equal(Check(GatewayRuntimeProtocolSchema, command), false)
})

test("Endpoint projection and Gateway release shapes cannot cross protocols", async () => {
  const endpoint = await loadJson("../../../../packages/protocol/schema/fixtures/runtime-command-endpoint.json")
  const gateway = await loadJson("../../../../packages/protocol/schema/fixtures/runtime-command-gateway.json")

  const endpointDesired = endpoint.desired_projection as Record<string, unknown>
  const endpointComponents = endpointDesired.components as Array<Record<string, unknown>>
  endpointComponents[0].issuer = "https://unexpected.example.test"
  assert.equal(Check(EndpointRuntimeProtocolSchema, endpoint), false)

  gateway.desired_projection = endpointDesired
  assert.equal(Check(GatewayRuntimeProtocolSchema, gateway), false)
})

test("both Runtime schemas contain no open-ended object maps", () => {
  for (const schema of [EndpointRuntimeProtocolSchema, GatewayRuntimeProtocolSchema]) {
    const serialized = JSON.stringify(schema)
    assert.equal(serialized.includes("patternProperties"), false)
    assert.equal(serialized.includes('"additionalProperties":true'), false)
  }
})
