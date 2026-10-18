import { expect, test } from "bun:test"
import { BOT_OAUTH_SCOPES, GENIOONE_SCOPES, GENIOONE_SCOPE_CATALOG, GENIOONE_SCOPE_VALUES, MANAGEMENT_CONSOLE_OAUTH_SCOPES, MANAGEMENT_SCOPES, MANAGEMENT_SCOPE_VALUES, RESOURCE_SCOPE_VALUES, hasAnyScope, isGenioOneScope } from "./authorization-scopes"

test("Scope validation accepts only the published resource and management permissions", () => {
  for (const scope of GENIOONE_SCOPE_VALUES) expect(isGenioOneScope(scope)).toBe(true)
  for (const scope of [undefined, null, "", "openid", "genioone-management", "genioone-invocation", "genioone-gateway-runtime", "management:identity:*", "management:identity:delete", "genioone:admin", 1]) expect(isGenioOneScope(scope)).toBe(false)
  expect(new Set(GENIOONE_SCOPE_VALUES).size).toBe(GENIOONE_SCOPE_VALUES.length)
})

test("Scope checks fail closed and never infer cross-domain or read/write authority", () => {
  expect(hasAnyScope(undefined, [GENIOONE_SCOPES.read])).toBe(false)
  expect(hasAnyScope([], [GENIOONE_SCOPES.read])).toBe(false)
  expect(hasAnyScope([GENIOONE_SCOPES.write], [GENIOONE_SCOPES.read])).toBe(false)
  expect(hasAnyScope(RESOURCE_SCOPE_VALUES, MANAGEMENT_SCOPE_VALUES)).toBe(false)
  expect(hasAnyScope(MANAGEMENT_SCOPE_VALUES, RESOURCE_SCOPE_VALUES)).toBe(false)
  expect(hasAnyScope([MANAGEMENT_SCOPES.identityWrite], [MANAGEMENT_SCOPES.credentialsWrite])).toBe(false)
  expect(hasAnyScope([MANAGEMENT_SCOPES.accessWrite], [MANAGEMENT_SCOPES.accessApprove])).toBe(false)
  expect(hasAnyScope([GENIOONE_SCOPES.read], [])).toBe(false)
  expect(hasAnyScope([GENIOONE_SCOPES.read], [GENIOONE_SCOPES.read])).toBe(true)
})

test("Every selectable permission has distinct bilingual consent metadata", () => {
  expect(GENIOONE_SCOPE_CATALOG.map(entry => entry.scope)).toEqual(GENIOONE_SCOPE_VALUES)
  for (const entry of GENIOONE_SCOPE_CATALOG) {
    expect(entry.name.en.trim()).not.toBe("")
    expect(entry.name.zhTW.trim()).not.toBe("")
    expect(entry.description.en.trim()).not.toBe("")
    expect(entry.description.zhTW.trim()).not.toBe("")
    expect(entry.kind).toBe(entry.scope.startsWith("management:") ? "MANAGEMENT" : "RESOURCE")
  }
})

test("Trusted Bot retains only its existing policy administration while the console requests all permissions", () => {
  expect(BOT_OAUTH_SCOPES).toEqual(["openid", ...RESOURCE_SCOPE_VALUES, MANAGEMENT_SCOPES.policiesRead, MANAGEMENT_SCOPES.policiesWrite, MANAGEMENT_SCOPES.policiesPublish])
  expect(MANAGEMENT_CONSOLE_OAUTH_SCOPES).toEqual(["openid", ...GENIOONE_SCOPE_VALUES])
})
