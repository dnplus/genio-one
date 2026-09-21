import { Type } from "typebox"
import type { Static } from "typebox"

import { CompiledEnforcementChainSchema } from "../enforcement/contract"
import type { CompiledEnforcementChain } from "../enforcement/contract"
import { ConnectionRegistrationSchema } from "../connections/contract"
import type { ConnectionRegistration } from "../connections/contract"
import {
  ConnectionModelMappingSchema,
  PublicModelSchema,
} from "../models/contract"
import type { ConnectionModelMapping, PublicModel } from "../models/contract"
import {
  ResourcePublicationEndpointSchema,
  ResourceRegistrationSchema,
} from "../resources/contract"
import type { ResourceRegistration, ResourcePublicationEndpoint } from "../resources/contract"
import { ProviderCredentialProfileRevisionSchema } from "../provider-credentials/contract"
import type { ProviderCredentialProfileRevision } from "../provider-credentials/contract"
import {
  Ed25519SignatureSchema,
  type Ed25519Signature,
} from "@genioone/protocol/ed25519-signature"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const KubernetesName = Type.String({ minLength: 1, maxLength: 253 })

/**
 * The public projection request is deliberately reference-only. The caller
 * can name a persisted Publication, but cannot inject a Resource, Connection,
 * model, or One Policy chain into the compiler. The server resolves the
 * immutable review snapshot behind this reference.
 */
export const GatewayProjectionRequestSchema = Type.Object({
  publication_id: Identifier,
}, { additionalProperties: false })

const GatewayNativeResourceSchema = Type.Object({
  apiVersion: Type.String({ minLength: 1 }),
  kind: Type.String({ minLength: 1 }),
  metadata: Type.Object({
    name: KubernetesName,
    namespace: Type.Optional(KubernetesName),
    labels: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
    annotations: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
  }),
  spec: Type.Record(Type.String({ minLength: 1 }), Type.Any()),
})

const GatewayNativeDataResourceSchema = Type.Object({
  apiVersion: Type.String({ minLength: 1 }),
  kind: Type.String({ minLength: 1 }),
  metadata: Type.Object({
    name: KubernetesName,
    namespace: Type.Optional(KubernetesName),
    labels: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
    annotations: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
  }),
  data: Type.Record(Type.String({ minLength: 1 }), Type.String()),
  type: Type.Optional(Type.String({ minLength: 1 })),
})

const GatewayNativeResourceDocumentSchema = Type.Union([
  GatewayNativeResourceSchema,
  GatewayNativeDataResourceSchema,
])

const GatewayProjectionPublicationSchema = Type.Object({
  gateway_id: Identifier,
  hostname: Type.String({ minLength: 1, maxLength: 253 }),
  base_path: Type.String({ minLength: 1, maxLength: 2048 }),
})

const GatewayPolicyBundleSchema = Type.Object({
  /** Safe, versioned One Policy input retained beside (not inside) CRDs. */
  enforcement_chain: CompiledEnforcementChainSchema,
})

const GatewayProjectionSignatureSchema = Ed25519SignatureSchema

const GatewayProjectionEnvelopeSchema = Type.Object({
  schema_version: Type.Literal("genio.one.gateway.v1"),
  projection_id: Identifier,
  tenant_id: Identifier,
  publication_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
  endpoint_revision: Type.Integer({ minimum: 1 }),
  policy_revision: Type.Integer({ minimum: 1 }),
  revision: Type.Integer({ minimum: 1 }),
  digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  signature: GatewayProjectionSignatureSchema,
  publication_endpoint: GatewayProjectionPublicationSchema,
  policy_bundle: GatewayPolicyBundleSchema,
})

/**
 * A DELETE is a signed tombstone, not an empty APPLY. Keeping the operation
 * discriminator coupled to the resource cardinality makes malformed
 * projection documents fail before they reach the runtime adapter.
 */
export const GatewayProjectionSchema = Type.Union([
  Type.Intersect([
    GatewayProjectionEnvelopeSchema,
    Type.Object({
      operation: Type.Literal("APPLY"),
      resources: Type.Array(GatewayNativeResourceDocumentSchema, { minItems: 1 }),
    }),
  ]),
  Type.Intersect([
    GatewayProjectionEnvelopeSchema,
    Type.Object({
      operation: Type.Literal("DELETE"),
      resources: Type.Array(GatewayNativeResourceDocumentSchema, { maxItems: 0 }),
    }),
  ]),
])

