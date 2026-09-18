import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  PublicationWorkflowErrorSchema,
  PublicationWorkflowRequestBodySchema,
  PublicationWorkflowRequestPathSchema,
  PublicationWorkflowRequestSchema,
  PublicationWorkflowReviewBodySchema,
  PublicationWorkflowReviewPathSchema,
} from "./contract"
import type { AiResourcePublicationWorkflow } from "./module"
import { ResourceRegistrationSchema } from "../resources/contract"
import { PlatformApiError } from "../errors"

export interface PublicationWorkflowHttpOptions {
  workflow: AiResourcePublicationWorkflow
}

/** HTTP boundary for the review/build/publish workflow. */
export const publicationWorkflowHttp: FastifyPluginAsync<PublicationWorkflowHttpOptions> = async (
  app,
  options,
) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()

  routes.post(
    "/v1/tenants/:tenant_id/resources/:resource_id/publication-requests",
    {
      schema: {
        operationId: "requestResourcePublicationReview",
        summary: "Snapshot a draft Resource for publication review",
        description:
          "The server captures the Resource, its Resource+Capability Enforcement Chain, owned Connections, and PUBLIC Models before review.",
        tags: ["Publications"],
        params: PublicationWorkflowRequestPathSchema,
        body: PublicationWorkflowRequestBodySchema,
        response: {
          201: PublicationWorkflowRequestSchema,
          401: PublicationWorkflowErrorSchema,
          400: PublicationWorkflowErrorSchema,
          409: PublicationWorkflowErrorSchema,
          422: PublicationWorkflowErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const requestedBy = request.body.requested_by ?? request.principal?.subject_id
      if (!requestedBy) {
        throw new PlatformApiError("UNAUTHENTICATED", 401)
      }
      const publication = await options.workflow.requestReview({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        requestedBy,
      })
      return reply.code(201).send({
        ...publication,
        publication_state: publication.publication_state ?? "PENDING_REVIEW",
        reviewed_by: publication.reviewed_by ?? null,
        reviewed_at: publication.reviewed_at ?? null,
        attempt_id: publication.attempt_id ?? null,
        failure_code: publication.failure_code ?? null,
      })
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/resources/:resource_id/publication-requests/:request_id/review",
    {
      schema: {
        operationId: "reviewResourcePublication",
        summary: "Approve or reject a Resource publication build",
        description:
          "Approval first claims BUILDING while the Resource stays DRAFT, then compiles and signs the immutable snapshot before the final lifecycle CAS.",
        tags: ["Publications"],
        params: PublicationWorkflowReviewPathSchema,
        body: PublicationWorkflowReviewBodySchema,
        response: {
          200: ResourceRegistrationSchema,
          401: PublicationWorkflowErrorSchema,
          400: PublicationWorkflowErrorSchema,
          409: PublicationWorkflowErrorSchema,
          422: PublicationWorkflowErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const reviewerId = request.body.reviewer_id ?? request.principal?.subject_id
      if (!reviewerId) {
        throw new PlatformApiError("UNAUTHENTICATED", 401)
      }
      const result = await options.workflow.review({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        requestId: request.params.request_id,
        reviewerId,
        decision: request.body.decision,
      })
      return reply.code(200).send(result)
    },
  )
}
