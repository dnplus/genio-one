import assert from "node:assert/strict"
import test from "node:test"

import { Check } from "typebox/value"

import {
  GatewayReleaseReferenceSchema,
  GatewayRuntimeCommandSchema,
  GatewayRuntimeReportSchema,
  RUNTIME_PROTOCOL_SCHEMA_VERSION,
  RuntimeProtocolSchema,
  RuntimeProtocolValidationError,
  isGatewayRuntimeCommand,
  isGatewayRuntimeReport,
  isRuntimeProtocolMessage,
  parseGatewayRuntimeCommand,
  parseGatewayRuntimeReport,
  parseRuntimeProtocolMessage,
  type GatewayComponentObservation,
  type GatewayReleaseReference,
  type GatewayRuntimeCommand,
  type GatewayRuntimeReport,
} from "@genioone/protocol/gateway-release"

const release = (overrides: Partial<GatewayReleaseReference> = {}): GatewayReleaseReference => ({
  schema_version: "genio.one.gateway-release-ref.v1",
  release_id: "release-20260828-a",
  gateway_id: "ai-gateway-primary",
  head_revision: 7,
  package_digest: "a".repeat(64),
  projection_count: 2,
  ...overrides,
})

const envelope = {
  schema_version: RUNTIME_PROTOCOL_SCHEMA_VERSION,
  tenant_id: "tenant-acme",
  runtime_id: "gateway-runtime-1",
  revision: "7",
  digest: "b".repeat(64),
  signature: {
    algorithm: "Ed25519" as const,
    key_id: "runtime-command-key",
    value: "A".repeat(86),
  },
  runtime_kind: "GATEWAY" as const,
}

function command(overrides: Partial<GatewayRuntimeCommand> = {}): GatewayRuntimeCommand {
  return {
    ...envelope,
    message_type: "COMMAND",
    command_id: "command-7",
    desired_release: release(),
    ...overrides,
  }
}

function report(overrides: Partial<GatewayRuntimeReport> = {}): GatewayRuntimeReport {
  return {
    ...envelope,
    message_type: "REPORT",
    report_id: "report-7",
    command_id: "command-7",
    observed_status: {
      state: "DEGRADED",
      components: [
        {
          component: "AI_GATEWAY",
          state: "DEGRADED",
          observed_revision: "7",
        },
      ],
      error: {
        code: "UPSTREAM_NOT_READY",
        message: "Provider readiness is still converging",
      },
    },
    ...overrides,
  }
}

test("runtime command and report parse as aggregate Gateway messages", () => {
  const gatewayCommand = command()
  const gatewayReport = report()

  assert.equal(Check(GatewayRuntimeCommandSchema, gatewayCommand), true)
  assert.equal(Check(GatewayRuntimeReportSchema, gatewayReport), true)
  assert.equal(isGatewayRuntimeCommand(gatewayCommand), true)
  assert.equal(isGatewayRuntimeReport(gatewayReport), true)
  assert.equal(isRuntimeProtocolMessage(gatewayCommand), true)
  assert.equal(isRuntimeProtocolMessage(gatewayReport), true)
  assert.deepEqual(parseGatewayRuntimeCommand(gatewayCommand), gatewayCommand)
  assert.deepEqual(parseGatewayRuntimeReport(gatewayReport), gatewayReport)
  assert.deepEqual(parseRuntimeProtocolMessage(gatewayCommand), gatewayCommand)
  assert.deepEqual(parseRuntimeProtocolMessage(gatewayReport), gatewayReport)
})

test("an empty aggregate release is valid and carries zero projections", () => {
  const empty = command({ desired_release: release({ projection_count: 0 }) })

  assert.equal(Check(GatewayReleaseReferenceSchema, empty.desired_release), true)
  assert.equal(empty.desired_release.projection_count, 0)
  assert.deepEqual(parseGatewayRuntimeCommand(empty), empty)
})

