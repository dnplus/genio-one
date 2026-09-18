import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import type { FastifyPluginAsync } from "fastify"
import { Type } from "typebox"

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
        summary: "Register a Gateway Runtime",
        tags: ["Runtime Control"],
        params: RuntimePathSchema,
        body: RegistrationBodySchema,
        response: { 200: RuntimeRegistrationSchema },
      },
    },
    async (request) => options.store.registerGatewayRuntime({
      tenantId: request.params.tenant_id,
      runtimeId: request.params.runtime_id,
      targetId: request.body.target_id,
      oidcClientId: request.body.oidc_client_id,
      reportKeyId: request.body.report_key_id,
      reportPublicKeyPem: request.body.report_public_key_pem,
      ...(request.body.status === undefined ? {} : { status: request.body.status }),
    }),
  )
}
