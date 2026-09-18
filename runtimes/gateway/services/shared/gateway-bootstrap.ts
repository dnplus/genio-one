import { Type, type Static } from "typebox"
import { Check, Errors } from "typebox/value"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })
const NullableTimestamp = Type.Union([Timestamp, Type.Null()])
const VerificationKeyRingSchema = Type.Object({
  schema_version: Type.Literal(1),
  keys: Type.Array(Type.Object({
    key_id: Identifier,
    public_key_pem: Type.String({ minLength: 1, maxLength: 8_192 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false })

export const GatewayRegistrationSchema = Type.Object({
  tenant_id: Identifier,
  runtime_id: Identifier,
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  gateway_id: Identifier,
  site_id: Identifier,
  region: Identifier,
  labels: Type.Record(
    Type.String({ minLength: 1, maxLength: 128 }),
    Type.String({ minLength: 1, maxLength: 256 }),
  ),
  identity_client_id: Identifier,
  state: Type.Union([
    Type.Literal("PROVISIONING"),
    Type.Literal("ACTIVE"),
    Type.Literal("RETIRED"),
  ]),
  registered_by: Identifier,
  registered_at: Timestamp,
  activated_at: NullableTimestamp,
  retired_at: NullableTimestamp,
  row_revision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })

export const GatewayBootstrapConfigurationSchema = Type.Object({
  schema_version: Type.Literal("genio.one.gateway-bootstrap.v1"),
  registration: GatewayRegistrationSchema,
  platform_origin: Type.String({ minLength: 1, maxLength: 2_048 }),
  tenant_id: Identifier,
  runtime_id: Identifier,
  gateway_id: Identifier,
  oidc: Type.Object({
    issuer: Type.String({ minLength: 1, maxLength: 2_048 }),
    token_endpoint: Type.String({ minLength: 1, maxLength: 2_048 }),
    audience: Identifier,
    scope: Identifier,
    client_id: Identifier,
    client_secret: Type.String({ minLength: 1, maxLength: 4_096 }),
  }, { additionalProperties: false }),
  report_signing: Type.Object({
    key_id: Identifier,
    private_key_pem: Type.String({ minLength: 1, maxLength: 8_192 }),
  }, { additionalProperties: false }),
  runtime_command_verification_keys: VerificationKeyRingSchema,
  policy_release_root_keys: VerificationKeyRingSchema,
  credential_delivery: Type.Literal("ONE_TIME"),
}, { additionalProperties: false })

export type GatewayRegistration = Static<typeof GatewayRegistrationSchema>
export type GatewayBootstrapConfiguration = Static<typeof GatewayBootstrapConfigurationSchema>

class GatewayBootstrapValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GatewayBootstrapValidationError"
  }
}

export function parseGatewayBootstrapConfiguration(value: unknown): GatewayBootstrapConfiguration {
  if (!Check(GatewayBootstrapConfigurationSchema, value)) {
    const [error] = [...Errors(GatewayBootstrapConfigurationSchema, value)]
    throw new GatewayBootstrapValidationError(
      error ? `Gateway bootstrap is invalid at ${error.instancePath || "/"}` : "Gateway bootstrap is invalid",
    )
  }
  return value
}
