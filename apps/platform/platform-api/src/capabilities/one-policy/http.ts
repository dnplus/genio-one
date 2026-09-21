import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"

import {
  OnePolicyBotCapabilitySchema,
  OnePolicyBotDecisionSchema,
  OnePolicyBotSeedSchema,
} from "./contract"
import type { OnePolicy } from "./module"
import {
  BotPolicyRevisionSchema,
  runtimePolicyDraftKey,
  PolicyDraftSchema,
  SavePolicyDraftSchema,
  DiscardPolicyDraftSchema,
  PolicyAuthoringSettingsSchema,
  SavePolicyAuthoringSettingsSchema,
  PolicyDraftTransitionSchema,
  PublishPolicyDraftSchema,
  type PolicyDraftStore,
} from "./drafts"
import {
  RuntimePolicyAuthorizeBodySchema,
  RuntimePolicyAuditEventSchema,
  RuntimePolicyDecisionSchema,
  RuntimePolicyEffectiveQuerySchema,
  RuntimePolicyListSchema,
  RuntimePolicyReportBodySchema,
  RuntimePolicyRevisionSchema,
} from "./runtime"
import { RUNTIME_REPORT_KEY_ID_HEADER, RUNTIME_REPORT_SIGNATURE_HEADER } from "../../../../../../runtimes/gateway/services/shared/runtime-report-attestation"
import { PlatformApiError } from "../errors"
import { validateRuntimePolicyForPublication } from "./runtime-policy-validator"

const TenantPathSchema = Type.Object({
  tenant_id: Type.String({ minLength: 1, maxLength: 256 }),
})

const QuerySchema = Type.Object({
  capability_id: Type.Optional(OnePolicyBotCapabilitySchema),
}, { additionalProperties: false })

const SeedPathSchema = Type.Object({
  tenant_id: Type.String({ minLength: 1, maxLength: 256 }),
})

const SeedUpdateSchema = Type.Object({
  enabled: Type.Boolean(),
}, { additionalProperties: false })

const RuntimePolicyPathSchema = Type.Object({
  tenant_id: Type.String({ minLength: 1, maxLength: 256 }),
  policy_id: Type.String({ minLength: 1, maxLength: 256 }),
})

const RuntimePolicyRevisionPathSchema = Type.Object({
  tenant_id: Type.String({ minLength: 1, maxLength: 256 }),
  policy_id: Type.String({ minLength: 1, maxLength: 256 }),
  revision: Type.Integer({ minimum: 1 }),
})

const RuntimePolicyEnabledBodySchema = Type.Object({
  expected_revision: Type.Integer({ minimum: 1 }),
  enabled: Type.Boolean(),
}, { additionalProperties: false })

function headerValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : ""
}

function requireTenantAdministrator(role: string): void {
  if (role !== "TENANT_ADMINISTRATOR") throw new PlatformApiError("FORBIDDEN", 403)
}

