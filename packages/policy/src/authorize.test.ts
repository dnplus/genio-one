import { GENIOONE_SCOPES, RESOURCE_SCOPE_VALUES } from "@genioone/protocol/authorization-scopes"
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
    authorizationScopes: RESOURCE_SCOPE_VALUES,
  }

  test("direct authorization works", () => {
    const result = authorize(mockBundle, baseInput)
    expect(result.disposition).toBe("ALLOW")
    expect(result.allowedPublicModels).toEqual(["gpt-4", "claude-3"])
  })

  test("verified scopes intersect published API semantics and never replace entitlement", () => {
    const readBundle: CompiledAuthorizationBundle = {
      ...mockBundle,
      capability_operations: [{ resource_id: "res-1", capability_id: "cap-1", operation_semantics: "READ" }],
    }
    expect(authorize(readBundle, { ...baseInput, authorizationScopes: [GENIOONE_SCOPES.read] }).disposition).toBe("ALLOW")
    expect(authorize(readBundle, { ...baseInput, authorizationScopes: [GENIOONE_SCOPES.write] }).reason).toBe("INSUFFICIENT_SCOPE")
    expect(authorize(mockBundle, { ...baseInput, authorizationScopes: [GENIOONE_SCOPES.read] }).reason).toBe("INSUFFICIENT_SCOPE")
    expect(authorize(mockBundle, { ...baseInput, authorizationScopes: undefined }).reason).toBe("INSUFFICIENT_SCOPE")
    expect(authorize(readBundle, { ...baseInput, subjectId: "not-entitled", authorizationScopes: [GENIOONE_SCOPES.read] }).reason).toBe("NO_MATCHING_ENTITLEMENT")
  })

  test("models require invoke and management scopes cannot authorize Resource execution", () => {
    const llm = { ...baseInput, requestProtocol: "LLM" as const, requestedPublicModel: "gpt-4" }
    for (const scopes of [[GENIOONE_SCOPES.read], [GENIOONE_SCOPES.write], ["management:resources:write"]]) {
      expect(authorize(mockBundle, { ...llm, authorizationScopes: scopes }).reason).toBe("INSUFFICIENT_SCOPE")
    }
    expect(authorize(mockBundle, { ...llm, authorizationScopes: [GENIOONE_SCOPES.invoke] }).disposition).toBe("ALLOW")
  })

  test("MCP discovery and each tool call use their published semantics", () => {
    const scopedBundle: CompiledAuthorizationBundle = {
      ...mockBundle,
      capability_operations: [
        { resource_id: "res-1", capability_id: "cap-read", mcp_tool: "tool-1", operation_semantics: "READ" },
        { resource_id: "res-1", capability_id: "cap-write", mcp_tool: "tool-2", operation_semantics: "WRITE" },
      ],
    }
    const mcp = { ...baseInput, requestProtocol: "MCP" as const, authorizationScopes: [GENIOONE_SCOPES.read], mcpMethod: "tools/call", mcpTool: "tool-1" }
    expect(authorize(scopedBundle, mcp).disposition).toBe("ALLOW")
    expect(authorize(scopedBundle, { ...mcp, mcpTool: "tool-2" }).reason).toBe("INSUFFICIENT_SCOPE")
    expect(authorize(scopedBundle, { ...mcp, mcpTool: "unknown-tool" }).reason).toBe("NO_MATCHING_ENTITLEMENT")
    expect(authorize(scopedBundle, { ...mcp, mcpMethod: "tools/list", mcpTool: undefined }).allowedMcpTools).toEqual(["tool-1"])
    expect(authorize(scopedBundle, { ...mcp, mcpMethod: "resources/read", mcpTool: undefined }).disposition).toBe("ALLOW")
    expect(authorize(scopedBundle, { ...mcp, mcpMethod: "tools/list", mcpTool: undefined, authorizationScopes: [GENIOONE_SCOPES.write] }).reason).toBe("INSUFFICIENT_SCOPE")
    expect(authorize(scopedBundle, { ...mcp, authorizationScopes: [GENIOONE_SCOPES.invoke] }).reason).toBe("INSUFFICIENT_SCOPE")
    expect(authorize(mockBundle, mcp).reason).toBe("INSUFFICIENT_SCOPE")
  })

  test("delegated MCP reads constrain the original tool once without requiring write consent", () => {
    const scopedBundle: CompiledAuthorizationBundle = {
      ...mockBundle,
      capability_operations: [{ resource_id: "res-1", capability_id: "cap-read", mcp_tool: "tool-2", operation_semantics: "READ" }],
    }
    const delegated: AuthorizationInput = {
      ...baseInput,
      subjectId: "usr-agent",
      subjectKind: "AGENT",
      authorityMode: "DELEGATED",
      principalSubjectId: "usr-1",
      requestProtocol: "MCP",
      mcpMethod: "tools/call",
      mcpTool: "tool-2",
      authorizationScopes: [GENIOONE_SCOPES.read],
    }
    expect(authorize(scopedBundle, delegated).disposition).toBe("ALLOW")
    expect(authorize(scopedBundle, delegated).allowedMcpTools).toEqual(["tool-2"])
    expect(authorize(scopedBundle, { ...delegated, mcpTool: "tool-3" }).reason).toBe("NO_MATCHING_ENTITLEMENT")
    expect(authorize(scopedBundle, { ...delegated, authorizationScopes: undefined }).reason).toBe("INSUFFICIENT_SCOPE")
  })

  test("delegated A2A still requires invoke after Principal and Agent entitlement intersection", () => {
    const delegated: AuthorizationInput = {
      ...baseInput,
      subjectId: "usr-agent",
      subjectKind: "AGENT",
      authorityMode: "DELEGATED",
      principalSubjectId: "usr-1",
      targetAgentSubjectId: "agent-target",
      requestProtocol: "A2A",
      a2aOperation: "SEND_MESSAGE",
    }
    expect(authorize(mockBundle, { ...delegated, authorizationScopes: [GENIOONE_SCOPES.invoke] }).disposition).toBe("ALLOW")
    expect(authorize(mockBundle, { ...delegated, authorizationScopes: [GENIOONE_SCOPES.read] }).reason).toBe("INSUFFICIENT_SCOPE")
    expect(authorize(mockBundle, { ...delegated, authorizationScopes: undefined }).reason).toBe("INSUFFICIENT_SCOPE")
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
    expect(result.allowedPublicModels).toEqual(["gpt-4"])
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

  for (const principalTools of [undefined, []]) {
    for (const mcpMethod of ["tools/call", "tools/list"]) {
      test(`delegated ${mcpMethod} preserves ${principalTools === undefined ? "missing" : "empty"} principal tool grants`, () => {
        const bundle = {
          ...mockBundle,
          rules: mockBundle.rules.map((rule) => rule.rule_id === "rule-1"
            ? { ...rule, mcp_tools: principalTools }
            : rule),
        }
        const result = authorize(bundle, {
          ...delegatedInput,
          requestProtocol: "MCP",
          mcpMethod,
          mcpTool: mcpMethod === "tools/call" ? "tool-2" : undefined,
        })
        expect(result.disposition).toBe(mcpMethod === "tools/call" ? "DENY" : "ALLOW")
        expect(result.reason).toBe(mcpMethod === "tools/call" ? "NO_MATCHING_ENTITLEMENT" : "ALLOWED_BY_RULE")
        expect(result.allowedMcpTools).toEqual([])
      })
    }
  }

  for (const emptyRuleId of ["rule-1", "rule-2"]) {
    test(`delegated non-MCP decisions preserve empty tool grants for ${emptyRuleId}`, () => {
      const bundle = {
        ...mockBundle,
        rules: mockBundle.rules.map((rule) => rule.rule_id === emptyRuleId
          ? { ...rule, mcp_tools: [] }
          : rule),
      }
      const result = authorize(bundle, delegatedInput)
      expect(result.disposition).toBe("ALLOW")
      expect(result.allowedMcpTools).toEqual([])
      expect(result.allowedPublicModels).toEqual(["gpt-4"])
    })
  }

  for (const length of [31, 32]) {
    test(`delegated MCP tool intersection preserves grants at principal list length ${length}`, () => {
      const principalTools = ["tool-2", ...Array.from({ length: length - 1 }, (_, index) => `principal-${index}`)]
      const bundle = {
        ...mockBundle,
        rules: mockBundle.rules.map((rule) => rule.rule_id === "rule-1"
          ? { ...rule, mcp_tools: principalTools }
          : rule),
      }
      const input: AuthorizationInput = { ...delegatedInput, requestProtocol: "MCP", mcpMethod: "tools/call" }
      const allowed = authorize(bundle, { ...input, mcpTool: "tool-2" })
      expect(allowed.disposition).toBe("ALLOW")
      expect(allowed.allowedMcpTools).toEqual(["tool-2"])
      expectDenied(bundle, { ...input, mcpTool: "tool-3" }, "NO_MATCHING_ENTITLEMENT")
    })
  }

  for (const wildcardSubjectIds of [["usr-agent"], ["usr-1"], ["usr-agent", "usr-1"]]) {
    test(`delegated model wildcards remain unrestricted for ${wildcardSubjectIds.join(",")}`, () => {
      const bundle = {
        ...mockBundle,
        rules: mockBundle.rules.map((rule) => wildcardSubjectIds.includes(rule.subject_ids[0]!)
          ? { ...rule, public_models: [] }
          : { ...rule, public_models: ["gpt-4"] }),
      }
      const result = authorize(bundle, { ...delegatedInput, requestedPublicModel: "gpt-4" })
      expect(result.disposition).toBe("ALLOW")
      expect(result.allowedPublicModels).toEqual(wildcardSubjectIds.length === 2 ? [] : ["gpt-4"])
    })
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
