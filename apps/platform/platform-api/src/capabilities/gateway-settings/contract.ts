import { Type, type Static } from "typebox"

const Identifier = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\u0000\\r\\n]+$",
})

export const GatewayDiagnosticSettingsSchema = Type.Object({
  tenant_id: Identifier,
  gateway_id: Identifier,
  capture_message_content: Type.Boolean(),
  row_revision: Type.Integer({ minimum: 1 }),
  updated_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const UpdateGatewayDiagnosticSettingsSchema = Type.Object({
  capture_message_content: Type.Boolean(),
}, { additionalProperties: false })

export const GatewayDiagnosticSettingsPathSchema = Type.Object({
  tenant_id: Identifier,
  gateway_id: Identifier,
}, { additionalProperties: false })

export type GatewayDiagnosticSettings = Static<typeof GatewayDiagnosticSettingsSchema>
export type UpdateGatewayDiagnosticSettings = Static<typeof UpdateGatewayDiagnosticSettingsSchema>
