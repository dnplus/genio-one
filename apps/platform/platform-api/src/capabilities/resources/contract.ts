import { Type } from "typebox"
import type { Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })

const ResourceKindSchema = Type.Union([
  Type.Literal("MCP"),
  Type.Literal("LLM"),
  Type.Literal("SAAS"),
  Type.Literal("API"),
  Type.Literal("EXTENSION"),
])

const ResourceLifecycleSchema = Type.Union([
  Type.Literal("DRAFT"),
  Type.Literal("PUBLISHED"),
  Type.Literal("DEPRECATED"),
  Type.Literal("RETIRED"),
])

export const InstallationServiceKindSchema = Type.Union([
  Type.Literal("SERVICENOW_CSM"),
  Type.Literal("MAIL2000"),
  Type.Literal("DISCOVERY"),
  Type.Literal("GENIO_BOT"),
])

const ResourceCapabilitySchema = Type.Object({
  capability_id: Identifier,
  display_name: Type.String({ minLength: 1, maxLength: 512 }),
})

export const ResourcePublicationEndpointSchema = Type.Object({
  gateway_id: Identifier,
  hostname: Type.String({ minLength: 1, maxLength: 253 }),
  base_path: Type.String({ minLength: 1, maxLength: 2048 }),
  visibility: Type.Union([
    Type.Literal("PRIVATE"),
    Type.Literal("REQUEST"),
    Type.Literal("PUBLIC"),
  ]),
  dns_management: Type.Union([
    Type.Literal("PLATFORM_MANAGED"),
    Type.Literal("EXTERNAL"),
  ]),
  dns_verification: Type.Union([
    Type.Literal("PENDING"),
    Type.Literal("VERIFIED"),
    Type.Literal("FAILED"),
  ]),
  dns_target: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

export const ResourcePublicationRequestSchema = Type.Object({
  request_id: Identifier,
  state: Type.Union([
    Type.Literal("PENDING"),
    Type.Literal("APPROVED"),
    Type.Literal("REJECTED"),
    Type.Literal("CANCELLED"),
  ]),
  requested_by: Identifier,
  requested_at: Timestamp,
  reviewed_by: Type.Optional(Type.Union([Identifier, Type.Null()])),
  reviewed_at: Type.Optional(Type.Union([Timestamp, Type.Null()])),
  /**
   * Publication build state is separate from the request decision.  An
   * approved request can still be BUILDING while the signed Gateway
   * Projection is compiled outside the database transaction, or FAILED while
   * remaining retryable without changing the Resource lifecycle.
   */
  publication_state: Type.Optional(
    Type.Union([
      Type.Literal("IDLE"),
      Type.Literal("PENDING_REVIEW"),
      Type.Literal("BUILDING"),
      Type.Literal("FAILED"),
      Type.Literal("READY"),
    ]),
  ),
  attempt_id: Type.Optional(Type.Union([Identifier, Type.Null()])),
  failure_code: Type.Optional(Type.Union([Identifier, Type.Null()])),
})

const McpAuthorizationSchema = Type.Object({
  resource: Type.String({ minLength: 1 }),
  authorization_servers: Type.Array(Type.String({ minLength: 1 })),
  scopes_supported: Type.Array(Type.String({ minLength: 1 })),
  required_issuer: Type.String({ minLength: 1 }),
})

const ApiInboundSecuritySchema = Type.Union([
  Type.Object({ type: Type.Literal("KEYLESS") }),
  Type.Object({ type: Type.Literal("API_KEY"), header_name: Type.Literal("x-api-key") }),
  Type.Object({ type: Type.Literal("MTLS"), trusted_client_ca_pem: Type.String() }),
  Type.Object({
    type: Type.Literal("JWT"),
    issuer: Type.String(),
    audience: Type.String(),
    jwks_url: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("MTLS_AND_JWT"),
    trusted_client_ca_pem: Type.String(),
    issuer: Type.String(),
    audience: Type.String(),
    jwks_url: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("OAUTH2"),
    issuer: Type.String(),
    audience: Type.String(),
    jwks_url: Type.String(),
    scope: Type.String(),
  }),
])

const ApiMetadataSchema = Type.Object({
  api_product_id: Identifier,
  openapi_version: Type.String({ minLength: 1 }),
  document_title: Type.String({ minLength: 1 }),
  document_version: Type.String({ minLength: 1 }),
  public_path: Type.String({ minLength: 1 }),
  inbound_security: ApiInboundSecuritySchema,
  request_schema_validation: Type.Boolean(),
  operations: Type.Array(
    Type.Object({
      operation_id: Identifier,
      method: Type.String({ minLength: 1 }),
      path: Type.String({ minLength: 1 }),
      parameters: Type.Optional(Type.Array(Type.Object({
        location: Type.Union([Type.Literal("HEADER"), Type.Literal("QUERY")]),
        name: Type.String({ minLength: 1, maxLength: 256 }),
      }, { additionalProperties: false }))),
    }),
  ),
  a2a: Type.Optional(Type.Object({
    protocol_version: Type.Literal("1.0"),
    operation: Type.Union([
      Type.Literal("SEND_MESSAGE"),
      Type.Literal("SEND_STREAMING_MESSAGE"),
    ]),
    target_agent_subject_id: Identifier,
  }, { additionalProperties: false })),
})

const RuntimeTierSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("headless"),
  Type.Literal("desktop"),
])