export const GatewayProjectionSnapshotSchema = Type.Object({
  tenant_id: Identifier,
  publication_id: Identifier,
  request_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
  endpoint_revision: Type.Integer({ minimum: 1 }),
  resource_revision: Type.Integer({ minimum: 1 }),
  policy_revision: Type.Integer({ minimum: 1 }),
  resource_digest: Type.String({ minLength: 1 }),
  snapshot_digest: Type.String({ minLength: 1 }),
  resource: ResourceRegistrationSchema,
  publication_endpoint: ResourcePublicationEndpointSchema,
  one_policy_chain: CompiledEnforcementChainSchema,
  connections: Type.Array(ConnectionRegistrationSchema, { minItems: 1 }),
  provider_credential_profiles: Type.Optional(Type.Array(ProviderCredentialProfileRevisionSchema)),
  models: Type.Array(PublicModelSchema),
  model_mappings: Type.Array(ConnectionModelMappingSchema),
})

export const GatewayProjectionPathSchema = Type.Object({
  tenant_id: Identifier,
})

export type GatewayProjectionRequest = Static<typeof GatewayProjectionRequestSchema>
export type GatewayNativeResource = Static<typeof GatewayNativeResourceSchema>
export type GatewayProjectionPublication = Static<typeof GatewayProjectionPublicationSchema>
export type GatewayPolicyBundle = Static<typeof GatewayPolicyBundleSchema>
export type GatewayProjectionSignature = Ed25519Signature
export type GatewayNativeDataResource = Static<typeof GatewayNativeDataResourceSchema>
export type GatewayProjection = Omit<Static<typeof GatewayProjectionSchema>, "resources"> & {
  resources: GatewayNativeResource[]
}

/**
 * Internal, server-resolved input to the pure Envoy renderer. It is never a
 * public HTTP body. All members are copied into a Publication review snapshot
 * before a build claim is granted, so compilation is not affected by later
 * draft edits.
 */
export interface GatewayProjectionSnapshot {
  tenant_id: string
  publication_id: string
  request_id: string
  resource_id: string
  capability_id: string
  endpoint_revision: number
  resource_revision: number
  policy_revision: number
  resource_digest: string
  snapshot_digest: string
  resource: ResourceRegistration
  publication_endpoint: ResourcePublicationEndpoint
  one_policy_chain: CompiledEnforcementChain
  connections: ConnectionRegistration[]
  provider_credential_profiles?: ProviderCredentialProfileRevision[]
  models: PublicModel[]
  /** Frozen provider-model candidates for every public alias and Connection. */
  model_mappings: ConnectionModelMapping[]
}

export interface GatewayProjectionSource {
  getSnapshot(input: {
    tenantId: string
    publicationId: string
  }): Promise<GatewayProjectionSnapshot | null>
}

/** Read-only access to an immutable, already-signed native projection. */
export interface GatewayProjectionRepository {
  getProjection(input: {
    tenantId: string
    projectionId: string
  }): Promise<GatewayProjection | null>
}

/** A signer signs the canonical, digest-bearing projection envelope. */
export interface GatewayProjectionSigner {
  readonly algorithm: "Ed25519"
  readonly keyId: string
  sign(payload: Uint8Array): Promise<string> | string
}

export interface GatewayServiceReference {
  name: string
  port: number
  /** Optional OTLP/HTTP port for GatewayConfig; `port` remains native gRPC. */
  httpPort?: number
  /** Defaults to the Envoy Gateway Backend API. */
  group?: string
  /** Defaults to Backend. */
  kind?: string
  namespace?: string
  /** Optional host for an emitted Backend object. */
  host?: string
}

export interface GatewayProjectionRendererOptions {
  namespace?: string
  /**
   * Envoy AI Gateway v1.1 applies one process-wide root prefix to every
   * generated HTTPRoute. AIGatewayRoute itself only accepts header matches,
   * so a publication path must agree with this configured native prefix.
   */
  aigwRootPrefix?: string
  /**
   * Test-only escape hatch. Production composition must inject a durable
   * signer; an ephemeral key cannot verify projections after restart.
   */
  allowEphemeralSigner?: boolean
  signer?: GatewayProjectionSigner
  extAuth?: GatewayServiceReference
  /** Product Processor HTTP bridge selected by the projection adapter. */
  processor?: GatewayServiceReference
  /** Product Processor gRPC ext_proc service used for streamed response hooks. */
  processorGrpc?: GatewayServiceReference
  /** Native Envoy OpenTelemetry access-log backend. Omit to keep file-only logs. */
  telemetry?: GatewayServiceReference
  /** Runtime-reachable JWKS endpoint; JWT issuer matching remains policy-owned. */
  jwtRemoteJwksUri?: string
  extAuthTimeout?: string
}
