import { randomUUID } from "node:crypto"

import {
  RUNTIME_REPORT_KEY_ID_HEADER,
  RUNTIME_REPORT_SIGNATURE_HEADER,
  signRuntimeReport,
} from "../../../runtimes/gateway/services/shared/runtime-report-attestation"

import {
  RUNTIME_POLICY_ACTIONS,
  RUNTIME_POLICY_CAPABILITY_IDS,
  RUNTIME_POLICY_RUNTIME_ID,
  type RuntimePolicyAction,
  type RuntimePolicyConstraint,
  type RuntimePolicyDecision,
  type RuntimePolicyReadInput,
  type RuntimePolicyReportInput,
  type RuntimePolicyResolveInput,
  type RuntimePolicyResolver,
  type RuntimePolicySnapshot,
} from "./runtime-policy-contract"

export class RuntimePolicyUnavailableError extends Error {
  readonly code: string

  constructor(code = "RUNTIME_POLICY_UNAVAILABLE") {
    super(code)
    this.name = "RuntimePolicyUnavailableError"
    this.code = code
  }
}

export class RuntimePolicyConstraintError extends Error {
  readonly decision: RuntimePolicyDecision

  constructor(decision: RuntimePolicyDecision) {
    super("RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED")
    this.name = "RuntimePolicyConstraintError"
    this.decision = decision
  }
}

export class RuntimePolicyDeniedError extends Error {
  readonly decision: RuntimePolicyDecision

  constructor(decision: RuntimePolicyDecision) {
    super(decision.reason_code)
    this.name = "RuntimePolicyDeniedError"
    this.decision = decision
  }
}