const BotPackageManifestSchema = Type.Object({
  package_type: Type.Union([
    Type.Literal("BOT"),
    Type.Literal("SKILL"),
    Type.Literal("PLUGIN"),
  ]),
  resource_id: Type.Optional(Identifier),
  version: Type.Optional(Identifier),
  model_route: Type.Optional(Type.Union([
    Type.Literal("codex-subscription"),
    Type.Literal("genio-gateway"),
  ])),
  profile: Type.Object({
    title: Type.String({ minLength: 1, maxLength: 512 }),
    description: Type.String({ minLength: 1, maxLength: 4096 }),
    avatar: Type.Unknown(),
  }, { additionalProperties: false }),
  skills: Type.Array(Type.Object({
    id: Identifier,
    path: Type.String({ minLength: 1, maxLength: 2048 }),
    digest: Type.Optional(Identifier),
  }, { additionalProperties: false })),
  plugins: Type.Array(Type.Object({
    name: Identifier,
    marketplace: Type.Optional(Identifier),
    marketplace_path: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    digest: Type.Optional(Identifier),
  }, { additionalProperties: false })),
  resource_bindings: Type.Array(Type.Object({
    resource_id: Identifier,
    capability_id: Identifier,
  }, { additionalProperties: false })),
  default_runtime_tier: RuntimeTierSchema,
  manifest_digest: Identifier,
  artifact_digest: Identifier,
  source: Type.Optional(Type.Object({
    kind: Type.Union([Type.Literal("GITHUB"), Type.Literal("FIXTURE"), Type.Literal("UPLOAD")]),
    ref: Identifier,
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  }, { additionalProperties: false })),
}, { additionalProperties: false })

export const ResourceRegistrationSchema = Type.Object({
  builtin_service: Type.Optional(Type.Union([Type.Literal("DISCOVERY"), Type.Null()])),
  installation_owned: Type.Optional(Type.Boolean()),
  service_kind: Type.Optional(Type.Union([InstallationServiceKindSchema, Type.Null()])),
  tenant_id: Identifier,
  resource_id: Identifier,
  documentation: Type.Optional(Type.String({ maxLength: 100000 })),
  display_name: Type.String({ minLength: 1, maxLength: 512 }),
  kind: ResourceKindSchema,
  owner_organization_id: Identifier,
  registered_by_subject_id: Type.Optional(Identifier),
  authentication_strategy: Type.Union([
    Type.Literal("NONE"),
    Type.Literal("EMA"),
    Type.Literal("OAUTH"),
    Type.Literal("API_KEY"),
    Type.Literal("MTLS"),
  ]),
  environment_id: Identifier,
  version: Type.String({ minLength: 1, maxLength: 128 }),
  lifecycle: ResourceLifecycleSchema,
  publication_endpoint: Type.Optional(
    Type.Union([ResourcePublicationEndpointSchema, Type.Null()]),
  ),
  publication_request: Type.Optional(
    Type.Union([ResourcePublicationRequestSchema, Type.Null()]),
  ),
  operational_state: Type.Union([
    Type.Literal("UNKNOWN"),
    Type.Literal("HEALTHY"),
    Type.Literal("DEGRADED"),
    Type.Literal("UNAVAILABLE"),
  ]),
  health_observed_at: Type.Optional(Timestamp),
  capabilities: Type.Array(ResourceCapabilitySchema),
  capabilities_owner_defined: Type.Optional(Type.Boolean()),
  mcp_authorization: Type.Optional(Type.Union([McpAuthorizationSchema, Type.Null()])),
  api: Type.Optional(Type.Union([ApiMetadataSchema, Type.Null()])),
  extension_metadata: Type.Optional(Type.Union([BotPackageManifestSchema, Type.Null()])),
  enforcement_point_id: Identifier,
  created_at: Timestamp,
})

