import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import type { FastifyPluginAsync } from "fastify"
import { Type } from "typebox"

import { PlatformApiError } from "../errors"
import {
  RuntimeRegistrationSchema,
  type RuntimeControlStore,
} from "./contract"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })

const RuntimePathSchema = Type.Object({
  tenant_id: Identifier,
  runtime_id: Identifier,
}, { additionalProperties: false })

const RegistrationBodySchema = Type.Object({
  target_id: Identifier,
  oidc_client_id: Identifier,
  report_key_id: Identifier,
  report_public_key_pem: Type.String({ minLength: 1, maxLength: 8192 }),
  status: Type.Optional(Type.Union([
    Type.Literal("ACTIVE"),
    Type.Literal("DISABLED"),
    Type.Literal("REVOKED"),
  ])),
}, { additionalProperties: false })

export interface RuntimeControlHttpOptions {
  store: RuntimeControlStore
}

export const runtimeControlHttp: FastifyPluginAsync<RuntimeControlHttpOptions> = async (
  app,
  options,
) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()

  routes.put(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/registration",
    {
      schema: {
        operationId: "registerGatewayRuntime",
        summary: "Confirm a provisioned Gateway Runtime registration",
        tags: ["Runtime Control"],
        params: RuntimePathSchema,
        body: RegistrationBodySchema,
        response: { 200: RuntimeRegistrationSchema },
      },
    },
    async (request) => {
      const registration = await options.store.getGatewayRuntime({
        tenantId: request.params.tenant_id,
        runtimeId: request.params.runtime_id,
      })
      if (!registration) throw new PlatformApiError("RUNTIME_REGISTRATION_NOT_FOUND", 404)
      if (registration.status !== "ACTIVE") {
        throw new PlatformApiError("RUNTIME_REGISTRATION_NOT_ACTIVE", 403)
      }
      if (
        registration.target_id !== request.body.target_id ||
        registration.oidc_client_id !== request.body.oidc_client_id ||
        registration.report_key_id !== request.body.report_key_id ||
        registration.report_public_key_pem !== request.body.report_public_key_pem ||
        registration.status !== (request.body.status ?? "ACTIVE")
      ) {
        throw new PlatformApiError("RUNTIME_REGISTRATION_MISMATCH", 409)
      }
      return registration
    },
  )
}