test("command and READY report revisions bind the aggregate release head", () => {
  const mismatchedCommand = command({ revision: "8" })
  const mismatchedReady = report({
    revision: "8",
    observed_status: {
      state: "READY",
      applied_release: release(),
    },
  })

  assert.equal(Check(GatewayRuntimeCommandSchema, mismatchedCommand), true)
  assert.equal(Check(GatewayRuntimeReportSchema, mismatchedReady), true)
  assert.equal(isGatewayRuntimeCommand(mismatchedCommand), false)
  assert.equal(isGatewayRuntimeReport(mismatchedReady), false)
  assert.throws(() => parseGatewayRuntimeCommand(mismatchedCommand))
  assert.throws(() => parseGatewayRuntimeReport(mismatchedReady))
})

test("release references reject path-shaped release ids", () => {
  for (const release_id of ["../release-a", "release/a", " release-a", "release a"]) {
    assert.throws(
      () => parseGatewayRuntimeCommand(command({
        desired_release: release({ release_id }),
      })),
      (error: unknown) =>
        error instanceof RuntimeProtocolValidationError && error.code === "INVALID_MESSAGE",
    )
  }
})

test("runtime reports accept a READY state with the applied release", () => {
  const ready = report({
    observed_status: {
      state: "READY",
      applied_release: release({ projection_count: 0 }),
      components: [
        {
          component: "AI_GATEWAY",
          state: "READY",
          observed_revision: "7",
          payload: {
            provider_health: "READY",
            active_routes: 0,
            active_connections: 0,
          },
        },
        {
          component: "AUTHORIZER",
          state: "READY",
          observed_revision: "7",
        },
        {
          component: "PROCESSOR",
          state: "READY",
          observed_revision: "7",
        },
      ],
    },
  })

  const parsed = parseGatewayRuntimeReport(ready)
  assert.equal(parsed.observed_status.state, "READY")
  assert.equal(parsed.observed_status.applied_release?.projection_count, 0)
  assert.equal(parsed.observed_status.components?.length, 3)
})

test("READY reports require a non-empty ready component inventory", () => {
  const withoutComponents = report({
    observed_status: {
      state: "READY",
      applied_release: release(),
    },
  })
  const emptyComponents = report({
    observed_status: {
      state: "READY",
      applied_release: release(),
      components: [],
    },
  })
  const applyingComponent = report({
    observed_status: {
      state: "READY",
      applied_release: release(),
      components: [{
        component: "AI_GATEWAY",
        state: "APPLYING",
        observed_revision: "7",
      }],
    },
  })
  const mismatchedComponentRevision = report({
    observed_status: {
      state: "READY",
      applied_release: release(),
      components: [{
        component: "AI_GATEWAY",
        state: "READY",
        observed_revision: "6",
      }],
    },
  })
  const minimalComponentInventory = report({
    observed_status: {
      state: "READY",
      applied_release: release(),
      components: [
        {
          component: "AI_GATEWAY",
          state: "READY",
          observed_revision: "7",
        },
        {
          component: "AUTHORIZER",
          state: "READY",
          observed_revision: "7",
        },
      ],
    },
  })
  const extraComponent = {
    component: "UNSUPPORTED",
    state: "READY",
    observed_revision: "7",
  } as unknown as GatewayComponentObservation
  const extraComponentInventory = report({
    observed_status: {
      state: "READY",
      applied_release: release(),
      components: [
        {
          component: "AI_GATEWAY",
          state: "READY",
          observed_revision: "7",
        },
        {
          component: "AUTHORIZER",
          state: "READY",
          observed_revision: "7",
        },
        {
          component: "PROCESSOR",
          state: "READY",
          observed_revision: "7",
        },
        extraComponent,
      ],
    },
  })

  for (const invalid of [
    withoutComponents,
    emptyComponents,
    applyingComponent,
    mismatchedComponentRevision,
    extraComponentInventory,
  ]) {
    assert.equal(
      Check(GatewayRuntimeReportSchema, invalid),
      invalid === extraComponentInventory ? false : true,
    )
    assert.equal(isGatewayRuntimeReport(invalid), false)
    assert.throws(() => parseGatewayRuntimeReport(invalid))
  }

  assert.equal(isGatewayRuntimeReport(minimalComponentInventory), true)
  assert.deepEqual(
    parseGatewayRuntimeReport(minimalComponentInventory),
    minimalComponentInventory,
  )
})

