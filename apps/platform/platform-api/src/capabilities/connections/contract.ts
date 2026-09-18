import { ConnectorConfigurationSchema, validateConnectorConfiguration } from "../../../../../connectors/configuration"
import { Type } from "typebox"
import type { Static } from "typebox"

import { PlatformApiError } from "../errors"
import {
  ProviderCredentialProfileBindingSchema,
  ProviderCredentialProfileReferenceSchema,
} from "../provider-credentials/contract"
import { ProviderTypeSchema } from "../providers/contract"
export type { ProviderType } from "../providers/contract"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })

const ConnectionKindSchema = Type.Union([
  Type.Literal("LLM"),
  Type.Literal("MCP"),
  Type.Literal("API"),
])

const ApiRequestParameterLocationSchema = Type.Union([
  Type.Literal("HEADER"),
  Type.Literal("QUERY"),
])

const ApiRequestParameterActionSchema = Type.Union([
  Type.Literal("PASSTHROUGH"),
  Type.Literal("SET"),
  Type.Literal("REMOVE"),
])

const ApiRequestParameterRuleSchema = Type.Object({
  operation_id: Type.Union([Identifier, Type.Null()]),
  location: ApiRequestParameterLocationSchema,
  name: Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\u0000\\r\\n]+$" }),
  action: ApiRequestParameterActionSchema,
  value: Type.Union([
    Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\u0000\\r\\n]+$" }),
    Type.Null(),
  ]),
}, { additionalProperties: false })

const ApiUpstreamRequestMappingSchema = Type.Object({
  default_action: Type.Literal("PASSTHROUGH"),
  rules: Type.Array(ApiRequestParameterRuleSchema, { maxItems: 256 }),
}, { additionalProperties: false })

