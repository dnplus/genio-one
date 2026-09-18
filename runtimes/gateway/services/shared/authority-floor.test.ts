import assert from "node:assert/strict"
import test from "node:test"

import { advanceAuthorityFloor, applyAuthorityFloor, parseAuthorityFloor } from "./authority-floor"

test("authority floor advances monotonically and filters an LKG entitlement", () => {
  const first = advanceAuthorityFloor({
    current: null,
    tenantId: "tenant-acme",
    generation: 7,
    revokedEntitlementIds: ["entitlement-b"],
  })
  const next = advanceAuthorityFloor({
    current: first,
    tenantId: "tenant-acme",
    generation: 8,
    revokedEntitlementIds: ["entitlement-a"],
  })

  assert.deepEqual(next.revoked_entitlement_ids, ["entitlement-a", "entitlement-b"])
  assert.deepEqual(applyAuthorityFloor([
    { rule_id: "entitlement-a" },
    { rule_id: "entitlement-c" },
  ], next), [{ rule_id: "entitlement-c" }])
  assert.throws(() => advanceAuthorityFloor({
    current: next,
    tenantId: "tenant-acme",
    generation: 6,
    revokedEntitlementIds: [],
  }), /cannot regress/)
})

test("authority floor parser rejects non-canonical and cross-tenant state", () => {
  assert.throws(() => parseAuthorityFloor({
    schema_version: "genio.one.authority-floor.v1",
    tenant_id: "tenant-acme",
    generation: 8,
    revoked_entitlement_ids: ["entitlement-b", "entitlement-a"],
  }), /not canonical/)
  assert.throws(() => advanceAuthorityFloor({
    current: {
      schema_version: "genio.one.authority-floor.v1",
      tenant_id: "tenant-acme",
      generation: 8,
      revoked_entitlement_ids: [],
    },
    tenantId: "tenant-other",
    generation: 9,
    revokedEntitlementIds: [],
  }), /tenant mismatch/)
})