test("DEGRADED reports require an explicit error", () => {
  const withoutError = report({
    observed_status: {
      state: "DEGRADED",
      components: [{
        component: "AI_GATEWAY",
        state: "DEGRADED",
        observed_revision: "7",
      }],
    },
  })

  assert.equal(Check(GatewayRuntimeReportSchema, withoutError), true)
  assert.equal(isGatewayRuntimeReport(withoutError), false)
  assert.throws(() => parseGatewayRuntimeReport(withoutError))
})

test("UNKNOWN is reserved for startup or untrusted state", () => {
  const startup = report({
    observed_status: {
      state: "UNKNOWN",
    },
  })
  const withAppliedRelease = report({
    observed_status: {
      state: "UNKNOWN",
      applied_release: release(),
    },
  })
  const withComponents = report({
    observed_status: {
      state: "UNKNOWN",
      components: [{
        component: "AI_GATEWAY",
        state: "UNKNOWN",
        observed_revision: "7",
      }],
    },
  })
  const withError = report({
    observed_status: {
      state: "UNKNOWN",
      error: {
        code: "STARTUP_FAILED",
        message: "The runtime has not established a trusted state",
      },
    },
  })

  for (const valid of [startup, withError]) {
    assert.equal(isGatewayRuntimeReport(valid), true)
    assert.deepEqual(parseGatewayRuntimeReport(valid), valid)
  }
  for (const invalid of [withAppliedRelease, withComponents]) {
    assert.equal(Check(GatewayRuntimeReportSchema, invalid), true)
    assert.equal(isGatewayRuntimeReport(invalid), false)
    assert.throws(() => parseGatewayRuntimeReport(invalid))
  }
})

test("APPLYING reports can describe partial progress without an error", () => {
  const applying = report({
    observed_status: {
      state: "APPLYING",
      applied_release: release({ head_revision: 6 }),
      components: [
        {
          component: "AI_GATEWAY",
          state: "APPLYING",
          observed_revision: "7",
        },
        {
          component: "AUTHORIZER",
          state: "READY",
          observed_revision: "7",
        },
        {
          component: "PROCESSOR",
          state: "READY",
          observed_revision: "7",
        },
      ],
    },
  })
  const applyingWithError = report({
    observed_status: {
      state: "APPLYING",
      error: {
        code: "APPLY_FAILED",
        message: "The release could not be applied yet",
      },
    },
  })

  assert.equal(Check(GatewayRuntimeReportSchema, applying), true)
  assert.equal(isGatewayRuntimeReport(applying), true)
  assert.deepEqual(parseGatewayRuntimeReport(applying), applying)
  assert.equal(Check(GatewayRuntimeReportSchema, applyingWithError), true)
  assert.equal(isGatewayRuntimeReport(applyingWithError), false)
  assert.throws(() => parseGatewayRuntimeReport(applyingWithError))
})

test("runtime object boundaries reject unknown fields, including nested release state", () => {
  const extraEnvelopeField = { ...command(), unexpected: true }
  const extraReleaseField = {
    ...command(),
    desired_release: { ...command().desired_release, unexpected: true },
  }
  const extraObservedField = {
    ...report(),
    observed_status: { ...report().observed_status, unexpected: true },
  }

  for (const invalid of [extraEnvelopeField, extraReleaseField, extraObservedField]) {
    assert.equal(Check(RuntimeProtocolSchema, invalid), false)
    assert.equal(isRuntimeProtocolMessage(invalid), false)
    assert.throws(
      () => parseRuntimeProtocolMessage(invalid),
      (error: unknown) =>
        error instanceof RuntimeProtocolValidationError && error.code === "INVALID_MESSAGE",
    )
  }
})

