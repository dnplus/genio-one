import { describe, expect, test } from "bun:test"
import { authorize } from "./authorize"
import type { CompiledAuthorizationBundle, CompiledAuthorizationRule, AuthorizationInput, AuthorizationDecision } from "@genioone/protocol/authorization"
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

  test("an unrecognized matching disposition does not authorize", () => {
    const invalidRule = {
      ...mockBundle.rules[0]!,
      disposition: "UNKNOWN",
    } as unknown as CompiledAuthorizationRule
    const result = authorize({ ...mockBundle, rules: [invalidRule] }, baseInput)

    expect(result.disposition).toBe("DENY")
    expect(result.reason).toBe("NO_MATCHING_ENTITLEMENT")
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

  for (const scenario of [
    { agentTools: ["shared", "agent-only"], principalTools: ["shared"], requestedTool: "agent-only" },
    { agentTools: ["tool-2", "tool-3"], principalTools: ["tool-1", "tool-2"], requestedTool: "tool-3" },
  ]) {
    test(`denies delegated MCP tools/call for ${scenario.requestedTool} outside the agent∩principal intersection`, () => {
      const bundle = {
        ...mockBundle,
        rules: [
          { ...mockBundle.rules[0]!, mcp_tools: scenario.principalTools },
          { ...mockBundle.rules[1]!, mcp_tools: scenario.agentTools },
        ],
      }
      const result = authorize(bundle, {
        ...baseInput,
        subjectId: "usr-agent",
        subjectKind: "AGENT",
        authorityMode: "DELEGATED",
        principalSubjectId: "usr-1",
        requestProtocol: "MCP",
        mcpMethod: "tools/call",
        mcpTool: scenario.requestedTool,
      })
      expect(result.disposition).toBe("DENY")
      expect(result.reason).toBe("NO_MATCHING_ENTITLEMENT")
      expect(result.allowedMcpTools).toEqual([])
    })
  }

  test("allows delegated MCP tools/call for a requested tool inside the agent∩principal intersection", () => {
    const result = authorize(mockBundle, {
      ...baseInput,
      subjectId: "usr-agent",
      subjectKind: "AGENT",
      authorityMode: "DELEGATED",
      principalSubjectId: "usr-1",
      requestProtocol: "MCP",
      mcpMethod: "tools/call",
      mcpTool: "tool-2",
    })
    expect(result.disposition).toBe("ALLOW")
    expect(result.allowedMcpTools).toEqual(["tool-2"])
  })

  test("delegated MCP tool wildcard retains direct literal matching semantics", () => {
    const bundle = {
      ...mockBundle,
      rules: mockBundle.rules.map((rule) => ({ ...rule, mcp_tools: ["*"] })),
    }
    for (const authorityMode of ["DIRECT", "DELEGATED"] as const) {
      for (const mcpTool of ["tool-2", "*"]) {
        const result = authorize(bundle, {
          ...baseInput,
          subjectId: "usr-agent",
          subjectKind: "AGENT",
          authorityMode,
          principalSubjectId: authorityMode === "DELEGATED" ? "usr-1" : undefined,
          requestProtocol: "MCP",
          mcpMethod: "tools/call",
          mcpTool,
        })
        expect(result.disposition).toBe(mcpTool === "*" ? "ALLOW" : "DENY")
        expect(result.allowedMcpTools).toEqual(mcpTool === "*" ? ["*"] : [])
      }
    }
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

  function expectDenied(bundle: CompiledAuthorizationBundle, input: AuthorizationInput, reason: AuthorizationDecision["reason"]) {
    const decision = authorize(bundle, input)
    expect(decision.disposition).toBe("DENY")
    expect(decision.reason).toBe(reason)
    expect(decision.allowedPublicModels).toEqual([])
    expect(decision.allowedMcpTools).toEqual([])
    expect(decision.requiredObligations).toEqual([])
    expect(decision.bundleRevision).toBe(bundle.revision)
    expect(decision.policyVersion).toBe(bundle.policy_version)
    return decision
  }

  test("tenant isolation precedes bundle expiry and matching grants", () => {
    expectDenied(mockBundle, { ...baseInput, tenantId: "other-tenant", now: 5000 }, "TENANT_MISMATCH")
  })

  for (const [now, allowed] of [[999, false], [1000, true], [4999, true], [5000, false], [5001, false]] as const) {
    test(`bundle validity boundary at ${now}`, () => {
      const input = { ...baseInput, now }
      if (allowed) expect(authorize(mockBundle, input).disposition).toBe("ALLOW")
      else expectDenied(mockBundle, input, "BUNDLE_EXPIRED")
    })
  }

  for (const field of ["subjectId", "actingClientId", "resourceId", "capabilityId"] as const) {
    test(`a mismatched ${field} cannot reuse an entitlement`, () => {
      const rule = { ...mockBundle.rules[0]!, acting_client_ids: ["client-1"] }
      expectDenied({ ...mockBundle, rules: [rule] }, { ...baseInput, [field]: "other" }, "NO_MATCHING_ENTITLEMENT")
    })
  }

  test("subject and client wildcards admit otherwise unmatched identities", () => {
    const rule = { ...mockBundle.rules[0]!, subject_ids: ["*"], acting_client_ids: ["*"] }
    expect(authorize({ ...mockBundle, rules: [rule] }, { ...baseInput, subjectId: "other", actingClientId: "other" }).disposition).toBe("ALLOW")
  })

  for (const denyFirst of [true, false]) {
    test(`matching deny takes precedence when placed ${denyFirst ? "before" : "after"} allow`, () => {
      const allow = mockBundle.rules[0]!
      const deny = { ...allow, rule_id: "deny", disposition: "DENY" as const }
      const result = expectDenied({ ...mockBundle, rules: denyFirst ? [deny, allow] : [allow, deny] }, baseInput, "DENIED_BY_RULE")
      expect(result.ruleId).toBe("deny")
    })
  }

  test("an unrelated deny does not suppress a matching allow", () => {
    const deny = { ...mockBundle.rules[0]!, rule_id: "deny", resource_id: "other", disposition: "DENY" as const }
    expect(authorize({ ...mockBundle, rules: [deny, ...mockBundle.rules] }, baseInput).disposition).toBe("ALLOW")
  })

  test("model membership selects the supporting rule and rejects ungranted models", () => {
    const extra = { ...mockBundle.rules[0]!, rule_id: "second", public_models: ["gemini-pro"] }
    const bundle = { ...mockBundle, rules: [mockBundle.rules[0]!, extra] }
    expect(authorize(bundle, { ...baseInput, requestedPublicModel: "gemini-pro" }).ruleId).toBe("second")
    expectDenied(bundle, { ...baseInput, requestedPublicModel: "unknown" }, "MODEL_NOT_ENTITLED")
  })

  for (const tool of [undefined, "unknown", "TOOL-1"]) {
    test(`MCP tools/call rejects tool ${String(tool)}`, () => {
      expectDenied(mockBundle, { ...baseInput, requestProtocol: "MCP", mcpMethod: "tools/call", mcpTool: tool }, "NO_MATCHING_ENTITLEMENT")
    })
  }

  test("MCP calls match tool allowlists across capability projections", () => {
    const result = authorize(mockBundle, { ...baseInput, capabilityId: "different-projection", requestProtocol: "MCP", mcpMethod: "tools/call", mcpTool: "tool-1" })
    expect(result.disposition).toBe("ALLOW")
    expect(result.allowedMcpTools).toEqual(["tool-1", "tool-2"])
  })

  for (const tools of [undefined, []]) {
    test(`MCP discovery denies a rule with ${tools === undefined ? "missing" : "empty"} tool grants`, () => {
      const rule = { ...mockBundle.rules[0]!, mcp_tools: tools }
      expectDenied({ ...mockBundle, rules: [rule] }, { ...baseInput, requestProtocol: "MCP", mcpMethod: "tools/list" }, "NO_MATCHING_ENTITLEMENT")
    })
  }

  const delegatedInput: AuthorizationInput = {
    ...baseInput, subjectId: "usr-agent", subjectKind: "AGENT", authorityMode: "DELEGATED",
    principalSubjectId: "usr-1", requestProtocol: "A2A", targetAgentSubjectId: "agent-target", a2aOperation: "SEND_MESSAGE",
    delegationId: "delegation-1", delegationRevision: 2, delegationRevocationGeneration: 3,
  }

  for (const principalSubjectId of [undefined, "unknown-principal"]) {
    test(`delegation denies ${principalSubjectId === undefined ? "missing" : "unentitled"} principal`, () => {
      expectDenied(mockBundle, { ...delegatedInput, principalSubjectId }, "NO_MATCHING_ENTITLEMENT")
    })
  }

  for (const subjectId of ["usr-agent", "usr-1"]) {
    test(`delegation cannot bypass an explicit deny for ${subjectId}`, () => {
      const deny = { ...mockBundle.rules[0]!, rule_id: "deny", subject_ids: [subjectId], disposition: "DENY" as const }
      expectDenied({ ...mockBundle, rules: [...mockBundle.rules, deny] }, delegatedInput, "NO_MATCHING_ENTITLEMENT")
    })
  }

  test("delegation combines obligations and preserves bounded acting-chain evidence", () => {
    const bundle = { ...mockBundle, rules: mockBundle.rules.map((rule, i) => ({ ...rule, required_obligations: i === 0 ? ["audit", "dlp"] : ["audit", "approval"] })) }
    const result = authorize(bundle, delegatedInput)
    expect(result.disposition).toBe("ALLOW")
    expect(result.supportingRuleIds).toEqual(["rule-2", "rule-1"])
    expect(result.ruleId).toBe("rule-1")
    expect(result.requiredObligations).toEqual(["approval", "audit", "dlp"])
    expect(result.agentActingChain).toEqual({ authority_mode: "DELEGATED", calling_agent_subject_id: "usr-agent", target_agent_subject_id: "agent-target", principal_subject_id: "usr-1", delegation_id: "delegation-1", delegation_revision: 2, delegation_revocation_generation: 3 })
  })

  test("delegated MCP calls deny disjoint tool grants and retain their intersection", () => {
    const disjoint = { ...mockBundle, rules: mockBundle.rules.map((rule) => rule.rule_id === "rule-1" ? { ...rule, mcp_tools: ["tool-1"] } : rule) }
    expectDenied(disjoint, { ...delegatedInput, requestProtocol: "MCP", mcpMethod: "tools/call", mcpTool: "tool-3" }, "NO_MATCHING_ENTITLEMENT")
    const result = authorize(mockBundle, { ...delegatedInput, requestProtocol: "MCP", mcpMethod: "tools/call", mcpTool: "tool-2" })
    expect(result.disposition).toBe("ALLOW")
    expect(result.allowedMcpTools).toEqual(["tool-2"])
  })

  for (const patch of [
    { subjectKind: "PERSON" as const },
    { a2aOperation: undefined },
    { targetAgentSubjectId: "unknown" },
    { targetAgentSubjectId: "usr-agent" },
  ]) {
    test(`A2A rejects invalid caller or target: ${JSON.stringify(patch)}`, () => {
      expectDenied(mockBundle, { ...delegatedInput, ...patch }, "NO_MATCHING_ENTITLEMENT")
    })
  }

})
