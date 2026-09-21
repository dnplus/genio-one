import { createPolicyDraftStore, requireBotPolicyDraft, type MemoryPolicyDraftStore, defaultBotRules, type BotPolicyRevision } from "./drafts"
import { PlatformApiError } from "../errors"
import type { Principal } from "../tenancy-auth/contract"
import type { AccessGroupDirectory } from "../access-groups/module"
import type { OnePolicyBotCapability, OnePolicyBotDecision, OnePolicyBotSeed } from "./contract"
import {
  evaluateRuntimePolicies,
  runtimePolicyAuditEvent,
  unconfiguredRuntimeDecision,
  type RuntimePolicyAuditEvent,
  type RuntimePolicyAuthorizeBody,
  type RuntimePolicyDecision,
  type RuntimePolicyEffectiveQuery,
  type RuntimePolicyReportBody,
} from "./runtime"
import type { OnePolicy, OnePolicyRuntimeAuditSink, OnePolicySeedStore, RuntimePolicyStore } from "./module"
import type { OnePolicyRuntimeReportVerifier } from "./module"
import { createInMemoryRuntimePolicyStore } from "./runtime-memory"
import { verifyRuntimeReport } from "../../../../../../runtimes/gateway/services/shared/runtime-report-attestation"
import type { GatewayAuthorizationAuditStore } from "../audit-events/module"
import { policyChangeAuditEvent, policyEnabledAuditEvent, policySystemPublishAuditEvent } from "./lifecycle"
import { createKeyedSerialExecutor } from "../../persistence/keyed-serial-executor"

export const PERSONAL_BOT_RESOURCE = "genio.personal-bot" as const
export const PERSONAL_BOT_USE = "personal_bot.use" as const
export const PERSONAL_BOT_COMPUTER_USE = "personal_bot.computer_use" as const

const POLICY_ID = "one-policy.first-party.bot-default" as const
const POLICY_REVISION = 1 as const

function seed(tenantId: string, at: number, enabled = true): OnePolicyBotSeed {
  return {
    tenant_id: tenantId,
    policy_id: POLICY_ID,
    policy_revision: POLICY_REVISION,
    seed: true,
    rules: structuredClone(defaultBotRules),
    enabled,
    created_at: at,
    updated_at: at,
  }
}

function baseDecision(
  tenantId: string,
  principal: Pick<Principal, "subject_id" | "client_id">,
  capabilityId: OnePolicyBotCapability,
  policySeed: OnePolicyBotSeed,
): OnePolicyBotDecision {
  return {
    tenant_id: tenantId,
    subject_id: principal.subject_id,
    client_id: principal.client_id,
    resource_id: PERSONAL_BOT_RESOURCE,
    capability_id: capabilityId,
    decision: "DENY",
    policy_id: POLICY_ID,
    policy_revision: policySeed.policy_revision,
    model_route: null,
    reason_code: "DEFAULT_POLICY_DENY",
  }
}

function evaluateBotAccess(
  policySeed: OnePolicyBotSeed,
  input: {
    tenantId: string
    principal: Pick<Principal, "subject_id" | "client_id" | "role">
    capabilityId: OnePolicyBotCapability
  },
): OnePolicyBotDecision {
  const { tenantId, principal, capabilityId } = input
  const denied = baseDecision(tenantId, principal, capabilityId, policySeed)
  if (!policySeed.enabled) return { ...denied, reason_code: "FIRST_PARTY_POLICY_DISABLED" }
  if (capabilityId !== PERSONAL_BOT_USE && capabilityId !== PERSONAL_BOT_COMPUTER_USE) {
    return { ...denied, reason_code: "COMPUTER_USE_NOT_IN_DEFAULT_POLICY" }
  }
  if (capabilityId === PERSONAL_BOT_COMPUTER_USE && policySeed.rules.computer_use_enabled !== true) {
    return { ...denied, reason_code: "COMPUTER_USE_NOT_IN_DEFAULT_POLICY" }
  }
  if (principal.client_id !== "genio-one-bot") {
    return { ...denied, reason_code: "BOT_CLIENT_REQUIRED" }
  }
  if (!policySeed.rules.allowed_roles.includes(principal.role as typeof policySeed.rules.allowed_roles[number]) && !policySeed.rules.allowed_subject_ids.includes(principal.subject_id)) {
    return { ...denied, reason_code: policySeed.policy_revision === 1 ? "TENANT_ADMINISTRATOR_REQUIRED" : "POLICY_SUBJECT_NOT_ALLOWED" }
  }
  return {
    ...denied,
    decision: "ALLOW",
    model_route: "codex-subscription",
    reason_code: policySeed.policy_revision === 1 ? "DEFAULT_ADMIN_BOT_ACCESS" : "POLICY_SUBJECT_ALLOWED",
  }
}