test("READY reports require an applied release and cannot carry an error", () => {
  const withoutAppliedRelease = report({
    observed_status: {
      state: "READY",
      components: [],
    },
  })
  const readyWithError = report({
    observed_status: {
      state: "READY",
      applied_release: release(),
      error: {
        code: "SHOULD_NOT_BE_READY",
        message: "A ready runtime cannot report an error",
      },
    },
  })

  for (const invalid of [withoutAppliedRelease, readyWithError]) {
    assert.equal(Check(GatewayRuntimeReportSchema, invalid), true)
    assert.equal(isGatewayRuntimeReport(invalid), false)
    assert.equal(isRuntimeProtocolMessage(invalid), false)
    assert.throws(
      () => parseGatewayRuntimeReport(invalid),
      (error: unknown) =>
        error instanceof RuntimeProtocolValidationError && error.code === "INVALID_MESSAGE",
    )
    assert.throws(
      () => parseRuntimeProtocolMessage(invalid),
      (error: unknown) =>
        error instanceof RuntimeProtocolValidationError && error.code === "INVALID_MESSAGE",
    )
  }
})

test("component inventory is unique and counters stay within JSON safe integers", () => {
  const duplicateComponents = report({
    observed_status: {
      state: "DEGRADED",
      components: [
        { component: "AI_GATEWAY", state: "READY", observed_revision: "7" },
        { component: "AI_GATEWAY", state: "DEGRADED", observed_revision: "7" },
      ],
    },
  })
  const unsafeCounter = report({
    observed_status: {
      state: "DEGRADED",
      components: [{
        component: "AI_GATEWAY",
        state: "DEGRADED",
        observed_revision: "7",
        payload: { active_routes: Number.MAX_SAFE_INTEGER + 1 },
      }],
    },
  })

  assert.equal(isGatewayRuntimeReport(duplicateComponents), false)
  assert.equal(Check(GatewayRuntimeReportSchema, unsafeCounter), false)
})

test("READY component inventory is capability-driven and unique", () => {
  const currentSlice = report({
    observed_status: {
      state: "READY",
      applied_release: release(),
      components: [
        { component: "AI_GATEWAY", state: "READY", observed_revision: "7" },
      ],
    },
  })
  const duplicate = report({
    observed_status: {
      ...currentSlice.observed_status,
      components: [
        ...currentSlice.observed_status.components!,
        { component: "AI_GATEWAY", state: "READY", observed_revision: "7" },
      ],
    },
  })

  assert.equal(isGatewayRuntimeReport(currentSlice), true)
  assert.equal(isGatewayRuntimeReport(duplicate), false)
})

test("unknown protocol versions fail closed before runtime validation", () => {
  const unknownVersion = { ...command(), schema_version: "genio.one.runtime.v3" }

  assert.equal(Check(RuntimeProtocolSchema, unknownVersion), false)
  assert.equal(isRuntimeProtocolMessage(unknownVersion), false)
  assert.throws(
    () => parseRuntimeProtocolMessage(unknownVersion),
    (error: unknown) =>
      error instanceof RuntimeProtocolValidationError &&
      error.code === "UNSUPPORTED_SCHEMA_VERSION",
  )
})

test("envelope revisions reject control characters", () => {
  const invalid = command({ revision: "7\nnext" })

  assert.equal(Check(GatewayRuntimeCommandSchema, invalid), false)
  assert.equal(isGatewayRuntimeCommand(invalid), false)
  assert.throws(
    () => parseGatewayRuntimeCommand(invalid),
    (error: unknown) =>
      error instanceof RuntimeProtocolValidationError && error.code === "INVALID_MESSAGE",
  )
})

test("runtime protocol schemas contain no open-ended object maps", () => {
  const serialized = JSON.stringify(RuntimeProtocolSchema)
  assert.equal(serialized.includes("patternProperties"), false)
  assert.equal(serialized.includes('"additionalProperties":true'), false)
})