export const DownstreamIdentityProjectionSchema = Type.Object({
  mode: Type.Union([
    Type.Literal("NONE"),
    Type.Literal("SERVICE"),
    Type.Literal("USER_PASSTHROUGH"),
    Type.Literal("USER_OAUTH"),
    Type.Literal("USER_PASSWORD"),
  ]),
  authentication: Type.Optional(Type.Union([
    Type.Literal("API_KEY"),
    Type.Literal("PROVIDER_CREDENTIAL_PROFILE"),
  ])),
  forward_headers: Type.Optional(Type.Array(Type.Object({
    name: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9-]+$" }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 1 })),
  oauth_client: Type.Optional(Type.Object({
    issuer: Type.String({ minLength: 1, maxLength: 2048 }),
    authorization_endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
    token_endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
    client_id: Identifier,
    scopes: Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\s]+$" }), { maxItems: 64 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false })

const ConnectionStatusSchema = Type.Union([
  Type.Literal("DRAFT"),
  Type.Literal("READY"),
  Type.Literal("DEGRADED"),
  Type.Literal("DISABLED"),
])

const ConnectionLifecycleSchema = Type.Union([
  Type.Literal("DRAFT"),
  Type.Literal("ENABLED"),
  Type.Literal("DISABLED"),
  Type.Literal("REVOKE_PENDING"),
  Type.Literal("REVOKED"),
])

const ConnectionVerificationStateSchema = Type.Union([
  Type.Literal("UNVERIFIED"),
  Type.Literal("VERIFIED"),
  Type.Literal("FAILED"),
])

const ConnectionHealthStateSchema = Type.Union([
  Type.Literal("UNKNOWN"),
  Type.Literal("HEALTHY"),
  Type.Literal("DEGRADED"),
  Type.Literal("UNAVAILABLE"),
])

const ConnectionCertificateModeSchema = Type.Union([
  Type.Literal("SYSTEM_CA"),
  Type.Literal("CUSTOM_CA"),
])

const ConnectionCertificateStatusSchema = Type.Union([
  Type.Literal("NOT_CONFIGURED"),
  Type.Literal("VALID"),
  Type.Literal("EXPIRING"),
  Type.Literal("EXPIRED"),
  Type.Literal("NOT_YET_VALID"),
  Type.Literal("INVALID"),
])

export const ConnectionCertificateSchema = Type.Object({
  mode: ConnectionCertificateModeSchema,
  certificate_pem: Type.Union([Type.String({ minLength: 1, maxLength: 131_072 }), Type.Null()]),
  fingerprint_sha256: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
  subject: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
  issuer: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
  is_self_signed: Type.Boolean(),
  not_before: Type.Union([Timestamp, Type.Null()]),
  not_after: Type.Union([Timestamp, Type.Null()]),
  status: ConnectionCertificateStatusSchema,
}, { additionalProperties: false })

const McpToolNamespaceSchema = Type.String({
  minLength: 1,
  maxLength: 63,
  pattern: "^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$",
})

const McpToolNameSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\u0000\\r\\n]+$",
})

export const ConnectionRegistrationSchema = Type.Object({
  connector_configuration: Type.Optional(ConnectorConfigurationSchema),
  tenant_id: Identifier,
  connection_id: Identifier,
  resource_id: Identifier,
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  connection_kind: ConnectionKindSchema,
  provider_type: Type.Union([ProviderTypeSchema, Type.Null()]),
  provider_profile_id: Type.Union([Identifier, Type.Null()]),
  endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
  mcp_tool_namespace: Type.Optional(Type.Union([McpToolNamespaceSchema, Type.Null()])),
  mcp_selected_tools: Type.Array(McpToolNameSchema, { maxItems: 1024 }),
  mcp_tool_selection_operation_id: Type.Union([Identifier, Type.Null()]),
  credential_ref: Type.Optional(Type.Union([Identifier, Type.Null()])),
  provider_credential_profile: Type.Optional(Type.Union([ProviderCredentialProfileBindingSchema, Type.Null()])),
  downstream_identity: DownstreamIdentityProjectionSchema,
  request_mapping: Type.Union([ApiUpstreamRequestMappingSchema, Type.Null()]),
  certificate: Type.Optional(ConnectionCertificateSchema),
  status: ConnectionStatusSchema,
  configuration_revision: Type.Integer({ minimum: 1 }),
  lifecycle: ConnectionLifecycleSchema,
  revoke_requested_after_release_revision: Type.Optional(Type.Union([
    Type.Integer({ minimum: 0 }),
    Type.Null(),
  ])),
  verification_state: ConnectionVerificationStateSchema,
  health_state: ConnectionHealthStateSchema,
  health_observed_at: Type.Union([Timestamp, Type.Null()]),
  health_source_revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  routing_priority: Type.Integer({ minimum: 0, maximum: 1000 }),
  region: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  supported_obligations: Type.Array(Identifier, { maxItems: 128 }),
  created_at: Timestamp,
})

export const ConnectionListSchema = Type.Array(ConnectionRegistrationSchema)

export const CreateConnectionSchema = Type.Object({
  connector_configuration: Type.Optional(ConnectorConfigurationSchema),
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  connection_kind: Type.Optional(ConnectionKindSchema),
  provider_type: Type.Optional(ProviderTypeSchema),
  provider_profile_id: Type.Optional(Identifier),
  endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
  mcp_tool_namespace: Type.Optional(McpToolNamespaceSchema),
  credential_ref: Type.Optional(Identifier),
  provider_credential_profile: Type.Optional(ProviderCredentialProfileReferenceSchema),
  downstream_identity: Type.Optional(DownstreamIdentityProjectionSchema),
  request_mapping: Type.Optional(ApiUpstreamRequestMappingSchema),
  certificate_mode: Type.Optional(ConnectionCertificateModeSchema),
  certificate_pem: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 131_072 }), Type.Null()])),
  routing_priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
  region: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  supported_obligations: Type.Optional(Type.Array(Identifier, { maxItems: 128 })),
})

export const UpdateConnectionSchema = Type.Object({
  downstream_identity: Type.Optional(DownstreamIdentityProjectionSchema),
  connector_configuration: Type.Optional(ConnectorConfigurationSchema),
  display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  endpoint: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  mcp_tool_namespace: Type.Optional(Type.Union([McpToolNamespaceSchema, Type.Null()])),
  credential_ref: Type.Optional(Type.Union([Identifier, Type.Null()])),
  provider_credential_profile: Type.Optional(Type.Union([
    ProviderCredentialProfileReferenceSchema,
    Type.Null(),
  ])),
  request_mapping: Type.Optional(ApiUpstreamRequestMappingSchema),
  expected_revision: Type.Integer({ minimum: 1 }),
  routing_priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
  region: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
  supported_obligations: Type.Optional(Type.Array(Identifier, { maxItems: 128 })),
})

export const UpdateMcpRoutingSchema = Type.Object({
  correlation_id: Identifier,
  expected_revision: Type.Integer({ minimum: 1 }),
  mcp_tool_namespace: Type.Optional(Type.Union([McpToolNamespaceSchema, Type.Null()])),
}, { additionalProperties: false })

export const UpdateConnectionCertificateSchema = Type.Object({
  expected_revision: Type.Integer({ minimum: 1 }),
  mode: ConnectionCertificateModeSchema,
  certificate_pem: Type.Union([Type.String({ minLength: 1, maxLength: 131_072 }), Type.Null()]),
}, { additionalProperties: false })

