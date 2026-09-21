import type { BotRules, BotPolicyRevision } from "./drafts"
import type { Principal } from "../tenancy-auth/contract"
import type { OnePolicyBotCapability, OnePolicyBotDecision, OnePolicyBotSeed } from "./contract"
import type {
  RuntimePolicyAuditEvent,
  RuntimePolicyAuthorizeBody,
  RuntimePolicyDecision,
  RuntimePolicyDefinition,
  RuntimePolicyRevision,
  RuntimePolicyReportBody,
  RuntimePolicyEffectiveQuery,
} from "./runtime"

export interface OnePolicySeedStore {
  revisions(tenantId: string): Promise<BotPolicyRevision[]>
  getOrCreate(input: { tenantId: string }): Promise<OnePolicyBotSeed>
  publish(input: { tenantId: string; baseRevision: number; rules: BotRules; publishedBy: string; correlationId?: string }): Promise<OnePolicyBotSeed>
  publishDraft(input: { tenantId: string; expectedVersion: number; expectedContentDigest: string; publishedBy: string; correlationId?: string }): Promise<OnePolicyBotSeed>
  setEnabled(input: { tenantId: string; enabled: boolean; publishedBy: string; correlationId: string }): Promise<OnePolicyBotSeed>
}

export interface RuntimePolicyStore {
  list(tenantId: string): Promise<RuntimePolicyRevision[]>
  listLatest(tenantId: string): Promise<RuntimePolicyRevision[]>
  getLatest(input: { tenantId: string; policyId?: string }): Promise<RuntimePolicyRevision | null>
  getRevision(input: { tenantId: string; policyId: string; revision: number }): Promise<RuntimePolicyRevision | null>
  ensureDefault(input: { tenantId: string }): Promise<RuntimePolicyRevision>
  publish(input: {
    tenantId: string
    policyId: string
    baseRevision: number
    definition: RuntimePolicyDefinition
    publishedBy: string
    displayName?: string
    correlationId?: string
  }): Promise<RuntimePolicyRevision>
  publishDraft(input: { tenantId: string; policyId: string; expectedVersion: number; expectedContentDigest: string; publishedBy: string; correlationId?: string }): Promise<RuntimePolicyRevision>
  setEnabled(input: {
    tenantId: string
    policyId: string
    expectedRevision: number
    enabled: boolean
    publishedBy: string
    correlationId: string
  }): Promise<RuntimePolicyRevision>
}

export interface OnePolicyRuntimeAuditSink {
  record(input: { tenantId: string; event: RuntimePolicyAuditEvent }): Promise<unknown>
  findRuntimeAuthorization(input: { tenantId: string; correlationId: string }): Promise<RuntimePolicyAuditEvent | null>
  findRuntimeReport(input: { tenantId: string; correlationId: string }): Promise<RuntimePolicyAuditEvent | null>
}

export interface OnePolicyRuntimeReportVerifier {
  verify(input: { body: RuntimePolicyReportBody; keyId: string; signature: string }): boolean
}

export interface OnePolicy {
  listFirstPartyBotPolicyRevisions(tenantId: string): Promise<BotPolicyRevision[]>
  publishFirstPartyBotPolicy(input: { tenantId: string; baseRevision: number; rules: BotRules; publishedBy: string; correlationId?: string }): Promise<OnePolicyBotSeed>
  publishFirstPartyBotPolicyDraft(input: { tenantId: string; expectedVersion: number; expectedContentDigest: string; publishedBy: string; correlationId?: string }): Promise<OnePolicyBotSeed>
  getFirstPartyBotSeed(input: { tenantId: string }): Promise<OnePolicyBotSeed>
  setFirstPartyBotSeedEnabled(input: { tenantId: string; enabled: boolean; publishedBy: string; correlationId: string }): Promise<OnePolicyBotSeed>
  resolveBotAccess(input: {
    tenantId: string
    principal: Pick<Principal, "subject_id" | "client_id" | "role">
    capabilityId: OnePolicyBotCapability
  }): Promise<OnePolicyBotDecision>
  listRuntimePolicies(tenantId: string): Promise<RuntimePolicyRevision[]>
  listRuntimePolicyRevisions(tenantId: string): Promise<RuntimePolicyRevision[]>
  getRuntimePolicy(input: { tenantId: string; policyId?: string }): Promise<RuntimePolicyRevision>
  getRuntimePolicyRevision(input: { tenantId: string; policyId: string; revision: number }): Promise<RuntimePolicyRevision | null>
  publishRuntimePolicy(input: {
    tenantId: string
    policyId: string
    baseRevision: number
    definition: RuntimePolicyDefinition
    publishedBy: string
    correlationId?: string
  }): Promise<RuntimePolicyRevision>
  publishRuntimePolicyDraft(input: { tenantId: string; policyId: string; expectedVersion: number; expectedContentDigest: string; publishedBy: string; correlationId?: string }): Promise<RuntimePolicyRevision>
  setRuntimePolicyEnabled(input: {
    tenantId: string
    policyId: string
    expectedRevision: number
    enabled: boolean
    publishedBy: string
    correlationId: string
  }): Promise<RuntimePolicyRevision>
  evaluateRuntime(input: RuntimePolicyEffectiveQuery & {
    principal: Pick<Principal, "tenant_id" | "subject_id" | "client_id" | "role" | "organization_ids">
    correlation_id?: string | null
    recordAudit?: boolean
  }): Promise<RuntimePolicyDecision>
  authorizeRuntime(input: RuntimePolicyAuthorizeBody & {
    principal: Pick<Principal, "tenant_id" | "subject_id" | "client_id" | "role" | "organization_ids">
  }): Promise<RuntimePolicyDecision>
  reportRuntime(input: RuntimePolicyReportBody & {
    principal: Pick<Principal, "tenant_id" | "subject_id" | "client_id" | "role" | "organization_ids">
    reportAttestation: { keyId: string; signature: string }
  }): Promise<RuntimePolicyAuditEvent>
}
