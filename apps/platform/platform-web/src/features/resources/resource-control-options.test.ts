import { describe, expect, test } from "bun:test"

import {
  allowedAuthorizationAuthorities,
  allowedInboundAuthentications,
  coerceControlSelections,
  controlOptionFamily,
  inboundAuthenticationOptionLabel,
} from "./resource-control-options"

describe("resource control option filters", () => {
  test("AI Gateway exposes One Policy login methods and hides mTLS", () => {
    expect(controlOptionFamily("LLM")).toBe("AI")
    expect(allowedAuthorizationAuthorities("AI")).toEqual(["ONE_POLICY", "GATEWAY_NATIVE", "UPSTREAM"])
    expect(allowedInboundAuthentications("AI", "ONE_POLICY")).toEqual(["PLATFORM_OAUTH", "API_KEY", "GATEWAY_NATIVE"])
    expect(allowedInboundAuthentications("AI", "UPSTREAM")).toEqual([])
    expect(inboundAuthenticationOptionLabel("PLATFORM_OAUTH", "AI")).toBe("OS")
    expect(inboundAuthenticationOptionLabel("GATEWAY_NATIVE", "AI")).toBe("Pass through")
    expect(coerceControlSelections("AI", "ONE_POLICY", "MTLS")).toEqual({
      authority: "ONE_POLICY",
      inbound: "PLATFORM_OAUTH",
    })
  })

  test("API Gateway hides OS, pass through, and Gateway native policy", () => {
    expect(controlOptionFamily("API")).toBe("API")
    expect(allowedAuthorizationAuthorities("API")).toEqual(["ONE_POLICY", "UPSTREAM"])
    expect(allowedInboundAuthentications("API", "ONE_POLICY")).toEqual(["EXTERNAL_OAUTH", "API_KEY", "MTLS"])
    expect(coerceControlSelections("API", "GATEWAY_NATIVE", "GATEWAY_NATIVE")).toEqual({
      authority: "ONE_POLICY",
      inbound: "EXTERNAL_OAUTH",
    })
  })
})
