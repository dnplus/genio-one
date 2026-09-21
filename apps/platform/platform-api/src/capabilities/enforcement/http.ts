import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  CompileEnforcementChainSchema,
  CompiledEnforcementChainSchema,
  EnforcementChainMutationBodySchema,
  EnforcementChainPathSchema,
  EnforcementChainInventorySchema,
  EnforcementChainRevisionSchema,
} from "./contract"
import { PlatformApiError } from "../errors"
import type {
  EnforcementChainCompiler,
  EnforcementChainRevisionReader,
} from "./module"
import type { ResourceRegistry } from "../resources/module"
import { Type } from "typebox"
import {
  DiscardPolicyDraftSchema,
  PolicyDraftSchema,
  PolicyDraftTransitionSchema,
  PublishPolicyDraftSchema,
  SavePolicyDraftSchema,
  resourcePolicyKey,
  type PolicyDraftStore,
} from "../one-policy/drafts"
import { assertExpectedPolicyDraft } from "../one-policy/lifecycle"

export interface EnforcementHttpOptions {
  drafts?: PolicyDraftStore
  compiler: EnforcementChainCompiler
  /** Required for the formal mutation route; preview never touches it. */
  revisionStore?: EnforcementChainRevisionReader
  resources?: ResourceRegistry
}

function revisionStoreRequired(): never {
  throw new PlatformApiError(
    "ENFORCEMENT_REVISION_STORE_UNAVAILABLE",
    503,
    "The formal Enforcement Chain route requires a persistent revision store",
  )
}