function runtimeInput(input: RuntimePolicyEffectiveQuery & {
  principal: Pick<Principal, "tenant_id" | "subject_id" | "client_id" | "role" | "organization_ids">
  correlation_id?: string | null
}, accessGroupIds: readonly string[], evaluatedAt = Math.floor(Date.now() / 1_000)): Parameters<typeof evaluateRuntimePolicies>[1] {
  return {
    tenant_id: input.principal.tenant_id,
    subject_id: input.principal.subject_id,
    client_id: input.principal.client_id,
    role: input.principal.role,
    organization_ids: input.principal.organization_ids,
    access_group_ids: accessGroupIds,
    bot_id: input.bot_id,
    runtime_id: input.runtime_id,
    capability_id: input.capability_id,
    action: input.action,
    correlation_id: input.correlation_id ?? null,
    session_id: input.session_id ?? null,
    evaluated_at: evaluatedAt,
  }
}

function decisionFromAudit(event: RuntimePolicyAuditEvent): RuntimePolicyDecision {
  return {
    tenant_id: event.tenant_id,
    subject_id: event.subject.subject_id,
    client_id: event.acting_client.acting_client_id,
    bot_id: event.bot_id,
    runtime_id: event.runtime_id,
    policy_id: event.policy_id,
    policy_display_name: event.policy_display_name,
    policy_revision: event.policy_revision,
    capability_id: event.capability_id,
    action: event.action,
    target: event.target,
    decision: event.decision,
    reason_code: event.reason_code,
    constraints: event.constraints,
    obligations: event.obligations,
    matched_policy_refs: event.matched_policy_refs,
    correlation_id: event.correlation_id,
    session_id: event.session_id,
    evaluated_at: event.occurred_at,
  }
}

function reportOutcomeMatchesDecision(outcome: RuntimePolicyReportBody["outcome"], decision: RuntimePolicyDecision): boolean {
  if (decision.decision === "DENY") return outcome === "DENY"
  return outcome !== "DENY"
}