export const onePolicyHttp: FastifyPluginAsync<{ policy: OnePolicy; drafts: PolicyDraftStore }> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  const draftPath = "/v1/tenants/:tenant_id/one-policy/first-party-bot/draft"
  const key = "one-policy.first-party.bot-default"
  routes.get("/v1/tenants/:tenant_id/one-policy/authoring-settings", {
    schema: {
      operationId: "getPolicyAuthoringSettings",
      tags: ["One Policy"],
      params: TenantPathSchema,
      response: { 200: PolicyAuthoringSettingsSchema },
    },
  }, async (request) => {
    requireTenantAdministrator(request.principal!.role)
    return options.drafts.getAuthoringSettings(request.params.tenant_id)
  })
  routes.put("/v1/tenants/:tenant_id/one-policy/authoring-settings", {
    schema: {
      operationId: "savePolicyAuthoringSettings",
      tags: ["One Policy"],
      params: TenantPathSchema,
      body: SavePolicyAuthoringSettingsSchema,
      response: { 200: PolicyAuthoringSettingsSchema },
    },
  }, async (request) => {
    requireTenantAdministrator(request.principal!.role)
    return options.drafts.saveAuthoringSettings(request.params.tenant_id, request.body, {
      actorSubjectId: request.principal!.subject_id,
      correlationId: request.id,
      at: Math.floor(Date.now() / 1_000),
    })
  })
  routes.get("/v1/tenants/:tenant_id/one-policy/first-party-bot/revisions", { schema: { tags: ["One Policy"], params: SeedPathSchema, response: { 200: Type.Array(BotPolicyRevisionSchema) } } }, (request) => options.policy.listFirstPartyBotPolicyRevisions(request.params.tenant_id))
  routes.post(`${draftPath}/discard`, { schema: { tags: ["One Policy"], params: SeedPathSchema, body: DiscardPolicyDraftSchema, response: { 200: Type.Object({ discarded: Type.Boolean() }) } } }, async (request) => {
    if (!await options.drafts.remove(request.params.tenant_id, key, request.body.expected_version, {
      actorSubjectId: request.principal!.subject_id,
      correlationId: request.id,
    })) throw new PlatformApiError("POLICY_DRAFT_CONFLICT", 409)
    return { discarded: true }
  })
  routes.get(draftPath, { schema: { tags: ["One Policy"], params: SeedPathSchema, response: { 200: Type.Union([PolicyDraftSchema, Type.Null()]) } } },
    (request) => options.drafts.get(request.params.tenant_id, key))
  routes.put(draftPath, { schema: { tags: ["One Policy"], params: SeedPathSchema, body: SavePolicyDraftSchema, response: { 200: PolicyDraftSchema } } }, async (request) => {
    if (request.body.content.kind !== "BOT_ACCESS") throw new PlatformApiError("POLICY_KIND_MISMATCH", 422)
    const current = await options.policy.getFirstPartyBotSeed({ tenantId: request.params.tenant_id })
    if (current.policy_revision !== request.body.base_revision) throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
    return options.drafts.save(request.params.tenant_id, key, request.body, {
      actorSubjectId: request.principal!.subject_id,
      correlationId: request.id,
    })
  })
  routes.post(`${draftPath}/validate`, { schema: { tags: ["One Policy"], params: SeedPathSchema, body: PolicyDraftTransitionSchema, response: { 200: PolicyDraftSchema } } }, async (request) => {
    return options.drafts.validate(request.params.tenant_id, key, {
      expectedVersion: request.body.expected_version,
      expectedContentDigest: request.body.expected_content_digest,
      context: { actorSubjectId: request.principal!.subject_id, correlationId: request.id },
    })
  })
  routes.post(`${draftPath}/review`, { schema: { tags: ["One Policy"], params: SeedPathSchema, body: PolicyDraftTransitionSchema, response: { 200: PolicyDraftSchema } } }, async (request) => {
    return options.drafts.review(request.params.tenant_id, key, {
      expectedVersion: request.body.expected_version,
      expectedContentDigest: request.body.expected_content_digest,
      context: { actorSubjectId: request.principal!.subject_id, correlationId: request.id },
    })
  })
  routes.post(`${draftPath}/publish`, { schema: { tags: ["One Policy"], params: SeedPathSchema, body: PublishPolicyDraftSchema, response: { 200: OnePolicyBotSeedSchema } } }, async (request) => {
    return options.policy.publishFirstPartyBotPolicyDraft({ tenantId: request.params.tenant_id, expectedVersion: request.body.expected_version, expectedContentDigest: request.body.expected_content_digest, publishedBy: request.principal!.subject_id, correlationId: request.id })
  })
  routes.get("/v1/tenants/:tenant_id/one-policy/first-party-bot", {
    schema: {
      tags: ["One Policy"],
      params: SeedPathSchema,
      response: { 200: OnePolicyBotSeedSchema },
    },
  }, async (request) => options.policy.getFirstPartyBotSeed({ tenantId: request.params.tenant_id }))
  routes.patch("/v1/tenants/:tenant_id/one-policy/first-party-bot", {
    schema: {
      tags: ["One Policy"],
      params: SeedPathSchema,
      body: SeedUpdateSchema,
      response: { 200: OnePolicyBotSeedSchema },
    },
  }, async (request) => options.policy.setFirstPartyBotSeedEnabled({
    tenantId: request.params.tenant_id,
    enabled: request.body.enabled,
    publishedBy: request.principal!.subject_id,
    correlationId: request.id,
  }))
  routes.get("/v1/tenants/:tenant_id/one-policy/bot-access", {
    schema: {
      tags: ["One Policy"],
      params: TenantPathSchema,
      querystring: QuerySchema,
      response: { 200: OnePolicyBotDecisionSchema },
    },
  }, async (request) => options.policy.resolveBotAccess({
    tenantId: request.params.tenant_id,
    principal: request.principal!,
    capabilityId: request.query.capability_id ?? "personal_bot.use",
  }))

  routes.get("/v1/tenants/:tenant_id/one-policy/runtime-policies", {
    schema: {
      operationId: "listRuntimePolicies",
      tags: ["One Policy"],
      params: TenantPathSchema,
      response: { 200: RuntimePolicyListSchema },
    },
  }, (request) => options.policy.listRuntimePolicies(request.params.tenant_id))

  routes.get("/v1/tenants/:tenant_id/one-policy/runtime-policies/:policy_id", {
    schema: {
      operationId: "getRuntimePolicy",
      tags: ["One Policy"],
      params: RuntimePolicyPathSchema,
      response: { 200: RuntimePolicyRevisionSchema },
    },
  }, (request) => options.policy.getRuntimePolicy({ tenantId: request.params.tenant_id, policyId: request.params.policy_id }))

  routes.patch("/v1/tenants/:tenant_id/one-policy/runtime-policies/:policy_id", {
    schema: {
      operationId: "setRuntimePolicyEnabled",
      tags: ["One Policy"],
      params: RuntimePolicyPathSchema,
      body: RuntimePolicyEnabledBodySchema,
      response: { 200: RuntimePolicyRevisionSchema },
    },
  }, (request) => options.policy.setRuntimePolicyEnabled({
    tenantId: request.params.tenant_id,
    policyId: request.params.policy_id,
    expectedRevision: request.body.expected_revision,
    enabled: request.body.enabled,
    publishedBy: request.principal!.subject_id,
    correlationId: request.id,
  }))

  routes.get("/v1/tenants/:tenant_id/one-policy/runtime-policies/:policy_id/revisions", {
    schema: {
      operationId: "listRuntimePolicyRevisions",
      tags: ["One Policy"],
      params: RuntimePolicyPathSchema,
      response: { 200: Type.Array(RuntimePolicyRevisionSchema) },
    },
  }, async (request) => (await options.policy.listRuntimePolicyRevisions(request.params.tenant_id)).filter((item) => item.policy_id === request.params.policy_id))

  routes.get("/v1/tenants/:tenant_id/one-policy/runtime-policies/:policy_id/revisions/:revision", {
    schema: {
      operationId: "getRuntimePolicyRevision",
      tags: ["One Policy"],
      params: RuntimePolicyRevisionPathSchema,
      response: { 200: Type.Union([RuntimePolicyRevisionSchema, Type.Null()]) },
    },
  }, (request) => options.policy.getRuntimePolicyRevision({ tenantId: request.params.tenant_id, policyId: request.params.policy_id, revision: request.params.revision }))

  routes.get("/v1/tenants/:tenant_id/one-policy/runtime-policies/:policy_id/draft", {
    schema: {
      operationId: "getRuntimePolicyDraft",
      tags: ["One Policy"],
      params: RuntimePolicyPathSchema,
      response: { 200: Type.Union([PolicyDraftSchema, Type.Null()]) },
    },
  }, (request) => options.drafts.get(request.params.tenant_id, runtimePolicyDraftKey(request.params.policy_id)))

  routes.put("/v1/tenants/:tenant_id/one-policy/runtime-policies/:policy_id/draft", {
    schema: {
      operationId: "saveRuntimePolicyDraft",
      tags: ["One Policy"],
      params: RuntimePolicyPathSchema,
      body: SavePolicyDraftSchema,
      response: { 200: PolicyDraftSchema },
    },
  }, async (request) => {
    if (request.body.content.kind !== "RUNTIME_CAPABILITY") throw new PlatformApiError("POLICY_KIND_MISMATCH", 422)
    validateRuntimePolicyForPublication(request.body.content.definition)
    if (request.body.base_revision > 0) {
      const current = await options.policy.getRuntimePolicy({ tenantId: request.params.tenant_id, policyId: request.params.policy_id })
      if (current.revision !== request.body.base_revision) throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
    }
    const key = runtimePolicyDraftKey(request.params.policy_id)
    return options.drafts.save(request.params.tenant_id, key, request.body, {
      actorSubjectId: request.principal!.subject_id,
      correlationId: request.id,
    })
  })

  routes.post("/v1/tenants/:tenant_id/one-policy/runtime-policies/:policy_id/draft/validate", {
    schema: {
      operationId: "validateRuntimePolicyDraft",
      tags: ["One Policy"],
      params: RuntimePolicyPathSchema,
      body: PolicyDraftTransitionSchema,
      response: { 200: PolicyDraftSchema },
    },
  }, async (request) => {
    const key = runtimePolicyDraftKey(request.params.policy_id)
    const current = await options.drafts.get(request.params.tenant_id, key)
    if (current?.content.kind === "RUNTIME_CAPABILITY") validateRuntimePolicyForPublication(current.content.definition)
    return options.drafts.validate(request.params.tenant_id, key, {
      expectedVersion: request.body.expected_version,
      expectedContentDigest: request.body.expected_content_digest,
      context: { actorSubjectId: request.principal!.subject_id, correlationId: request.id },
    })
  })

  routes.post("/v1/tenants/:tenant_id/one-policy/runtime-policies/:policy_id/draft/review", {
    schema: {
      operationId: "reviewRuntimePolicyDraft",
      tags: ["One Policy"],
      params: RuntimePolicyPathSchema,
      body: PolicyDraftTransitionSchema,
      response: { 200: PolicyDraftSchema },
    },
  }, async (request) => {
    const key = runtimePolicyDraftKey(request.params.policy_id)
    return options.drafts.review(request.params.tenant_id, key, {
      expectedVersion: request.body.expected_version,
      expectedContentDigest: request.body.expected_content_digest,
      context: { actorSubjectId: request.principal!.subject_id, correlationId: request.id },
    })
  })

  routes.post("/v1/tenants/:tenant_id/one-policy/runtime-policies/:policy_id/draft/discard", {
    schema: {
      operationId: "discardRuntimePolicyDraft",
      tags: ["One Policy"],
      params: RuntimePolicyPathSchema,
      body: DiscardPolicyDraftSchema,
      response: { 200: Type.Object({ discarded: Type.Boolean() }) },
    },
  }, async (request) => {
    const key = runtimePolicyDraftKey(request.params.policy_id)
    if (!await options.drafts.remove(request.params.tenant_id, key, request.body.expected_version, {
      actorSubjectId: request.principal!.subject_id,
      correlationId: request.id,
    })) throw new PlatformApiError("POLICY_DRAFT_CONFLICT", 409)
    return { discarded: true }
  })

  routes.post("/v1/tenants/:tenant_id/one-policy/runtime-policies/:policy_id/draft/publish", {
    schema: {
      operationId: "publishRuntimePolicyDraft",
      tags: ["One Policy"],
      params: RuntimePolicyPathSchema,
      body: PublishPolicyDraftSchema,
      response: { 200: RuntimePolicyRevisionSchema },
    },
  }, async (request) => {
    const published = await options.policy.publishRuntimePolicyDraft({
      tenantId: request.params.tenant_id,
      policyId: request.params.policy_id,
      expectedVersion: request.body.expected_version,
      expectedContentDigest: request.body.expected_content_digest,
      publishedBy: request.principal!.subject_id,
      correlationId: request.id,
    })
    return published
  })

  routes.get("/v1/tenants/:tenant_id/one-policy/runtime-effective", {
    schema: {
      operationId: "getRuntimePolicyEffective",
      tags: ["One Policy"],
      params: TenantPathSchema,
      querystring: RuntimePolicyEffectiveQuerySchema,
      response: { 200: RuntimePolicyDecisionSchema },
    },
  }, async (request) => options.policy.evaluateRuntime({
    ...request.query,
    principal: request.principal!,
  }))

  routes.post("/v1/tenants/:tenant_id/one-policy/runtime-authorize", {
    schema: {
      operationId: "authorizeRuntimePolicy",
      tags: ["One Policy"],
      params: TenantPathSchema,
      body: RuntimePolicyAuthorizeBodySchema,
      response: { 200: RuntimePolicyDecisionSchema },
    },
  }, async (request) => options.policy.authorizeRuntime({
    ...request.body,
    principal: request.principal!,
  }))

  routes.post("/v1/tenants/:tenant_id/one-policy/runtime-report", {
    schema: {
      operationId: "reportRuntimePolicyOutcome",
      tags: ["One Policy"],
      params: TenantPathSchema,
      body: RuntimePolicyReportBodySchema,
      response: { 201: RuntimePolicyAuditEventSchema },
    },
  }, async (request, reply) => reply.code(201).send(await options.policy.reportRuntime({
    ...request.body,
    principal: request.principal!,
    reportAttestation: {
      keyId: headerValue(request.headers[RUNTIME_REPORT_KEY_ID_HEADER]),
      signature: headerValue(request.headers[RUNTIME_REPORT_SIGNATURE_HEADER]),
    },
  })))
}