export const enforcementHttp: FastifyPluginAsync<EnforcementHttpOptions> = async (
  app,
  options,
) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  const draftPath = "/v1/tenants/:tenant_id/resources/:resource_id/capabilities/:capability_id/policy-draft"
  if (options.drafts) {
    const drafts = options.drafts
    routes.get("/v1/tenants/:tenant_id/one-policy/drafts", { schema: {
      tags: ["One Policy"], params: Type.Object({ tenant_id: Type.String() }),
      response: { 200: Type.Array(Type.Pick(PolicyDraftSchema, ["policy_key", "version", "base_revision", "lifecycle", "content_digest", "updated_at"])) },
    } }, async (request) => {
      const items = await drafts.list(request.params.tenant_id)
      const administrator = request.principal!.role === "TENANT_ADMINISTRATOR"
      const resources = await options.resources?.listResources({ tenantId: request.params.tenant_id }) ?? []
      const allowed = new Set(resources.filter((resource) => administrator || request.principal!.organization_ids.includes(resource.owner_organization_id)).map((resource) => resource.resource_id))
      return items.filter((item) => {
        if (item.content.kind === "BOT_ACCESS") return administrator
        try { return allowed.has(JSON.parse(item.policy_key)[0]) } catch { return false }
      }).map(({ policy_key, version, base_revision, lifecycle, content_digest, updated_at }) => ({ policy_key, version, base_revision, lifecycle, content_digest, updated_at }))
    })
    routes.post(`${draftPath}/discard`, { schema: { tags: ["One Policy"], params: EnforcementChainPathSchema, body: DiscardPolicyDraftSchema, response: { 200: Type.Object({ discarded: Type.Boolean() }) } } }, async (request) => {
      const key = resourcePolicyKey(request.params.resource_id, request.params.capability_id)
      const removed = await drafts.remove(request.params.tenant_id, key, request.body.expected_version, {
        actorSubjectId: request.principal!.subject_id,
        correlationId: request.id,
      })
      if (!removed) throw new PlatformApiError("POLICY_DRAFT_CONFLICT", 409)
      return { discarded: true }
    })
    routes.get(draftPath, { schema: { tags: ["One Policy"], params: EnforcementChainPathSchema, response: { 200: Type.Union([PolicyDraftSchema, Type.Null()]) } } },
      (request) => drafts.get(request.params.tenant_id, resourcePolicyKey(request.params.resource_id, request.params.capability_id)))
    routes.put(draftPath, { schema: { tags: ["One Policy"], params: EnforcementChainPathSchema, body: SavePolicyDraftSchema, response: { 200: PolicyDraftSchema } } }, async (request) => {
      if (request.body.content.kind !== "RESOURCE_CAPABILITY") throw new PlatformApiError("POLICY_KIND_MISMATCH", 422)
      const latest = await options.revisionStore?.getLatest({ tenantId: request.params.tenant_id, resourceId: request.params.resource_id, capabilityId: request.params.capability_id })
      if ((latest?.one_policy_revision ?? 0) !== request.body.base_revision || request.body.content.definition.one_policy_revision !== request.body.base_revision + 1) throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
      const key = resourcePolicyKey(request.params.resource_id, request.params.capability_id)
      return drafts.save(request.params.tenant_id, key, request.body, {
        actorSubjectId: request.principal!.subject_id,
        correlationId: request.id,
      })
    })
    routes.post(`${draftPath}/validate`, { schema: { tags: ["One Policy"], params: EnforcementChainPathSchema, body: PolicyDraftTransitionSchema, response: { 200: PolicyDraftSchema } } }, async (request) => {
      const tenantId = request.params.tenant_id
      const resourceId = request.params.resource_id
      const capabilityId = request.params.capability_id
      const key = resourcePolicyKey(resourceId, capabilityId)
      const current = await drafts.get(tenantId, key)
      if (!current) throw new PlatformApiError("POLICY_DRAFT_CONFLICT", 409)
      assertExpectedPolicyDraft(current, { expectedVersion: request.body.expected_version, expectedContentDigest: request.body.expected_content_digest })
      if (current.content.kind !== "RESOURCE_CAPABILITY") throw new PlatformApiError("POLICY_KIND_MISMATCH", 422)
      await options.compiler.compile({
        tenantId,
        value: {
          ...current.content.definition,
          resource_id: resourceId,
          capability_id: capabilityId,
          eligible_connection_ids: current.content.definition.eligible_connection_ids ?? await options.compiler.listEligibleConnectionIds({ tenantId, resourceId }),
        },
      })
      return drafts.validate(tenantId, key, {
        expectedVersion: request.body.expected_version,
        expectedContentDigest: request.body.expected_content_digest,
        context: { actorSubjectId: request.principal!.subject_id, correlationId: request.id },
      })
    })
    routes.post(`${draftPath}/review`, { schema: { tags: ["One Policy"], params: EnforcementChainPathSchema, body: PolicyDraftTransitionSchema, response: { 200: PolicyDraftSchema } } }, async (request) => {
      const key = resourcePolicyKey(request.params.resource_id, request.params.capability_id)
      return drafts.review(request.params.tenant_id, key, {
        expectedVersion: request.body.expected_version,
        expectedContentDigest: request.body.expected_content_digest,
        context: { actorSubjectId: request.principal!.subject_id, correlationId: request.id },
      })
    })
    routes.post(`${draftPath}/publish`, { schema: { tags: ["One Policy"], params: EnforcementChainPathSchema, body: PublishPolicyDraftSchema, response: { 200: EnforcementChainRevisionSchema } } }, async (request) => {
      const tenantId = request.params.tenant_id
      const resourceId = request.params.resource_id
      const capabilityId = request.params.capability_id
      const key = resourcePolicyKey(resourceId, capabilityId)
      const draft = await drafts.get(tenantId, key)
      if (!draft) throw new PlatformApiError("POLICY_DRAFT_CONFLICT", 409)
      const store = options.revisionStore ?? revisionStoreRequired()
      return store.publishDraft({
        tenantId,
        resourceId,
        capabilityId,
        expectedVersion: request.body.expected_version,
        expectedContentDigest: request.body.expected_content_digest,
        publishedBySubjectId: request.principal!.subject_id,
        correlationId: request.id,
      })
    })
  }

  routes.get(
    "/v1/tenants/:tenant_id/enforcement-chains",
    {
      schema: {
        operationId: "listLatestEnforcementChainRevisions",
        summary: "List the latest Resource Capability enforcement chains",
        tags: ["One Policy"],
        params: { type: "object", required: ["tenant_id"], properties: {
          tenant_id: { type: "string", minLength: 1 },
        } },
        response: { 200: EnforcementChainInventorySchema },
      },
    },
    async (request) => {
      const store = options.revisionStore ?? revisionStoreRequired()
      const inventory = await store.listInventory({ tenantId: request.params.tenant_id })
      if (request.principal!.role === "TENANT_ADMINISTRATOR") return inventory
      if (!options.resources) {
        throw new PlatformApiError("ENFORCEMENT_RESOURCE_SCOPE_UNAVAILABLE", 503)
      }
      const visibleResources = new Set((await options.resources.listResources({
        tenantId: request.params.tenant_id,
      })).filter((resource) =>
        request.principal!.organization_ids.includes(resource.owner_organization_id))
        .map((resource) => resource.resource_id))
      return inventory.filter((item) => visibleResources.has(item.resource_id))
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/resources/:resource_id/capabilities/:capability_id/enforcement-chain",
    {
      schema: {
        operationId: "getLatestEnforcementChainRevision",
        summary: "Read the latest Enforcement Chain revision",
        tags: ["One Policy"],
        params: EnforcementChainPathSchema,
        response: { 200: EnforcementChainRevisionSchema },
      },
    },
    async (request) => {
      const store = options.revisionStore ?? revisionStoreRequired()
      const revision = await store.getLatest({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        capabilityId: request.params.capability_id,
      })
      if (!revision) throw new PlatformApiError("ENFORCEMENT_CHAIN_NOT_FOUND", 404)
      return revision
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/resources/:resource_id/capabilities/:capability_id/enforcement-chain",
    {
      schema: {
        operationId: "saveEnforcementChainRevision",
        summary: "Retired direct Enforcement Chain write route",
        tags: ["One Policy"],
        params: EnforcementChainPathSchema,
        body: EnforcementChainMutationBodySchema,
        response: { 410: Type.Object({ code: Type.String() }) },
      },
    },
    async () => { throw new PlatformApiError("ENFORCEMENT_DIRECT_WRITE_RETIRED", 410) },
  )

  const previewSchema = {
    operationId: "previewEnforcementChain",
    summary: "Preview and validate an Enforcement Chain without persistence",
    description:
      "This endpoint is validation-only. It never creates a revision and cannot be used as Gateway Projection input. The candidate Connection IDs are explicit because this is a diagnostic preview.",
    tags: ["One Policy"],
    params: {
      type: "object",
      required: ["tenant_id"],
      properties: { tenant_id: { type: "string", minLength: 1 } },
    },
    body: CompileEnforcementChainSchema,
    response: { 200: CompiledEnforcementChainSchema },
  } as const
  const previewHandler = async (request: {
    params: { tenant_id: string }
    body: import("./contract").CompileEnforcementChainInput
  }) =>
    options.compiler.compile({
      tenantId: request.params.tenant_id,
      value: request.body,
    })

  routes.post(
    "/v1/tenants/:tenant_id/ai-gateway/enforcement-chain/preview",
    { schema: previewSchema },
    previewHandler,
  )
}
