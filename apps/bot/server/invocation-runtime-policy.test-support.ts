import type { RuntimePolicyDecision, RuntimePolicyResolveInput, RuntimePolicyResolver } from "./runtime-policy-contract"

export function invocationPolicyDecision(input: RuntimePolicyResolveInput, correlationId: string, decision: "ALLOW" | "DENY" = "ALLOW"): RuntimePolicyDecision {
  return {
    tenant_id: input.principal.tenant_id,
    subject_id: input.principal.subject_id,
    client_id: input.principal.acting_client_id,
    bot_id: input.botId,
    runtime_id: input.runtimeId ?? "codex",
    policy_id: "one-policy.runtime.capabilities",
    policy_display_name: "Runtime capabilities",
    policy_revision: 1,
    capability_id: input.capabilityId,
    action: input.action,
    target: `runtime:codex:${input.capabilityId}`,
    decision,
    reason_code: decision === "ALLOW" ? "RULE_ALLOW:runtime" : "RULE_DENY:runtime",
    constraints: [],
    obligations: [{ kind: "audit", enforcement_point_id: "AGENT_RUNTIME", parameters: {} }],
    correlation_id: correlationId,
    session_id: input.sessionId ?? null,
    evaluated_at: Date.now(),
  }
}

export function createInvocationRuntimePolicy(): RuntimePolicyResolver {
  let sequence = 0
  return {
    resolve: async (input) => invocationPolicyDecision(input, `resolve-${++sequence}`),
    authorize: async (input) => invocationPolicyDecision(input, `authorize-${++sequence}`),
    read: async () => { throw new Error("RUNTIME_POLICY_READ_UNUSED") },
    report: async () => undefined,
  }
}
