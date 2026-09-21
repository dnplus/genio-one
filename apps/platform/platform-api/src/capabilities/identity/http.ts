import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { createHash } from "node:crypto"

import { PlatformApiError } from "../errors"
import { CreateSelfServiceAgentSchema, CreateSubjectSchema, IdentityPathSchema, SubjectPathSchema, SubjectSchema, SuspendSubjectSchema, TenantIdentityInventorySchema } from "./contract"
import type { IdentityDirectory } from "./module"
import { externalSubjectIdsFor, type SubjectSessionControl } from "./keycloak"
import type { OrganizationDirectory } from "../organizations/module"
import type { ResourceConnectionRegistry } from "../connections/module"
import type { OnePolicy } from "../one-policy/module"
import { PERSONAL_BOT_RESOURCE, PERSONAL_BOT_USE } from "../one-policy/default"

export const identityHttp: FastifyPluginAsync<{
  directory: IdentityDirectory
  /** Absent when no Keycloak Admin credential is configured. */
  sessionControl?: SubjectSessionControl
  organizations: OrganizationDirectory
  policy: Pick<OnePolicy, "resolveBotAccess">
  connections: Pick<ResourceConnectionRegistry, "list">
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()

  /**
   * Mirrors a local suspension into the identity provider. The local state is
   * already authoritative for the Control Plane and the Bot, so a provider that
   * cannot be reached must not roll that back; it is reported instead, because
   * an operator who believes the upstream account is disabled when it is not
   * would stop too early during offboarding.
   */
  async function applyUpstream(
    tenantId: string,
    subjectId: string,
    action: "disable" | "enable",
  ): Promise<void> {
    const sessionControl = options.sessionControl
    if (!sessionControl) return
    const inventory = await options.directory.inventory({ tenantId })
    const externalSubjectIds = externalSubjectIdsFor(inventory.external_identity_bindings, subjectId)
    for (const externalSubjectId of externalSubjectIds) {
      try {
        await sessionControl[action]({ externalSubjectId })
      } catch (error) {
        throw new PlatformApiError(
          action === "disable"
            ? "SUBJECT_SUSPENDED_PROVIDER_NOT_UPDATED"
            : "SUBJECT_RESTORED_PROVIDER_NOT_UPDATED",
          502,
          action === "disable"
            ? "The Subject is suspended in GenioOne, but its identity provider account could not be disabled. Disable it in the provider as well."
            : "The Subject is restored in GenioOne, but its identity provider account could not be re-enabled. Re-enable it in the provider as well.",
          [{ code: "PROVIDER_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) }],
        )
      }
    }
  }
  function selfServiceAgentSubjectId(tenantId: string, subjectId: string, clientId: string, clientRequestId: string) {
    const digest = createHash("sha256")
      .update(tenantId).update("\0")
      .update(subjectId).update("\0")
      .update(clientId).update("\0")
      .update(clientRequestId)
      .digest("hex")
    return `agent-${digest}`
  }
  routes.get(
    "/v1/tenants/:tenant_id/identity",
    {
      schema: {
        operationId: "getIdentityInventory",
        tags: ["Identity"],
        params: IdentityPathSchema,
        response: { 200: TenantIdentityInventorySchema },
      },
    },
    async (request) => {
      const inventory = await options.directory.inventory({ tenantId: request.params.tenant_id })
      if (request.principal?.role === "TENANT_ADMINISTRATOR") return inventory
      const organizations = await Promise.all(
        (request.principal?.organization_ids ?? []).map((organizationId) =>
          options.organizations.get({
            tenantId: request.params.tenant_id,
            organizationId,
          })
        ),
      )
      const visibleSubjects = new Set(
        organizations.flatMap((organization) => organization.member_subject_ids),
      )
      return {
        ...inventory,
        subjects: inventory.subjects.filter((subject) => visibleSubjects.has(subject.subject_id)),
        external_identity_bindings: inventory.external_identity_bindings.filter((binding) =>
          visibleSubjects.has(binding.subject_id)
        ),
        tenant_administrators: [],
      }
    },
  )
  routes.post(
    "/v1/tenants/:tenant_id/identity/subjects",
    {
      schema: {
        operationId: "registerAgentSubject",
        tags: ["Identity"],
        params: IdentityPathSchema,
        body: CreateSubjectSchema,
        response: { 201: SubjectSchema },
      },
    },
    async (request, reply) => reply.code(201).send(await options.directory.create({
      tenantId: request.params.tenant_id,
      value: request.body,
    })),
  )
  routes.post(
    "/v1/tenants/:tenant_id/identity/subjects/:subject_id/suspend",
    {
      schema: {
        operationId: "suspendSubject",
        tags: ["Identity"],
        params: SubjectPathSchema,
        body: SuspendSubjectSchema,
        response: { 200: SubjectSchema },
      },
    },
    async (request) => {
      const principal = request.principal
      if (!principal) throw new PlatformApiError("UNAUTHENTICATED", 401)
      // Suspending yourself would end your own session on the next request and
      // could leave a tenant with no one able to restore anybody.
      if (principal.subject_id === request.params.subject_id) {
        throw new PlatformApiError(
          "SUBJECT_SELF_SUSPENSION_REFUSED",
          409,
          "A Tenant Administrator cannot suspend their own Subject",
        )
      }
      const suspended = await options.directory.suspend({
        tenantId: request.params.tenant_id,
        subjectId: request.params.subject_id,
        suspendedBy: principal.subject_id,
        value: request.body,
      })
      await applyUpstream(request.params.tenant_id, request.params.subject_id, "disable")
      return suspended
    },
  )
  routes.post(
    "/v1/tenants/:tenant_id/identity/subjects/:subject_id/restore",
    {
      schema: {
        operationId: "restoreSubject",
        tags: ["Identity"],
        params: SubjectPathSchema,
        response: { 200: SubjectSchema },
      },
    },
    async (request) => {
      const restored = await options.directory.restore({
        tenantId: request.params.tenant_id,
        subjectId: request.params.subject_id,
      })
      await applyUpstream(request.params.tenant_id, request.params.subject_id, "enable")
      return restored
    },
  )
  routes.post(
    "/v1/tenants/:tenant_id/me/agents",
    {
      schema: {
        operationId: "createSelfServiceAgent",
        tags: ["Identity"],
        params: IdentityPathSchema,
        body: CreateSelfServiceAgentSchema,
        response: { 201: SubjectSchema },
      },
      preValidation: async (request) => {
        const body = request.body
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          Object.keys(body).some((key) => key !== "display_name" && key !== "client_request_id")
        ) {
          throw new PlatformApiError("REQUEST_VALIDATION_FAILED", 400, "Request validation failed")
        }
      },
    },
    async (request, reply) => {
      const principal = request.principal
      if (!principal) throw new PlatformApiError("UNAUTHENTICATED", 401)
      let inventory
      try {
        inventory = await options.directory.inventory({ tenantId: request.params.tenant_id })
      } catch {
        throw new PlatformApiError(
          "IDENTITY_LOOKUP_UNAVAILABLE",
          503,
          "The authenticated principal identity could not be verified",
        )
      }
      const caller = inventory.subjects.find((subject) => subject.subject_id === principal.subject_id)
      if (!caller || caller.kind !== "PERSON") {
        throw new PlatformApiError(
          "PERSON_PRINCIPAL_REQUIRED",
          403,
          "Only a registered person can create a personal Bot",
        )
      }
      let decision
      try {
        decision = await options.policy.resolveBotAccess({
          tenantId: request.params.tenant_id,
          principal: {
            subject_id: principal.subject_id,
            client_id: principal.client_id,
            role: principal.role,
          },
          capabilityId: PERSONAL_BOT_USE,
        })
      } catch {
        throw new PlatformApiError(
          "BOT_ACCESS_POLICY_UNAVAILABLE",
          503,
          "The personal Bot access policy could not be evaluated",
        )
      }
      if (
        decision.tenant_id !== request.params.tenant_id ||
        decision.subject_id !== principal.subject_id ||
        decision.client_id !== principal.client_id ||
        decision.resource_id !== PERSONAL_BOT_RESOURCE ||
        decision.capability_id !== PERSONAL_BOT_USE
      ) {
        throw new PlatformApiError(
          "BOT_ACCESS_POLICY_INVALID",
          503,
          "The personal Bot access policy returned an invalid decision",
        )
      }
      if (decision.decision !== "ALLOW") {
        throw new PlatformApiError(
          "BOT_ACCESS_DENIED",
          403,
          decision.reason_code,
        )
      }
      let connections
      try {
        connections = await options.connections.list({
          tenantId: request.params.tenant_id,
          resourceId: PERSONAL_BOT_RESOURCE,
        })
      } catch {
        throw new PlatformApiError(
          "GENIO_BOT_SERVICE_UNAVAILABLE",
          503,
          "The installed Genio Bot service connection could not be checked",
        )
      }
      const serviceConnection = connections.find((connection) =>
        connection.connection_id === PERSONAL_BOT_RESOURCE,
      )
      if (!serviceConnection || serviceConnection.lifecycle !== "ENABLED") {
        throw new PlatformApiError(
          "GENIO_BOT_SERVICE_DISABLED",
          403,
          "The installed Genio Bot service is disabled",
        )
      }
      return reply.code(201).send(await options.directory.createSelfServiceAgent({
        tenantId: request.params.tenant_id,
        value: request.body,
        subjectId: request.body.client_request_id
          ? selfServiceAgentSubjectId(request.params.tenant_id, principal.subject_id, principal.client_id, request.body.client_request_id)
          : undefined,
      }))
    },
  )
}