interface RuntimePolicyClientOptions {
  environment?: NodeJS.ProcessEnv
  origin?: string
  effectivePath?: string
  authorizePath?: string
  reportKeyId?: string
  reportPrivateKeyPem?: string
  fetch?: (input: URL, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function validAction(value: unknown): value is RuntimePolicyAction {
  return typeof value === "string" && (RUNTIME_POLICY_ACTIONS as readonly string[]).includes(value)
}

function defaultReadAction(capabilityId: string): RuntimePolicyAction {
  if (capabilityId === "codex.subscription") return "use"
  if (capabilityId === "model.invoke") return "invoke"
  return "expose"
}

function parseObligations(value: unknown): RuntimePolicyDecision["obligations"] | null {
  if (!Array.isArray(value)) return null
  const obligations: RuntimePolicyDecision["obligations"] = []
  for (const entry of value) {
    if (!plainRecord(entry) || !nonEmptyString(entry.kind) || !plainRecord(entry.parameters)) return null
    if (entry.enforcement_point_id !== undefined && !nonEmptyString(entry.enforcement_point_id)) return null
    obligations.push({
      kind: entry.kind,
      ...(entry.enforcement_point_id === undefined ? {} : { enforcement_point_id: entry.enforcement_point_id }),
      parameters: entry.parameters,
    })
  }
  return obligations
}

function parseConstraints(value: unknown): RuntimePolicyConstraint[] | null {
  if (!Array.isArray(value)) return null
  const constraints: RuntimePolicyConstraint[] = []
  for (const entry of value) {
    if (!plainRecord(entry) || !nonEmptyString(entry.kind) || !plainRecord(entry.parameters)) return null
    constraints.push({ kind: entry.kind, parameters: entry.parameters })
  }
  return constraints
}

function parseDecision(value: unknown): RuntimePolicyDecision | null {
  if (!plainRecord(value)) return null
  const constraints = parseConstraints(value.constraints)
  const obligations = parseObligations(value.obligations)
  const correlationId = value.correlation_id === null || nonEmptyString(value.correlation_id) ? value.correlation_id : undefined
  const sessionId = value.session_id === null || nonEmptyString(value.session_id) ? value.session_id : undefined
  const policyDisplayName = value.policy_display_name === null || nonEmptyString(value.policy_display_name) ? value.policy_display_name : undefined
  if (
    !nonEmptyString(value.tenant_id) ||
    !nonEmptyString(value.subject_id) ||
    !nonEmptyString(value.client_id) ||
    !nonEmptyString(value.bot_id) ||
    !nonEmptyString(value.runtime_id) ||
    !(value.policy_id === null || nonEmptyString(value.policy_id)) ||
    !(value.policy_revision === null || (Number.isInteger(value.policy_revision) && Number(value.policy_revision) >= 1)) ||
    ((value.policy_id === null) !== (value.policy_revision === null)) ||
    policyDisplayName === undefined ||
    !nonEmptyString(value.capability_id) ||
    !validAction(value.action) ||
    !nonEmptyString(value.target) ||
    (value.decision !== "ALLOW" && value.decision !== "DENY") ||
    !nonEmptyString(value.reason_code) ||
    constraints === null ||
    obligations === null ||
    correlationId === undefined ||
    sessionId === undefined ||
    !Number.isInteger(value.evaluated_at) ||
    Number(value.evaluated_at) < 0
  ) return null
  const policyRevision = value.policy_revision === null ? null : Number(value.policy_revision)
  const evaluatedAt = Number(value.evaluated_at)
  return {
    tenant_id: value.tenant_id,
    subject_id: value.subject_id,
    client_id: value.client_id,
    bot_id: value.bot_id,
    runtime_id: value.runtime_id,
    policy_id: value.policy_id,
    policy_display_name: policyDisplayName,
    policy_revision: policyRevision,
    capability_id: value.capability_id,
    action: value.action,
    target: value.target,
    decision: value.decision,
    reason_code: value.reason_code,
    constraints,
    obligations,
    correlation_id: correlationId,
    session_id: sessionId,
    evaluated_at: evaluatedAt,
  }
}

function pathFor(template: string, tenantId: string): string {
  const encoded = encodeURIComponent(tenantId)
  const path = template.replace("{tenant_id}", encoded).replace(":tenant_id", encoded)
  if (!path.startsWith("/")) throw new RuntimePolicyUnavailableError("RUNTIME_POLICY_PATH_INVALID")
  return path
}

function decisionForInput(decision: RuntimePolicyDecision, input: RuntimePolicyResolveInput, expectedCorrelationId?: string): RuntimePolicyDecision {
  const runtimeId = input.runtimeId ?? RUNTIME_POLICY_RUNTIME_ID
  if (
    decision.tenant_id !== input.principal.tenant_id ||
    decision.subject_id !== input.principal.subject_id ||
    decision.client_id !== input.principal.acting_client_id ||
    decision.bot_id !== input.botId ||
    decision.runtime_id !== runtimeId ||
    decision.capability_id !== input.capabilityId ||
    decision.action !== input.action ||
    decision.target !== `runtime:${runtimeId}:${input.capabilityId}`
  ) throw new RuntimePolicyUnavailableError("RUNTIME_POLICY_RESPONSE_INVALID")
  if (expectedCorrelationId !== undefined && decision.correlation_id !== expectedCorrelationId) {
    throw new RuntimePolicyUnavailableError("RUNTIME_POLICY_CORRELATION_INVALID")
  }
  return decision
}

function withEnforceableRuntimeRequirements(decision: RuntimePolicyDecision): RuntimePolicyDecision {
  if (decision.decision === "DENY") return decision
  if (decision.constraints.length > 0) {
    return {
      ...decision,
      decision: "DENY",
      reason_code: "RUNTIME_POLICY_CONSTRAINT_UNSUPPORTED",
    }
  }
  if (decision.obligations.some((obligation) => obligation.kind !== "audit")) {
    return {
      ...decision,
      decision: "DENY",
      reason_code: "RUNTIME_POLICY_OBLIGATION_UNSUPPORTED",
    }
  }
  return {
    ...decision,
  }
}

export function createRuntimePolicyClient(options: RuntimePolicyClientOptions = {}): RuntimePolicyResolver {
  const environment = options.environment ?? process.env
  const origin = options.origin?.trim() || environment.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
  const effectivePath = options.effectivePath?.trim() || environment.GENIO_ONE_RUNTIME_POLICY_EFFECTIVE_PATH?.trim() || "/v1/tenants/{tenant_id}/one-policy/runtime-effective"
  const authorizePath = options.authorizePath?.trim() || environment.GENIO_ONE_RUNTIME_POLICY_AUTHORIZE_PATH?.trim() || "/v1/tenants/{tenant_id}/one-policy/runtime-authorize"
  const reportPath = environment.GENIO_ONE_RUNTIME_POLICY_REPORT_PATH?.trim() || "/v1/tenants/{tenant_id}/one-policy/runtime-report"
  const reportKeyId = options.reportKeyId?.trim() || environment.GENIO_ONE_RUNTIME_REPORT_KEY_ID?.trim() || ""
  const reportPrivateKeyPem = options.reportPrivateKeyPem ?? environment.GENIO_ONE_RUNTIME_REPORT_PRIVATE_KEY_PEM ?? ""
  const fetcher = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 2_000
  function signReport(body: Record<string, unknown>): string {
    if (!reportKeyId || !reportPrivateKeyPem) throw new RuntimePolicyUnavailableError("RUNTIME_POLICY_REPORT_SIGNER_UNAVAILABLE")
    try {
      return signRuntimeReport(body, reportPrivateKeyPem)
    } catch {
      throw new RuntimePolicyUnavailableError("RUNTIME_POLICY_REPORT_SIGNER_INVALID")
    }
  }

  async function requestDecision(method: "GET" | "POST", input: RuntimePolicyResolveInput): Promise<RuntimePolicyDecision> {
    const runtimeId = input.runtimeId ?? RUNTIME_POLICY_RUNTIME_ID
    const url = new URL(pathFor(method === "GET" ? effectivePath : authorizePath, input.principal.tenant_id), origin)
    const correlationId = method === "POST" ? input.correlationId ?? randomUUID() : undefined
    const headers = {
      accept: "application/json",
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...(input.accessToken ? { authorization: `Bearer ${input.accessToken}` } : {}),
    }
    const query = {
      bot_id: input.botId,
      runtime_id: runtimeId,
      capability_id: input.capabilityId,
      action: input.action,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
    }
    if (method === "GET") {
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    }
    let response: Response
    try {
      response = await fetcher(url, {
        method,
        headers,
        ...(method === "GET" ? { signal: AbortSignal.timeout(timeoutMs) } : {
          body: JSON.stringify({ correlation_id: correlationId, ...query }),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      })
    } catch {
      throw new RuntimePolicyUnavailableError()
    }
    if (!response.ok) throw new RuntimePolicyUnavailableError(`RUNTIME_POLICY_HTTP_${response.status}`)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new RuntimePolicyUnavailableError("RUNTIME_POLICY_RESPONSE_INVALID")
    }
    const decision = parseDecision(body)
    if (!decision) throw new RuntimePolicyUnavailableError("RUNTIME_POLICY_RESPONSE_INVALID")
    return decisionForInput(decision, input, correlationId)
  }

  async function requestReport(input: RuntimePolicyReportInput): Promise<void> {
    if (!nonEmptyString(input.correlationId)) throw new RuntimePolicyUnavailableError("RUNTIME_POLICY_CORRELATION_INVALID")
    const url = new URL(pathFor(reportPath, input.principal.tenant_id), origin)
    const body = {
      correlation_id: input.correlationId,
      bot_id: input.botId,
      runtime_id: input.runtimeId ?? RUNTIME_POLICY_RUNTIME_ID,
      capability_id: input.capabilityId,
      action: input.action,
      outcome: input.outcome,
      ...(input.reasonCode ? { reason_code: input.reasonCode } : {}),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
    }
    const serializedBody = JSON.stringify(body)
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          [RUNTIME_REPORT_KEY_ID_HEADER]: reportKeyId,
          [RUNTIME_REPORT_SIGNATURE_HEADER]: signReport(body),
          ...(input.accessToken ? { authorization: `Bearer ${input.accessToken}` } : {}),
        },
        body: serializedBody,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new RuntimePolicyUnavailableError(`RUNTIME_POLICY_REPORT_HTTP_${response.status}`)
    } catch (error) {
      if (error instanceof RuntimePolicyUnavailableError) throw error
      throw new RuntimePolicyUnavailableError("RUNTIME_POLICY_REPORT_UNAVAILABLE")
    }
  }

  const resolver: RuntimePolicyResolver = {
    async resolve(input) {
      return withEnforceableRuntimeRequirements(await requestDecision("GET", input))
    },
    async authorize(input) {
      const raw = await requestDecision("POST", input)
      return withEnforceableRuntimeRequirements(raw)
    },
    async read(input: RuntimePolicyReadInput): Promise<RuntimePolicySnapshot> {
      const runtimeId = input.runtimeId ?? RUNTIME_POLICY_RUNTIME_ID
      const capabilityIds = input.capabilityIds ?? RUNTIME_POLICY_CAPABILITY_IDS
      const decisions = await Promise.all(capabilityIds.map((capabilityId) => resolver.resolve({
        principal: input.principal,
        botId: input.botId,
        runtimeId,
        capabilityId,
        action: input.action ?? defaultReadAction(capabilityId),
        sessionId: input.sessionId,
        accessToken: input.accessToken,
      })))
      const first = decisions[0]
      if (!first) throw new RuntimePolicyUnavailableError("RUNTIME_POLICY_RESPONSE_INVALID")
      const policyMetadata = new Map<string, { policy_display_name: string | null; policy_revision: number | null }>()
      for (const decision of decisions) {
        if (decision.policy_id === null) continue
        const existing = policyMetadata.get(decision.policy_id)
        if (existing && (existing.policy_display_name !== decision.policy_display_name || existing.policy_revision !== decision.policy_revision)) {
          throw new RuntimePolicyUnavailableError("RUNTIME_POLICY_RESPONSE_INVALID")
        }
        policyMetadata.set(decision.policy_id, {
          policy_display_name: decision.policy_display_name,
          policy_revision: decision.policy_revision,
        })
      }
      const samePolicy = decisions.every((decision) => decision.policy_id === first.policy_id && decision.policy_display_name === first.policy_display_name && decision.policy_revision === first.policy_revision)
      const source = samePolicy ? first : null
      return {
        tenant_id: first.tenant_id,
        subject_id: first.subject_id,
        client_id: first.client_id,
        bot_id: first.bot_id,
        runtime_id: first.runtime_id,
        policy_id: source?.policy_id ?? null,
        policy_display_name: source?.policy_display_name ?? null,
        policy_revision: source?.policy_revision ?? null,
        decisions,
      }
    },
    report: requestReport,
  }

  return resolver
}

export function requireRuntimePolicyDecision(decision: RuntimePolicyDecision): RuntimePolicyDecision {
  const enforceable = withEnforceableRuntimeRequirements(decision)
  if (enforceable.decision === "ALLOW") return enforceable
  throw new RuntimePolicyDeniedError(enforceable)
}