export const ConnectionLifecycleCommandSchema = Type.Object({
  correlation_id: Identifier,
  expected_revision: Type.Integer({ minimum: 1 }),
  command: Type.Union([
    Type.Literal("ENABLE"),
    Type.Literal("DISABLE"),
    Type.Literal("REQUEST_REVOKE"),
    Type.Literal("CONFIRM_REVOKED"),
  ]),
  applied_release_revision: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false })

export const ConnectionHealthObservationSchema = Type.Object({
  correlation_id: Identifier,
  source_revision: Type.Integer({ minimum: 1 }),
  state: ConnectionHealthStateSchema,
  observed_at: Timestamp,
}, { additionalProperties: false })

export const ConnectionHealthBatchObservationSchema = Type.Object({
  correlation_id: Identifier,
  observations: Type.Array(Type.Object({
    resource_id: Identifier,
    connection_id: Identifier,
    source_revision: Type.Integer({ minimum: 1 }),
    state: ConnectionHealthStateSchema,
    observed_at: Timestamp,
  }, { additionalProperties: false }), { minItems: 1, maxItems: 4096 }),
}, { additionalProperties: false })

export const ConnectionHealthTargetSchema = Type.Object({
  resource_id: Identifier,
  connection_id: Identifier,
  endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
  credential_ref: Type.Union([Identifier, Type.Null()]),
  configuration_revision: Type.Integer({ minimum: 1 }),
  health_state: ConnectionHealthStateSchema,
  health_observed_at: Type.Union([Timestamp, Type.Null()]),
  health_source_revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  certificate: Type.Optional(ConnectionCertificateSchema),
}, { additionalProperties: false })

export const ConnectionHealthTargetListSchema = Type.Array(ConnectionHealthTargetSchema)

export const ResourceConnectionsPathSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
})

export const ConnectionPathSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
  connection_id: Identifier,
})

export type ConnectionKind = Static<typeof ConnectionKindSchema>
export type DownstreamIdentityProjection = Static<typeof DownstreamIdentityProjectionSchema>
export type ApiRequestParameterRule = Static<typeof ApiRequestParameterRuleSchema>
export type ApiUpstreamRequestMapping = Static<typeof ApiUpstreamRequestMappingSchema>
export type ConnectionStatus = Static<typeof ConnectionStatusSchema>
export type ConnectionLifecycle = Static<typeof ConnectionLifecycleSchema>
export type ConnectionHealthState = Static<typeof ConnectionHealthStateSchema>
export type ConnectionCertificateMode = Static<typeof ConnectionCertificateModeSchema>
export type ConnectionCertificateStatus = Static<typeof ConnectionCertificateStatusSchema>
export type ConnectionCertificate = Static<typeof ConnectionCertificateSchema>
export type ConnectionRegistration = Static<typeof ConnectionRegistrationSchema>
export type CreateConnectionInput = Static<typeof CreateConnectionSchema>
export type UpdateConnectionInput = Static<typeof UpdateConnectionSchema>
export type ConnectionLifecycleCommand = Static<typeof ConnectionLifecycleCommandSchema>
export type ConnectionHealthObservation = Static<typeof ConnectionHealthObservationSchema>
export type ConnectionHealthBatchObservation = Static<typeof ConnectionHealthBatchObservationSchema>
export type ConnectionHealthTarget = Static<typeof ConnectionHealthTargetSchema>
export type UpdateConnectionCertificateInput = Static<typeof UpdateConnectionCertificateSchema>

const forbiddenApiHeaders = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "transfer-encoding",
  "upgrade",
  "x-request-id",
])

export function canonicalizeApiRequestMapping(
  value: ApiUpstreamRequestMapping | undefined,
): ApiUpstreamRequestMapping {
  const rules = value?.rules ?? []
  const seen = new Set<string>()
  const normalized = rules.map((rule) => {
    const operationId = rule.operation_id?.trim() || null
    const name = rule.location === "HEADER" ? rule.name.trim().toLowerCase() : rule.name.trim()
    const key = `${operationId ?? "*"}:${rule.location}:${name}`
    if (
      !name ||
      seen.has(key) ||
      (rule.location === "QUERY" && !/^[A-Za-z0-9._~-]+$/.test(name)) ||
      (rule.location === "HEADER" &&
        (name.startsWith("x-genio-") || forbiddenApiHeaders.has(name))) ||
      (rule.action === "SET" ? !rule.value?.trim() : rule.value !== null)
    ) {
      throw new PlatformApiError("API_REQUEST_MAPPING_INVALID", 422)
    }
    seen.add(key)
    return {
      operation_id: operationId,
      location: rule.location,
      name,
      action: rule.action,
      value: rule.action === "SET" ? rule.value!.trim() : null,
    }
  })
  normalized.sort((left, right) =>
    `${left.operation_id ?? ""}:${left.location}:${left.name}`.localeCompare(
      `${right.operation_id ?? ""}:${right.location}:${right.name}`,
    ))
  return { default_action: "PASSTHROUGH", rules: normalized }
}

