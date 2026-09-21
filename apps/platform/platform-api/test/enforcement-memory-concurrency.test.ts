import assert from "node:assert/strict"
import test from "node:test"

import type { PolicyChangeAuditEvent } from "../src/capabilities/audit-events/contract"
import { createInMemoryGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/memory"
import type { GatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/module"
import { PlatformApiError } from "../src/capabilities/errors"
import { createInMemoryEnforcementChainReader } from "../src/capabilities/enforcement/memory"
import type { CompiledEnforcementChain } from "../src/capabilities/enforcement/contract"

const tenantId = "tenant-enforcement-memory"
const resourceId = "resource-enforcement-memory"
const capabilityId = "chat"

const jwt = {
  schema_version: "genio.one.auth.jwt.v1" as const,
  provider: "keycloak",
  issuer: "https://identity.example.test/realms/acme",
  audiences: ["genio-one"],
  remote_jwks_uri: "https://identity.example.test/realms/acme/protocol/openid-connect/certs",
  subject_claim: "sub",
  client_claim: "azp",
}

function chain(
  revision = 1,
  eligibleConnectionIds = ["connection-primary"],
): CompiledEnforcementChain {
  return {
    chain_id: `chain-memory-${revision}-${eligibleConnectionIds.join("-")}`,
    tenant_id: tenantId,
    resource_id: resourceId,
    capability_id: capabilityId,
    eligible_connection_ids: eligibleConnectionIds,
    one_policy_revision: revision,
    steps: [
      {
        step_id: "authenticate",
        kind: "AUTHENTICATE",
        phase: "REQUEST",
        implementation: "NATIVE",
        depends_on: [],
        config: jwt,
      },
      {
        step_id: "authorize",
        kind: "AUTHORIZE",
        phase: "REQUEST",
        implementation: "EXT_AUTH",
        depends_on: ["authenticate"],
        config: {},
      },
      {
        step_id: "route",
        kind: "ROUTE",
        phase: "ROUTING",
        implementation: "AIGW_NATIVE",
        depends_on: ["authorize"],
        config: {},
      },
    ],
    request_filter_order: ["authorize"],
    response_filter_order: [],
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, resolve }
}

function controlledAudit(options: { wait?: boolean; fail?: boolean } = {}) {
  const entered = deferred()
  const release = deferred()
  const events: PolicyChangeAuditEvent[] = []
  const state = { fail: options.fail ?? false }
  let calls = 0
  const underlying = createInMemoryGatewayAuthorizationAuditStore()
  const audit: GatewayAuthorizationAuditStore = {
    ...underlying,
    async record(input: Parameters<GatewayAuthorizationAuditStore["record"]>[0]) {
      calls += 1
      entered.resolve()
      if (options.wait) await release.promise
      if (state.fail) throw new Error("AUDIT_WRITE_FAILED")
      const recorded = await underlying.record(input)
      if (recorded.kind === "POLICY_CHANGE") events.push(recorded)
      return recorded
    },
  }
  return { audit, entered, release, events, setFail(value: boolean) { state.fail = value }, get calls() { return calls } }
}

function latestInput() {
  return { tenantId, resourceId, capabilityId }
}

test("in-memory enforcement saves serialize same-identity replays and emit one audit", async () => {
  const control = controlledAudit({ wait: true })
  const store = createInMemoryEnforcementChainReader({ audit: control.audit, now: () => 1_700_000_000 })
  const candidate = chain()

  const first = store.save({ tenantId, chain: candidate })
  await control.entered.promise
  const second = store.save({ tenantId, chain: structuredClone(candidate) })
  await Promise.resolve()
  assert.equal(control.calls, 1)
  assert.equal(await store.getLatest(latestInput()), null)

  control.release.resolve()
  const [firstSaved, secondSaved] = await Promise.all([first, second])
  assert.deepEqual(secondSaved, firstSaved)
  assert.equal(control.calls, 1)
  assert.equal(control.events.length, 1)
  assert.deepEqual(await store.getLatest(latestInput()), firstSaved)
})

test("in-memory enforcement rejects a concurrent different chain without a partial revision", async () => {
  const control = controlledAudit({ wait: true })
  const store = createInMemoryEnforcementChainReader({ audit: control.audit, now: () => 1_700_000_000 })

  const first = store.save({ tenantId, chain: chain() })
  await control.entered.promise
  const second = store.save({
    tenantId,
    chain: chain(1, ["connection-failover"]),
  })
  await Promise.resolve()
  assert.equal(control.calls, 1)
  assert.equal(await store.getLatest(latestInput()), null)

  control.release.resolve()
  const firstSaved = await first
  await assert.rejects(
    second,
    (error: unknown) => error instanceof PlatformApiError && error.code === "ENFORCEMENT_CHAIN_REVISION_IMMUTABLE",
  )
  assert.equal(control.calls, 1)
  assert.equal(control.events.length, 1)
  assert.deepEqual(await store.getLatest(latestInput()), firstSaved)
})

test("in-memory enforcement publishes only after a delayed audit succeeds", async () => {
  const control = controlledAudit({ wait: true })
  const store = createInMemoryEnforcementChainReader({ audit: control.audit, now: () => 1_700_000_000 })
  const saving = store.save({ tenantId, chain: chain() })

  await control.entered.promise
  assert.equal(await store.getLatest(latestInput()), null)
  control.release.resolve()
  const saved = await saving

  assert.equal(saved.one_policy_revision, 1)
  assert.equal(control.events.length, 1)
  assert.deepEqual(await store.getLatest(latestInput()), saved)
})

test("in-memory enforcement leaves no revision after audit failure and allows one successful retry", async () => {
  const control = controlledAudit({ fail: true })
  const store = createInMemoryEnforcementChainReader({ audit: control.audit, now: () => 1_700_000_000 })
  const candidate = chain()

  await assert.rejects(store.save({ tenantId, chain: candidate }), /AUDIT_WRITE_FAILED/)
  assert.equal(await store.getLatest(latestInput()), null)
  assert.equal(control.events.length, 0)

  control.setFail(false)
  const saved = await store.save({ tenantId, chain: candidate })
  assert.equal(control.calls, 2)
  assert.equal(control.events.length, 1)
  assert.deepEqual(await store.getLatest(latestInput()), saved)
})