export const ResourceListSchema = Type.Array(ResourceRegistrationSchema)

export const ResourceIdPathSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
})

export const ResourceCreateSchema = Type.Object({
  display_name: Type.String({ minLength: 1, maxLength: 512 }),
  kind: ResourceKindSchema,
  owner_organization_id: Identifier,
  authentication_strategy: Type.Union([
    Type.Literal("NONE"),
    Type.Literal("EMA"),
    Type.Literal("OAUTH"),
    Type.Literal("API_KEY"),
    Type.Literal("MTLS"),
  ]),
  environment_id: Identifier,
  version: Type.String({ minLength: 1, maxLength: 128 }),
  capabilities: Type.Optional(Type.Array(ResourceCapabilitySchema)),
  api: Type.Optional(ApiMetadataSchema),
  extension_metadata: Type.Optional(BotPackageManifestSchema),
  enforcement_point_id: Identifier,
})

export const OpenApiImportSchema = Type.Object({
  owner_organization_id: Identifier,
  authentication_strategy: Type.Union([
    Type.Literal("NONE"),
    Type.Literal("EMA"),
    Type.Literal("OAUTH"),
    Type.Literal("API_KEY"),
    Type.Literal("MTLS"),
  ]),
  environment_id: Identifier,
  version: Type.String({ minLength: 1, maxLength: 128 }),
  public_path: Type.String({ minLength: 1, maxLength: 2048 }),
  inbound_security: ApiInboundSecuritySchema,
  request_schema_validation: Type.Boolean(),
  enforcement_point_id: Identifier,
  a2a: Type.Optional(Type.Object({
    protocol_version: Type.Literal("1.0"),
    operation: Type.Union([Type.Literal("SEND_MESSAGE"), Type.Literal("SEND_STREAMING_MESSAGE")]),
    target_agent_subject_id: Identifier,
  }, { additionalProperties: false })),
  document: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false })

export const ResourceUpdateSchema = Type.Object({
  documentation: Type.Optional(Type.String({ maxLength: 100000 })),
  display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  owner_organization_id: Type.Optional(Identifier),
  version: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  capabilities: Type.Optional(Type.Array(ResourceCapabilitySchema)),
  extension_metadata: Type.Optional(Type.Union([BotPackageManifestSchema, Type.Null()])),
})

export const ResourceLifecycleCommandSchema = Type.Object({
  lifecycle: Type.Union([
    Type.Literal("DRAFT"),
    Type.Literal("DEPRECATED"),
    Type.Literal("RETIRED"),
  ]),
})

export const ResourcePublicationEndpointInputSchema = Type.Object({
  gateway_id: Identifier,
  hostname: Type.String({ minLength: 1, maxLength: 253, pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$" }),
  base_path: Type.String({ minLength: 1, maxLength: 2048, pattern: "^/" }),
  visibility: Type.Optional(
    Type.Union([
      Type.Literal("PRIVATE"),
      Type.Literal("REQUEST"),
      Type.Literal("PUBLIC"),
    ]),
  ),
  dns_management: Type.Union([
    Type.Literal("PLATFORM_MANAGED"),
    Type.Literal("EXTERNAL"),
  ]),
  dns_verification: Type.Union([
    Type.Literal("PENDING"),
    Type.Literal("VERIFIED"),
    Type.Literal("FAILED"),
  ]),
  dns_target: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

const ReviewPublicationRequestSchema = Type.Object({
  decision: Type.Union([Type.Literal("APPROVE"), Type.Literal("REJECT")]),
  reviewer_id: Identifier,
})

export const TenantPathSchema = Type.Object({
  tenant_id: Identifier,
})

export type ResourceRegistration = Static<typeof ResourceRegistrationSchema>
export type InstallationServiceKind = Static<typeof InstallationServiceKindSchema>
export type ApiMetadata = Static<typeof ApiMetadataSchema>
export type BotPackageManifest = Static<typeof BotPackageManifestSchema>
export type OpenApiImportInput = Static<typeof OpenApiImportSchema>
export type ResourceCreateInput = Static<typeof ResourceCreateSchema>
export type ResourceUpdateInput = Static<typeof ResourceUpdateSchema>
export type ResourceLifecycle = Static<typeof ResourceLifecycleSchema>
export type ResourcePublicationEndpoint = Static<typeof ResourcePublicationEndpointSchema>
export type ResourcePublicationEndpointInput = Static<
  typeof ResourcePublicationEndpointInputSchema
>
export type ReviewPublicationRequestInput = Static<typeof ReviewPublicationRequestSchema>
