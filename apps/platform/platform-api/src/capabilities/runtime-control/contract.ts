import { Type } from "typebox"
import type { Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })

const RuntimeRegistrationStatusSchema = Type.Union([
  Type.Literal("ACTIVE"),
  Type.Literal("DISABLED"),
  Type.Literal("REVOKED"),
])

const RuntimeSessionLeaseSchema = Type.Object({
  tenant_id: Identifier,
  runtime_kind: Type.Literal("GATEWAY"),
  runtime_id: Identifier,
  lease_id: Identifier,
  owner_id: Identifier,
  claimed_at: Timestamp,
  renewed_at: Timestamp,
  expires_at: Timestamp,
}, { additionalProperties: false })

export const RuntimeRegistrationSchema = Type.Object({
  tenant_id: Identifier,
  runtime_kind: Type.Literal("GATEWAY"),
  runtime_id: Identifier,
  target_id: Identifier,
  oidc_client_id: Identifier,
  report_key_id: Identifier,
  report_public_key_pem: Type.String({ minLength: 1, maxLength: 8192 }),
  status: RuntimeRegistrationStatusSchema,
  row_revision: Type.Integer({ minimum: 1 }),
  created_at: Timestamp,
  updated_at: Timestamp,
}, { additionalProperties: false })

export type RuntimeRegistrationStatus = Static<typeof RuntimeRegistrationStatusSchema>
export type RuntimeSessionLease = Static<typeof RuntimeSessionLeaseSchema>
export type RuntimeRegistration = Static<typeof RuntimeRegistrationSchema>

export interface RegisterGatewayRuntimeInput {
  tenantId: string
  runtimeId: string
  targetId: string
  oidcClientId: string
  reportKeyId: string
  reportPublicKeyPem: string
  status?: RuntimeRegistrationStatus
}

export interface RuntimeRegistrationKey {
  tenantId: string
  runtimeKind?: "GATEWAY"
  runtimeId: string
}

export interface RuntimeControlStore {
  registerGatewayRuntime(input: RegisterGatewayRuntimeInput): Promise<RuntimeRegistration>
  getGatewayRuntime(input: RuntimeRegistrationKey): Promise<RuntimeRegistration | null>
  listGatewayRuntimes(input: { tenantId: string; targetId?: string }): Promise<RuntimeRegistration[]>
  claimGatewaySessionLease(input: {
    tenantId: string
    runtimeId: string
    ownerId: string
    leaseId: string
    ttlSeconds: number
  }): Promise<RuntimeSessionLease>
  renewGatewaySessionLease(input: {
    tenantId: string
    runtimeId: string
    ownerId: string
    leaseId: string
    ttlSeconds: number
  }): Promise<RuntimeSessionLease>
  releaseGatewaySessionLease(input: {
    tenantId: string
    runtimeId: string
    ownerId: string
    leaseId: string
  }): Promise<void>
  getGatewaySessionLease(input: {
    tenantId: string
    runtimeId: string
  }): Promise<RuntimeSessionLease | null>
}
