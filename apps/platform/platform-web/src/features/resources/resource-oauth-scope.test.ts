import { expect, test } from "bun:test"
import { GENIOONE_SCOPES, isGenioOneScope } from "@genioone/protocol/authorization-scopes"
import { platformResourceOAuthScope } from "./resource-oauth-scope"

test("Platform OAuth REST resource metadata remains nonempty for existing Application OAuth issuance", () => {
  for (const methods of [["GET"], ["GET", "HEAD"], ["GET", "POST"], ["PUT"], ["DELETE"], ["PATCH"], ["OPTIONS"], ["TRACE"], []]) {
    const scope = platformResourceOAuthScope("API", methods)
    expect(scope.trim().length).toBeGreaterThan(0)
    expect(isGenioOneScope(scope)).toBe(true)
    expect(scope).not.toBe("genioone-invocation")
  }
  expect(platformResourceOAuthScope("API", ["get", "head"])).toBe(GENIOONE_SCOPES.read)
  expect(platformResourceOAuthScope("API", ["GET", "POST"])).toBe(GENIOONE_SCOPES.write)
})

test("Agent invocation metadata is independent from its HTTP method", () => {
  expect(platformResourceOAuthScope("A2A", ["POST"])).toBe(GENIOONE_SCOPES.invoke)
  expect(platformResourceOAuthScope("A2A", ["GET"])).toBe(GENIOONE_SCOPES.invoke)
})
