import { describe, expect, test } from "bun:test"
import { authorize } from "./authorize"
import type { CompiledAuthorizationBundle, AuthorizationInput } from "@genioone/protocol/authorization"
import { AUTHORIZATION_BUNDLE_SCHEMA_VERSION } from "@genioone/protocol/authorization"

describe("authorize & intersectGrants", () => {
  const mockBundle: CompiledAuthorizationBundle = {
    schema_version: AUTHORIZATION_BUNDLE_SCHEMA_VERSION,
    policy_version: "1.0",
    revision: "rev-1",
    tenant_id: "tenant-1",
    issued_at: 1000,
    expires_at: 5000,
    rules: [
      {
        rule_id: "rule-1",
        subject_ids: ["usr-1"],
        acting_client_ids: ["*"],
        resource_id: "res-1",
        capability_id: "cap-1",
        disposition: "ALLOW",
        public_models: ["gpt-4", "claude-3"],
        mcp_tools: ["tool-1", "tool-2"],
      },
      {
        rule_id: "rule-2",
        subject_ids: ["usr-agent"],
        acting_client_ids: ["*"],
        resource_id: "res-1",
        capability_id: "cap-1",
        disposition: "ALLOW",
        public_models: ["gpt-4", "gemini-pro"],
        mcp_tools: ["tool-2", "tool-3"],
      },
    ],
    subject_contexts: [
      {
        subject_id: "agent-target",
        kind: "AGENT",
      },
    ],
  }

  const baseInput: AuthorizationInput = {
    tenantId: "tenant-1",
    subjectId: "usr-1",
    actingClientId: "client-1",
    resourceId: "res-1",
    capabilityId: "cap-1",
    now: 2000,
    correlationId: "corr-1",
    requestProtocol: "API",
  }

  test("direct authorization works", () => {
    const result = authorize(mockBundle, baseInput)
    expect(result.disposition).toBe("ALLOW")
    expect(result.allowedPublicModels).toEqual(["gpt-4", "claude-3"])
  })

  test("delegated authorization intersects public models correctly", () => {
    const input: AuthorizationInput = {
      ...baseInput,
      subjectId: "usr-agent",
      subjectKind: "AGENT",
      authorityMode: "DELEGATED",
      principalSubjectId: "usr-1",
      targetAgentSubjectId: "agent-target",
      requestProtocol: "A2A",
      a2aOperation: "SEND_MESSAGE",
    }
    const result = authorize(mockBundle, input)
    expect(result.disposition).toBe("ALLOW")
    // Intersection of ["gpt-4", "gemini-pro"] and ["gpt-4", "claude-3"] is ["gpt-4"]
    expect(result.allowedPublicModels).toEqual(["gpt-4"])
    // Intersection of ["tool-2", "tool-3"] and ["tool-1", "tool-2"] is ["tool-2"]
    expect(result.allowedMcpTools).toEqual(["tool-2"])
  })

  test("delegated authorization with wildcard / empty allowedPublicModels", () => {
    const bundleWithWildcard: CompiledAuthorizationBundle = {
      ...mockBundle,
      rules: [
        {
          rule_id: "rule-agent",
          subject_ids: ["usr-agent"],
          acting_client_ids: ["*"],
          resource_id: "res-1",
          capability_id: "cap-1",
          disposition: "ALLOW",
          public_models: [], // empty array = allows any model
        },
        {
          rule_id: "rule-principal",
          subject_ids: ["usr-1"],
          acting_client_ids: ["*"],
          resource_id: "res-1",
          capability_id: "cap-1",
          disposition: "ALLOW",
          public_models: ["gpt-4"],
        },
      ],
    }

    const input: AuthorizationInput = {
      ...baseInput,
      subjectId: "usr-agent",
      subjectKind: "AGENT",
      authorityMode: "DELEGATED",
      principalSubjectId: "usr-1",
      targetAgentSubjectId: "agent-target",
      requestProtocol: "A2A",
      a2aOperation: "SEND_MESSAGE",
    }
    const result = authorize(bundleWithWildcard, input)
    expect(result.disposition).toBe("ALLOW")
    // left is empty ([]), right is ["gpt-4"]. intersectGrants([], ["gpt-4"]) => ["gpt-4"]
    expect(result.allowedPublicModels).toEqual(["gpt-4"])
  })

  test("delegated authorization with large model lists (testing Set optimization threshold)", () => {
    const largeModels1 = Array.from({ length: 50 }, (_, i) => `model-${i}`)
    const largeModels2 = Array.from({ length: 50 }, (_, i) => `model-${i + 25}`)

    const bundleLarge: CompiledAuthorizationBundle = {
      ...mockBundle,
      rules: [
        {
          rule_id: "rule-agent",
          subject_ids: ["usr-agent"],
          acting_client_ids: ["*"],
          resource_id: "res-1",
          capability_id: "cap-1",
          disposition: "ALLOW",
          public_models: largeModels1,
        },
        {
          rule_id: "rule-principal",
          subject_ids: ["usr-1"],
          acting_client_ids: ["*"],
          resource_id: "res-1",
          capability_id: "cap-1",
          disposition: "ALLOW",
          public_models: largeModels2,
        },
      ],
    }

    const input: AuthorizationInput = {
      ...baseInput,
      subjectId: "usr-agent",
      subjectKind: "AGENT",
      authorityMode: "DELEGATED",
      principalSubjectId: "usr-1",
      targetAgentSubjectId: "agent-target",
      requestProtocol: "A2A",
      a2aOperation: "SEND_MESSAGE",
    }
    const result = authorize(bundleLarge, input)
    expect(result.disposition).toBe("ALLOW")
    // Expected intersection: model-25 to model-49 (25 models)
    const expected = Array.from({ length: 25 }, (_, i) => `model-${i + 25}`)
    expect(result.allowedPublicModels).toEqual(expected)
  })
})
