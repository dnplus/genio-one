import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"
import type { IdentityDirectory } from "../identity/module"
import type { OrganizationDirectory } from "../organizations/module"
import type { AccessGovernanceStore } from "../access/module"
import type { GatewayAuthorizationAuditStore } from "../audit-events/module"
import { OnePolicyBotDecisionSchema } from "./contract"
import type { OnePolicy } from "./module"
import { PlatformApiError } from "../errors"
import { RuntimePolicyDecisionSchema, PERSONAL_BOT_RESOURCE_ID, RUNTIME_POLICY_CAPABILITY_IDS, runtimePolicyAuditEvent } from "./runtime"
import { capabilityActions } from "../../../../../../packages/protocol/src/runtime-capability-actions"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const CapabilitySchema = Type.Object({
  resource_id: Identifier,
  resource_display_name: Identifier,
  capability_id: Identifier,
  capability_display_name: Identifier,
  access: Type.String(),
  connection_status: Type.String(),
  restriction_reason: Type.Union([Type.String(), Type.Null()]),
})

export const permissionPreviewHttp: FastifyPluginAsync<{
  policy: OnePolicy
  identity: IdentityDirectory
  organizations: OrganizationDirectory
  access: AccessGovernanceStore
  audit: GatewayAuthorizationAuditStore
}> = async (app, options) => {
  app.withTypeProvider<TypeBoxTypeProvider>().post("/v1/tenants/:tenant_id/one-policy/permission-preview", {
    schema: {
      operationId: "previewUserPermissions",
      tags: ["One Policy"],
      params: Type.Object({ tenant_id: Identifier }),
      body: Type.Object({ subject_id: Identifier, runtime_id: Identifier, client_id: Identifier, bot_id: Identifier }, { additionalProperties: false }),
      response: { 200: Type.Object({
        subject_id: Identifier,
        subject_display_name: Identifier,
        actor_subject_id: Identifier,
        role: Type.String(),
        organization_ids: Type.Array(Identifier),
        runtime_id: Identifier,
        client_id: Identifier,
        bot_id: Identifier,
        evaluated_at: Type.Integer(),
        capabilities: Type.Array(CapabilitySchema),
        bot_access: OnePolicyBotDecisionSchema,
        runtime_decisions: Type.Array(Type.Object({ ...RuntimePolicyDecisionSchema.properties, effective_decision: Type.Union([Type.Literal("ALLOW"), Type.Literal("DENY")]) })),
      }) },
    },
  }, async (request, reply) => {
    const admin = request.principal!
    if (admin.role !== "TENANT_ADMINISTRATOR") throw new PlatformApiError("TENANT_ADMINISTRATOR_REQUIRED", 403)
    const tenantId = request.params.tenant_id
    const subjectId = request.body.subject_id
    const inventory = await options.identity.inventory({ tenantId })
    const subject = inventory.subjects.find((value) => value.subject_id === subjectId && value.kind === "PERSON")
    if (!subject) throw new PlatformApiError("PREVIEW_SUBJECT_NOT_FOUND", 404)
    const [authorization, membership] = await Promise.all([
      options.identity.authorizationForSubject({ tenantId, subjectId }),
      options.organizations.accessForSubject({ tenantId, subjectId }),
    ])
    if (!authorization.registered) throw new PlatformApiError("PREVIEW_SUBJECT_NOT_FOUND", 404)
    const principal = {
      tenant_id: tenantId,
      subject_id: subjectId,
      client_id: request.body.client_id,
      role: authorization.tenant_administrator ? "TENANT_ADMINISTRATOR" as const : membership.administrator_organization_ids.length ? "ORGANIZATION_ADMINISTRATOR" as const : "USER" as const,
      organization_ids: authorization.tenant_administrator ? [] : membership.organization_ids,
    }
    const [catalog, policies, botAccess] = await Promise.all([
      options.access.catalog({ tenantId, actor: { subjectId, clientId: principal.client_id, role: principal.role, organizationIds: principal.organization_ids } }),
      options.policy.listRuntimePolicies(tenantId),
      options.policy.resolveBotAccess({ tenantId, principal, capabilityId: "personal_bot.use" }),
    ])
    const targets = new Map<string, Set<ReturnType<typeof capabilityActions>[number]>>()
    for (const capabilityId of RUNTIME_POLICY_CAPABILITY_IDS) targets.set(capabilityId, new Set(capabilityActions(capabilityId)))
    for (const capability of catalog.capabilities) targets.set(capability.capability_id, new Set(capabilityActions(capability.capability_id, capability.resource_kind)))
    for (const policy of policies) for (const rule of policy.rules) {
      if (rule.target.runtime_id !== request.body.runtime_id) continue
      const actions = targets.get(rule.target.capability_id) ?? new Set(capabilityActions(rule.target.capability_id))
      for (const action of rule.actions) actions.add(action)
      targets.set(rule.target.capability_id, actions)
    }
    const correlationId = `permission-preview-${crypto.randomUUID()}`
    const decisions = []
    for (const [capabilityId, actions] of targets) for (const action of actions) {
      const decision = await options.policy.evaluateRuntime({
        principal, runtime_id: request.body.runtime_id, bot_id: request.body.bot_id || PERSONAL_BOT_RESOURCE_ID,
        capability_id: capabilityId, action, recordAudit: false, correlation_id: correlationId,
      })
      const effectiveDecision = botAccess.decision === "DENY" ? { ...decision, decision: "DENY" as const, reason_code: botAccess.reason_code, policy_id: botAccess.policy_id, policy_revision: botAccess.policy_revision, policy_display_name: null, matched_policy_refs: [] } : decision
      await options.audit.record({ tenantId, event: {
        ...runtimePolicyAuditEvent(effectiveDecision, admin, "PREVIEW", decision.evaluated_at, { audit_event_id: crypto.randomUUID() }),
        actor_subject: { subject_id: admin.subject_id, evidence_level: "VERIFIED" },
        target_subject_id: subjectId,
      } })
      decisions.push({ ...decision, effective_decision: effectiveDecision.decision })
    }
    reply.header("cache-control", "no-store")
    return {
      subject_id: subjectId, subject_display_name: subject.profile.display_name ?? subject.profile.email ?? subjectId,
      actor_subject_id: admin.subject_id, role: principal.role, organization_ids: principal.organization_ids,
      runtime_id: request.body.runtime_id, client_id: principal.client_id, bot_id: request.body.bot_id,
      evaluated_at: Math.floor(Date.now() / 1000),
      capabilities: catalog.capabilities.map((value) => ({
        resource_id: value.resource_id, resource_display_name: value.resource_display_name,
        capability_id: value.capability_id, capability_display_name: value.capability_display_name,
        access: value.access, connection_status: value.connection_status, restriction_reason: value.restriction_reason ?? null,
      })),
      bot_access: botAccess,
      runtime_decisions: decisions,
    }
  })
}
