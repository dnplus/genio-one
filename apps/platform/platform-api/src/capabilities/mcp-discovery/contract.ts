import { Type, type Static } from "typebox"

import { DownstreamIdentityProjectionSchema } from "../connections/contract"

const Identifier = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" })
const Timestamp = Type.Integer({ minimum: 0 })

const McpDiscoveryStateSchema = Type.Union([
  Type.Literal("PENDING"),
  Type.Literal("RUNNING"),
  Type.Literal("SUCCEEDED"),
  Type.Literal("FAILED"),
])

const McpDiscoveryToolSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 256 }),
  title: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
  description: Type.Union([Type.String({ maxLength: 16_384 }), Type.Null()]),
}, { additionalProperties: false })

export const McpDiscoveryCandidateSchema = Type.Object({
  candidate_id: Identifier,
  capability_id: Identifier,
  tool_name: Identifier,
  revision_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  state: Type.Union([
    Type.Literal("NEW"),
    Type.Literal("PUBLISHED"),
    Type.Literal("IGNORED"),
    Type.Literal("BLOCKED"),
  ]),
}, { additionalProperties: false })

export const McpDiscoveryObservationSchema = Type.Object({
  protocol_version: Type.String({ minLength: 1, maxLength: 64 }),
  server_name: Type.String({ minLength: 1, maxLength: 256 }),
  server_version: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
  tools: Type.Array(McpDiscoveryToolSchema, { maxItems: 1024 }),
}, { additionalProperties: false })

export const McpDiscoveryOperationSchema = Type.Object({
  tenant_id: Identifier,
  operation_id: Identifier,
  gateway_id: Identifier,
  resource_id: Identifier,
  connection_id: Identifier,
  requested_by_subject_id: Identifier,
  correlation_id: Identifier,
  state: McpDiscoveryStateSchema,
  runtime_id: Type.Union([Identifier, Type.Null()]),
  endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
  credential_ref: Type.Union([Identifier, Type.Null()]),
  downstream_identity: DownstreamIdentityProjectionSchema,
  observation: Type.Union([McpDiscoveryObservationSchema, Type.Null()]),
  candidates: Type.Array(McpDiscoveryCandidateSchema, { maxItems: 1024 }),
  error_code: Type.Union([Identifier, Type.Null()]),
  error_message: Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]),
  created_at: Timestamp,
  claimed_at: Type.Union([Timestamp, Type.Null()]),
  completed_at: Type.Union([Timestamp, Type.Null()]),
  updated_at: Timestamp,
}, { additionalProperties: false })

export const RequestMcpDiscoverySchema = Type.Object({
  correlation_id: Identifier,
}, { additionalProperties: false })

export const DecideMcpDiscoveryCandidateSchema = Type.Object({
  expected_revision_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  state: Type.Union([Type.Literal("PUBLISHED"), Type.Literal("IGNORED"), Type.Literal("BLOCKED")]),
}, { additionalProperties: false })

export const CompleteMcpDiscoverySchema = Type.Union([
  Type.Object({
    state: Type.Literal("SUCCEEDED"),
    observation: McpDiscoveryObservationSchema,
  }, { additionalProperties: false }),
  Type.Object({
    state: Type.Literal("FAILED"),
    error_code: Identifier,
    error_message: Type.String({ minLength: 1, maxLength: 2048 }),
  }, { additionalProperties: false }),
])

export const McpDiscoveryCredentialSchema = Type.Object({
  access_token: Type.String({ minLength: 1, maxLength: 16384 }),
  expires_at: Type.Union([Timestamp, Type.Null()]),
}, { additionalProperties: false })

export type McpDiscoveryObservation = Static<typeof McpDiscoveryObservationSchema>
export type McpDiscoveryOperation = Static<typeof McpDiscoveryOperationSchema>
export type McpDiscoveryCandidate = Static<typeof McpDiscoveryCandidateSchema>
export type CompleteMcpDiscoveryInput = Static<typeof CompleteMcpDiscoverySchema>
export type McpDiscoveryCredential = Static<typeof McpDiscoveryCredentialSchema>
