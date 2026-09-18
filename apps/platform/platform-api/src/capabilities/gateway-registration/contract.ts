import { Type, type Static } from "typebox"

export {
  GatewayBootstrapConfigurationSchema,
  GatewayRegistrationSchema,
} from "../../../../../../runtimes/gateway/services/shared/gateway-bootstrap"
export type {
  GatewayBootstrapConfiguration,
  GatewayRegistration,
} from "../../../../../../runtimes/gateway/services/shared/gateway-bootstrap"
import {
  GatewayRegistrationSchema,
} from "../../../../../../runtimes/gateway/services/shared/gateway-bootstrap"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Labels = Type.Record(
  Type.String({ minLength: 1, maxLength: 128 }),
  Type.String({ minLength: 1, maxLength: 256 }),
)

export const GatewayRegistrationListSchema = Type.Array(GatewayRegistrationSchema)

export const RegisterGatewaySchema = Type.Object({
  correlation_id: Identifier,
  runtime_id: Type.Optional(Identifier),
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  gateway_id: Type.Optional(Identifier),
  site_id: Identifier,
  region: Identifier,
  labels: Labels,
}, { additionalProperties: false })

export const GatewayLifecycleActionSchema = Type.Object({
  correlation_id: Identifier,
}, { additionalProperties: false })

export const GatewayRegistrationPathSchema = Type.Object({
  tenant_id: Identifier,
  runtime_id: Identifier,
}, { additionalProperties: false })

export const GatewayRegistrationTenantPathSchema = Type.Object({
  tenant_id: Identifier,
}, { additionalProperties: false })

export type RegisterGatewayInput = Static<typeof RegisterGatewaySchema>
export type GatewayRegistrationCreateInput = Omit<RegisterGatewayInput, "runtime_id"> & { runtime_id: string }