export function createDefaultOnePolicy(options: {
  seedStore?: OnePolicySeedStore
  drafts?: MemoryPolicyDraftStore
  runtimeStore?: RuntimePolicyStore
  runtimeAuditSink?: OnePolicyRuntimeAuditSink
  policyAuditSink?: GatewayAuthorizationAuditStore
  runtimeReportVerifier?: OnePolicyRuntimeReportVerifier
  runtimeReportKeyId?: string
  runtimeReportPublicKeyPem?: string
  connectionEnabled?: (input: { tenantId: string; botId: string }) => Promise<boolean> | boolean
  runtimeCapabilityAvailable?: (input: { tenantId: string; botId: string; runtimeId: string; capabilityId: string }) => Promise<boolean> | boolean
  accessGroups?: Pick<AccessGroupDirectory, "groupsForSubject">
  now?: () => number
} = {}): OnePolicy {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  const values = new Map<string, OnePolicyBotSeed>()
  const revisions = new Map<string, BotPolicyRevision[]>()
  const mutations = createKeyedSerialExecutor()
  const runtimeStore = options.runtimeStore ?? createInMemoryRuntimePolicyStore({ now })
  const runtimeReportVerifier = options.runtimeReportVerifier ?? (options.runtimeReportKeyId && options.runtimeReportPublicKeyPem ? {
    verify(input: { body: RuntimePolicyReportBody; keyId: string; signature: string }) {
      return input.keyId === options.runtimeReportKeyId && verifyRuntimeReport({ ...input.body }, input.signature, options.runtimeReportPublicKeyPem!)
    },
  } satisfies OnePolicyRuntimeReportVerifier : undefined)
  const localRuntimeAudits = new Map<string, RuntimePolicyAuditEvent>()
  const drafts = options.drafts ?? createPolicyDraftStore()
  function prepareLocalRevision({ tenantId, baseRevision, rules }: Parameters<OnePolicySeedStore["publish"]>[0]) {
    const current = values.get(tenantId)!
    if (current.policy_revision !== baseRevision) throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
    const updated = { ...current, policy_revision: baseRevision + 1, rules: structuredClone(rules), updated_at: now() }
    return updated
  }
  function commitLocalRevision(updated: OnePolicyBotSeed, publishedBy: string) {
    revisions.get(updated.tenant_id)!.unshift({ policy_revision: updated.policy_revision, rules: structuredClone(updated.rules), published_by: publishedBy, published_at: updated.updated_at })
    values.set(updated.tenant_id, updated)
    return structuredClone(updated)
  }
  const localStore: OnePolicySeedStore = {
    async revisions(tenantId) { await localStore.getOrCreate({ tenantId }); return structuredClone(revisions.get(tenantId) ?? []) },
    async getOrCreate({ tenantId }) {
      const existing = values.get(tenantId)
      if (existing) return structuredClone(existing)
      const created = seed(tenantId, now())
      revisions.set(tenantId, [{ policy_revision: 1, rules: structuredClone(defaultBotRules), published_by: null, published_at: now() }])
      values.set(tenantId, created)
      return structuredClone(created)
    },
    async publish(input) {
      return mutations.run(input.tenantId, async () => {
        await localStore.getOrCreate(input)
        const published = prepareLocalRevision(input)
        if (options.policyAuditSink) {
          await options.policyAuditSink.record({
            tenantId: input.tenantId,
            event: policySystemPublishAuditEvent({
              tenantId: input.tenantId,
              policyKey: POLICY_ID,
              publishedRevision: published.policy_revision,
              content: input.rules,
              actorSubjectId: input.publishedBy,
              correlationId: input.correlationId ?? `policy-system-${POLICY_ID}-${published.policy_revision}`,
              occurredAt: now(),
            }),
          })
        }
        return commitLocalRevision(published, input.publishedBy)
      })
    },
    async publishDraft({ tenantId, expectedVersion, expectedContentDigest, publishedBy, correlationId }) {
      return drafts.consumeAsync(tenantId, POLICY_ID, expectedVersion, (draft) => mutations.run(tenantId, async () => {
        await localStore.getOrCreate({ tenantId })
        const published = prepareLocalRevision({ tenantId, publishedBy, ...requireBotPolicyDraft(draft, expectedVersion, expectedContentDigest) })
        if (options.policyAuditSink) {
          await options.policyAuditSink.record({
            tenantId,
            event: policyChangeAuditEvent({
              tenantId,
              policyKey: POLICY_ID,
              draft,
              action: "PUBLISHED",
              actorSubjectId: publishedBy,
              correlationId: correlationId ?? `policy-publish-${POLICY_ID}-${expectedVersion}`,
              occurredAt: now(),
              publishedRevision: published.policy_revision,
            }),
          })
        }
        return commitLocalRevision(published, publishedBy)
      }))
    },
    async setEnabled({ tenantId, enabled, publishedBy, correlationId }) {
      return mutations.run(tenantId, async () => {
        const existing = values.get(tenantId)
        const current = existing ? structuredClone(existing) : seed(tenantId, now())
        const at = now()
        const updated = {
          ...current,
          policy_revision: current.policy_revision + 1,
          enabled,
          updated_at: at,
        }
        if (!options.policyAuditSink) throw new PlatformApiError("POLICY_AUDIT_UNAVAILABLE", 503)
        await options.policyAuditSink.record({
          tenantId,
          event: policyEnabledAuditEvent({
            tenantId,
            policyKey: POLICY_ID,
            previousRevision: current.policy_revision,
            publishedRevision: updated.policy_revision,
            enabled,
            content: { enabled: updated.enabled, rules: updated.rules },
            actorSubjectId: publishedBy,
            correlationId,
            occurredAt: at,
          }),
        })
        if (!existing) {
          revisions.set(tenantId, [{
            policy_revision: current.policy_revision,
            rules: structuredClone(current.rules),
            published_by: null,
            published_at: current.created_at,
          }])
        }
        return commitLocalRevision(updated, publishedBy)
      })
    },
  }
  const store = options.seedStore ?? localStore

  async function recordRuntimeAudit(event: RuntimePolicyAuditEvent): Promise<void> {
    if (options.runtimeAuditSink) await options.runtimeAuditSink.record({ tenantId: event.tenant_id, event })
    localRuntimeAudits.set(`${event.tenant_id}\0${event.correlation_id}\0${event.phase}`, structuredClone(event))
  }

  async function findRuntimeAuthorization(tenantId: string, correlationId: string): Promise<RuntimePolicyAuditEvent | null> {
    const fromSink = options.runtimeAuditSink ? await options.runtimeAuditSink.findRuntimeAuthorization({ tenantId, correlationId }) : null
    if (fromSink) return fromSink
    return structuredClone(localRuntimeAudits.get(`${tenantId}\0${correlationId}\0AUTHORIZE`) ?? null)
  }

  async function findRuntimeReport(tenantId: string, correlationId: string): Promise<RuntimePolicyAuditEvent | null> {
    const fromSink = options.runtimeAuditSink ? await options.runtimeAuditSink.findRuntimeReport({ tenantId, correlationId }) : null
    if (fromSink) return fromSink
    return structuredClone(localRuntimeAudits.get(`${tenantId}\0${correlationId}\0REPORT`) ?? null)
  }

  const policy: OnePolicy = {
    listFirstPartyBotPolicyRevisions: store.revisions,
    publishFirstPartyBotPolicy: store.publish,
    publishFirstPartyBotPolicyDraft: store.publishDraft,
    getFirstPartyBotSeed: store.getOrCreate,
    setFirstPartyBotSeedEnabled: store.setEnabled,
    async resolveBotAccess(input) {
      const policySeed = await store.getOrCreate({ tenantId: input.tenantId })
      const decision = evaluateBotAccess(policySeed, input)
      if (decision.decision !== "ALLOW" || !options.connectionEnabled) return decision
      let enabled = false
      try {
        enabled = await options.connectionEnabled({ tenantId: input.tenantId, botId: PERSONAL_BOT_RESOURCE })
      } catch {}
      if (!enabled) return { ...baseDecision(input.tenantId, input.principal, input.capabilityId, policySeed), reason_code: "BOT_CONNECTION_DISABLED" }
      return decision
    },
    async listRuntimePolicies(tenantId) {
      return runtimeStore.listLatest(tenantId)
    },
    async listRuntimePolicyRevisions(tenantId) {
      return runtimeStore.list(tenantId)
    },
    async getRuntimePolicy(input) {
      const value = await runtimeStore.getLatest(input)
      if (!value) throw new PlatformApiError("RUNTIME_POLICY_NOT_FOUND", 404)
      return value
    },
    getRuntimePolicyRevision: runtimeStore.getRevision,
    publishRuntimePolicy: runtimeStore.publish,
    publishRuntimePolicyDraft: runtimeStore.publishDraft,
    setRuntimePolicyEnabled: runtimeStore.setEnabled,
    async evaluateRuntime(input) {
      let accessGroupIds: string[] = []
      if (options.accessGroups) {
        try {
          accessGroupIds = (await options.accessGroups.groupsForSubject({
            tenantId: input.principal.tenant_id,
            subjectId: input.principal.subject_id,
          })).map((group) => group.access_group_id)
        } catch {
          return unconfiguredRuntimeDecision(runtimeInput(input, [], now()), "ACCESS_GROUP_RESOLUTION_FAILED")
        }
      }
      const evaluation = runtimeInput(input, accessGroupIds, now())
      let connectionEnabled = true
      if (options.connectionEnabled) {
        connectionEnabled = false
        try {
          connectionEnabled = await options.connectionEnabled({ tenantId: input.principal.tenant_id, botId: PERSONAL_BOT_RESOURCE })
        } catch {}
      }
      const capabilityRegistered = options.runtimeCapabilityAvailable
        ? await options.runtimeCapabilityAvailable({ tenantId: input.principal.tenant_id, botId: input.bot_id, runtimeId: input.runtime_id, capabilityId: input.capability_id })
        : undefined
      const result = evaluateRuntimePolicies(await runtimeStore.listLatest(input.principal.tenant_id), evaluation, { connection_enabled: connectionEnabled, capability_registered: capabilityRegistered })
      if (input.recordAudit) {
        await recordRuntimeAudit(runtimePolicyAuditEvent(result, {
          tenant_id: input.principal.tenant_id,
          subject_id: input.principal.subject_id,
          client_id: input.principal.client_id,
        }, "AUTHORIZE", evaluation.evaluated_at))
      }
      return result
    },
    async authorizeRuntime(input: RuntimePolicyAuthorizeBody & {
      principal: Pick<Principal, "tenant_id" | "subject_id" | "client_id" | "role" | "organization_ids">
    }) {
      const existing = await findRuntimeAuthorization(input.principal.tenant_id, input.correlation_id)
      if (existing) {
        const expectedTarget = `runtime:${input.runtime_id}:${input.capability_id}`
        if (existing.subject.subject_id !== input.principal.subject_id || existing.acting_client.acting_client_id !== input.principal.client_id || existing.bot_id !== input.bot_id || existing.runtime_id !== input.runtime_id || existing.capability_id !== input.capability_id || existing.action !== input.action || existing.target !== expectedTarget || existing.session_id !== (input.session_id ?? null)) {
          throw new PlatformApiError("RUNTIME_AUTHORIZATION_CORRELATION_CONFLICT", 409)
        }
        return decisionFromAudit(existing)
      }
      const result = await policy.evaluateRuntime({ ...input, correlation_id: input.correlation_id, recordAudit: false })
      await recordRuntimeAudit(runtimePolicyAuditEvent(result, {
        tenant_id: input.principal.tenant_id,
        subject_id: input.principal.subject_id,
        client_id: input.principal.client_id,
      }, "AUTHORIZE", result.evaluated_at))
      return result
    },
    async reportRuntime(input: RuntimePolicyReportBody & {
      principal: Pick<Principal, "tenant_id" | "subject_id" | "client_id" | "role" | "organization_ids">
      reportAttestation: { keyId: string; signature: string }
    }) {
      if (!runtimeReportVerifier) throw new PlatformApiError("RUNTIME_REPORT_ATTESTATION_REQUIRED", 403)
      const reportPayload: RuntimePolicyReportBody = {
        correlation_id: input.correlation_id,
        bot_id: input.bot_id,
        runtime_id: input.runtime_id,
        capability_id: input.capability_id,
        action: input.action,
        outcome: input.outcome,
        ...(input.reason_code ? { reason_code: input.reason_code } : {}),
        ...(input.session_id ? { session_id: input.session_id } : {}),
      }
      if (!runtimeReportVerifier.verify({ body: reportPayload, keyId: input.reportAttestation.keyId, signature: input.reportAttestation.signature })) {
        throw new PlatformApiError("RUNTIME_REPORT_ATTESTATION_INVALID", 403)
      }
      const authorization = await findRuntimeAuthorization(input.principal.tenant_id, input.correlation_id)
      if (!authorization) throw new PlatformApiError("RUNTIME_AUTHORIZATION_NOT_FOUND", 404)
      const expectedTarget = `runtime:${input.runtime_id}:${input.capability_id}`
      if (authorization.subject.subject_id !== input.principal.subject_id || authorization.acting_client.acting_client_id !== input.principal.client_id || authorization.bot_id !== input.bot_id || authorization.runtime_id !== input.runtime_id || authorization.capability_id !== input.capability_id || authorization.action !== input.action || authorization.target !== expectedTarget || authorization.session_id !== (input.session_id ?? null)) {
        throw new PlatformApiError("RUNTIME_REPORT_CORRELATION_CONFLICT", 409)
      }
      if (!reportOutcomeMatchesDecision(input.outcome, decisionFromAudit(authorization))) {
        throw new PlatformApiError("RUNTIME_REPORT_OUTCOME_CONFLICT", 409)
      }
      const reportId = `${authorization.audit_event_id}:report`
      const existing = await findRuntimeReport(input.principal.tenant_id, input.correlation_id)
      if (existing) {
        if (existing.audit_event_id !== reportId || existing.report_outcome !== input.outcome || existing.subject.subject_id !== input.principal.subject_id || existing.acting_client.acting_client_id !== input.principal.client_id || existing.target !== expectedTarget || existing.session_id !== (input.session_id ?? null)) throw new PlatformApiError("RUNTIME_REPORT_CORRELATION_CONFLICT", 409)
        return structuredClone(existing)
      }
      const decision = decisionFromAudit(authorization)
      const report = runtimePolicyAuditEvent(decision, {
        tenant_id: input.principal.tenant_id,
        subject_id: input.principal.subject_id,
        client_id: input.principal.client_id,
      }, "REPORT", now(), {
        audit_event_id: reportId,
        authorization_audit_event_id: authorization.audit_event_id,
        report_outcome: input.outcome,
        reason_code: input.reason_code ?? authorization.reason_code,
      })
      await recordRuntimeAudit(report)
      return report
    },
  }

  return policy
}

export { POLICY_ID, POLICY_REVISION, evaluateBotAccess }