export function normalizeMcpToolNamespace(value: string | null | undefined): string | null {
  if (value === null || value === undefined || !value.trim()) return null
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(normalized) || normalized.length > 63) {
    throw new PlatformApiError("MCP_TOOL_NAMESPACE_INVALID", 422)
  }
  return normalized
}

export function normalizeMcpSelectedTools(values: readonly string[]): string[] {
  const normalized = values.map((value) => value.trim())
  if (
    normalized.length > 1024 ||
    normalized.some((value) => !value || value.length > 256 || /[\u0000\r\n]/.test(value))
  ) {
    throw new PlatformApiError("MCP_TOOL_SELECTION_INVALID", 422)
  }
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right))
}

const forbiddenPassthroughHeaders = new Set([
  "authorization",
  "cookie",
  "host",
  "mcp-session-id",
  "proxy-authorization",
  "x-request-id",
])

export function canonicalizeDownstreamIdentity(
  value: DownstreamIdentityProjection,
): DownstreamIdentityProjection | null {
  if (value.oauth_client !== undefined && value.mode !== "USER_OAUTH") return null
  if (value.mode === "USER_PASSWORD") return value.authentication === undefined && value.forward_headers === undefined ? { mode: "USER_PASSWORD" } : null
  if (value.mode === "NONE") {
    return value.authentication === undefined && value.forward_headers === undefined
      ? { mode: "NONE" }
      : null
  }
  if (value.mode === "SERVICE") {
    if (value.forward_headers !== undefined) return null
    if (
      value.authentication === "PROVIDER_CREDENTIAL_PROFILE"
    ) {
      return { mode: "SERVICE", authentication: "PROVIDER_CREDENTIAL_PROFILE" }
    }
    if (value.authentication === "API_KEY") {
      return { mode: "SERVICE", authentication: "API_KEY" }
    }
    return null
  }
  if (value.mode === "USER_OAUTH") {
    if (value.oauth_client) {
      if (value.authentication !== undefined || value.forward_headers !== undefined) return null
      try {
        const client = value.oauth_client
        const issuer = new URL(client.issuer)
        const authorization = new URL(client.authorization_endpoint)
        const token = new URL(client.token_endpoint)
        if ([issuer, authorization, token].some((url) => url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.origin !== issuer.origin)) return null
        if (!client.client_id.trim() || /[\u0000\r\n]/.test(client.client_id) || !Array.isArray(client.scopes) || client.scopes.length > 64 || client.scopes.some((scope) => !scope || /\s/.test(scope))) return null
        return { mode: "USER_OAUTH", oauth_client: { ...client, client_id: client.client_id.trim(), scopes: [...new Set(client.scopes)] } }
      } catch {
        return null
      }
    }
    return value.authentication === undefined && value.forward_headers === undefined
      ? { mode: "USER_OAUTH" }
      : null
  }
  if (value.authentication !== undefined || value.forward_headers?.length !== 1) return null
  const name = value.forward_headers[0]!.name.trim().toLowerCase()
  if (
    !/^[a-z0-9-]+$/.test(name) ||
    name.startsWith("x-genio-") ||
    forbiddenPassthroughHeaders.has(name)
  ) {
    return null
  }
  return { mode: "USER_PASSTHROUGH", forward_headers: [{ name }] }
}

export function assertInstalledConnectorConfiguration(serviceKind: unknown, configuration: unknown): void {
  const expectedKind = serviceKind === "SERVICENOW_CSM"
    ? "servicenow-csm"
    : serviceKind === "MAIL2000"
      ? "mail2000"
      : null
  if (!expectedKind) return
  try {
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) || (configuration as { kind?: unknown }).kind !== expectedKind) {
      throw new Error("CONNECTOR_CONFIGURATION_REQUIRED")
    }
    validateConnectorConfiguration(configuration)
  } catch {
    throw new PlatformApiError("CONNECTOR_CONFIGURATION_REQUIRED", 422)
  }
}
