import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import type { ResourceLifecycleReleasePublisher } from "../resources/module"
import type { ApplicationApiKeyCredential } from "./contract"
import type { ApplicationRegistry } from "./module"
import { PlatformApiError } from "../errors"
import {
  applicationApiKeyHash,
  assertApplicationCredentialScopeCeiling,
  applicationApiKeyIsUsable,
  createApplicationApiKeyMaterial,
  validateApplicationApiKeyInput,
} from "./api-keys"

type Row = Record<string, unknown>

type Options = {
  sql: SqlAdapter
  idFactory: () => string
  now: () => number
  releasePublisher?: ResourceLifecycleReleasePublisher
}

export const API_KEY_COLUMNS = `credential_id, application_id, application_subject_id,
  resource_id, capability_id, generation, kind, state, created_at, activated_at,
  valid_until, revoked_at, display_name, scopes, api_key_prefix, expires_at`

function timestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  if (typeof value === "number") return value
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
}

export function applicationApiKeyCredential(row: Row): ApplicationApiKeyCredential {
  const scopes = typeof row.scopes === "string" ? JSON.parse(row.scopes) : row.scopes
  if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== "string")) {
    throw new PlatformApiError("APPLICATION_CREDENTIAL_DATA_INVALID", 500)
  }
  return {
    credential_id: String(row.credential_id),
    application_id: String(row.application_id),
    application_subject_id: String(row.application_subject_id),
    resource_id: row.resource_id === null || row.resource_id === undefined ? null : String(row.resource_id),
    capability_id: row.capability_id === null || row.capability_id === undefined ? null : String(row.capability_id),
    generation: Number(row.generation),
    kind: "API_KEY",
    oauth_client_id: null,
    oauth_issuer: null,
    oauth_audience: null,
    oauth_scope: null,
    display_name: String(row.display_name),
    key_prefix: String(row.api_key_prefix),
    scopes,
    expires_at: timestamp(row.expires_at) ?? 0,
    state: String(row.state) as ApplicationApiKeyCredential["state"],
    created_at: timestamp(row.created_at) ?? 0,
    activated_at: timestamp(row.activated_at),
    valid_until: timestamp(row.valid_until),
    revoked_at: timestamp(row.revoked_at),
  }
}

function delivered(credential: ApplicationApiKeyCredential, secret: string) {
  return {
    credential,
    api_key: secret,
    oauth_client_secret: null,
    oauth_token_endpoint: null,
    credential_delivery: "ONE_TIME" as const,
  }
}

async function assertNewOperation(transaction: SqlTransaction, tenantId: string, applicationId: string, correlationId: string) {
  const duplicate = await transaction.query<Row>(
    `select credential_id from genio_one_application_api_credentials
      where tenant_id = $1 and application_id = $2 and operation_correlation_id = $3
      limit 1`,
    [tenantId, applicationId, correlationId],
  )
  if (duplicate.rows[0]) throw new PlatformApiError("APPLICATION_CREDENTIAL_SECRET_ALREADY_DELIVERED", 409)
}

async function resourceGateways(transaction: SqlTransaction, input: {
  tenantId: string
  applicationSubjectId: string
  resourceId: string
  capabilityId: string
  credentialId: string
  now: number
}): Promise<string[]> {
  const result = await transaction.query<Row>(
    `select resource.kind, resource.api_metadata, publication.gateway_id
       from genio_one_resources resource
       join genio_one_publications publication
         on publication.tenant_id = resource.tenant_id and publication.resource_id = resource.resource_id
        and publication.publication_state in ('PUBLISHED', 'DEPRECATED')
      where resource.tenant_id = $1 and resource.resource_id = $2
        and resource.lifecycle in ('PUBLISHED', 'DEPRECATED')
        and resource.capabilities @> jsonb_build_array(jsonb_build_object('capability_id', $3::text))
        and exists (
          select 1 from genio_one_model_entitlements entitlement
           where entitlement.tenant_id = resource.tenant_id
             and entitlement.subject_id = $4 and entitlement.resource_id = resource.resource_id
             and entitlement.capability_id = $3 and entitlement.state = 'ACTIVE'
             and (entitlement.client_id is null or entitlement.client_id = $5)
             and entitlement.starts_at <= to_timestamp($6)
             and (entitlement.expires_at is null or entitlement.expires_at > to_timestamp($6))
        )
      order by publication.gateway_id
      for update of resource`,
    [input.tenantId, input.resourceId, input.capabilityId, input.applicationSubjectId, input.credentialId, input.now],
  )
  const row = result.rows[0]
  if (!row) throw new PlatformApiError("APPLICATION_CREDENTIAL_NOT_ENTITLED", 403)
  const metadata = typeof row.api_metadata === "string" ? JSON.parse(row.api_metadata) : row.api_metadata
  if (!['API', 'LLM'].includes(String(row.kind)) || (metadata && typeof metadata === "object" && metadata.a2a != null)) {
    throw new PlatformApiError("API_KEY_RESOURCE_UNSUPPORTED", 422)
  }
  return [...new Set(result.rows.map(publication => {
    if (typeof publication.gateway_id !== "string" || !publication.gateway_id) throw new PlatformApiError("APPLICATION_CREDENTIAL_DATA_INVALID", 500)
    return publication.gateway_id
  }))]
}

async function nextGeneration(transaction: SqlTransaction, tenantId: string, applicationId: string, resourceId: string | null, capabilityId: string | null): Promise<number> {
  const result = await transaction.query<Row>(
    `select coalesce(max(generation), 0)::integer + 1 as next_generation
       from genio_one_application_api_credentials
      where tenant_id = $1 and application_id = $2 and kind = 'API_KEY'
        and resource_id is not distinct from $3 and capability_id is not distinct from $4`,
    [tenantId, applicationId, resourceId, capabilityId],
  )
  const generation = Number(result.rows[0]?.next_generation)
  if (!Number.isSafeInteger(generation) || generation < 1) throw new PlatformApiError("APPLICATION_CREDENTIAL_DATA_INVALID", 500)
  return generation
}

async function insertKey(transaction: SqlTransaction, input: {
  tenantId: string
  applicationId: string
  subjectId: string
  credentialId: string
  generation: number
  resourceId: string | null
  capabilityId: string | null
  displayName: string
  scopes: string[]
  expiresAt: number
  correlationId: string
  predecessorId?: string
  now: number
  hash: string
  prefix: string
}): Promise<ApplicationApiKeyCredential> {
  const result = await transaction.query<Row>(
    `insert into genio_one_application_api_credentials
       (tenant_id, credential_id, application_id, application_subject_id, resource_id,
        capability_id, generation, kind, state, display_name, scopes, api_key_hash,
        api_key_prefix, expires_at, operation_correlation_id, predecessor_credential_id,
        created_at, activated_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'API_KEY', 'ACTIVE', $8, $9::text::jsonb, $10,
             $11, to_timestamp($12), $13, $14, to_timestamp($15), to_timestamp($15))
     returning ${API_KEY_COLUMNS}`,
    [input.tenantId, input.credentialId, input.applicationId, input.subjectId, input.resourceId,
      input.capabilityId, input.generation, input.displayName, JSON.stringify(input.scopes), input.hash,
      input.prefix, input.expiresAt, input.correlationId, input.predecessorId ?? null, input.now],
  )
  if (!result.rows[0]) throw new PlatformApiError("APPLICATION_CREDENTIAL_DATA_INVALID", 500)
  return applicationApiKeyCredential(result.rows[0])
}

export function createPostgresApplicationApiKeyLifecycle(options: Options): Pick<ApplicationRegistry, "issueApiKeyCredential" | "authenticateApiKey"> & {
  rotate: ApplicationRegistry["rotateCredential"]
  revoke: ApplicationRegistry["revokeCredential"]
} {
  async function reconcile(transaction: SqlTransaction, tenantId: string, gatewayIds: readonly string[]) {
    for (const gatewayId of gatewayIds) {
      await options.releasePublisher!.reconcileInTransaction({ transaction, tenantId, gatewayId, issuedAt: options.now() })
    }
  }
  return {
    async issueApiKeyCredential({ tenantId, applicationId, value, issuerScopes }) {
      const at = options.now()
      const input = validateApplicationApiKeyInput(value, at)
      assertApplicationCredentialScopeCeiling(input.scopes, issuerScopes)
      if (input.resourceId && !options.releasePublisher) throw new PlatformApiError("APPLICATION_CREDENTIAL_RELEASE_PUBLISHER_UNAVAILABLE", 503)
      const credentialId = `application-credential-${options.idFactory()}`
      const material = createApplicationApiKeyMaterial()
      return options.sql.transaction(async transaction => {
        const selected = await transaction.query<Row>(
          `select application.subject_id, subject.kind, subject.suspended_at
             from genio_one_applications application
             join genio_one_subjects subject on subject.tenant_id = application.tenant_id and subject.subject_id = application.subject_id
            where application.tenant_id = $1 and application.application_id = $2
            for update of application, subject`,
          [tenantId, applicationId],
        )
        const application = selected.rows[0]
        if (!application) throw new PlatformApiError("APPLICATION_NOT_FOUND", 404)
        if (application.kind !== "APPLICATION" || application.suspended_at != null) throw new PlatformApiError("APPLICATION_SUBJECT_UNAVAILABLE", 403)
        await assertNewOperation(transaction, tenantId, applicationId, value.correlation_id)
        const subjectId = String(application.subject_id)
        const gatewayIds = input.resourceId ? await resourceGateways(transaction, {
          tenantId, applicationSubjectId: subjectId, resourceId: input.resourceId,
          capabilityId: input.capabilityId!, credentialId, now: at,
        }) : []
        await transaction.query(
          `update genio_one_application_api_credentials set state = 'REVOKED', revoked_at = to_timestamp($5)
            where tenant_id = $1 and application_id = $2 and kind = 'API_KEY'
              and resource_id is not distinct from $3 and capability_id is not distinct from $4
              and state in ('ACTIVE', 'RETIRED') and expires_at <= to_timestamp($5)`,
          [tenantId, applicationId, input.resourceId, input.capabilityId, at],
        )
        const active = await transaction.query<Row>(
          `select credential_id from genio_one_application_api_credentials
            where tenant_id = $1 and application_id = $2 and kind = 'API_KEY'
              and resource_id is not distinct from $3 and capability_id is not distinct from $4 and state = 'ACTIVE'
            for update`,
          [tenantId, applicationId, input.resourceId, input.capabilityId],
        )
        if (active.rows[0]) throw new PlatformApiError("APPLICATION_CREDENTIAL_ACTIVE", 409)
        const generation = await nextGeneration(transaction, tenantId, applicationId, input.resourceId, input.capabilityId)
        const credential = await insertKey(transaction, {
          tenantId, applicationId, subjectId, credentialId, generation, ...input,
          correlationId: value.correlation_id, now: at, hash: material.hash, prefix: material.prefix,
        })
        await reconcile(transaction, tenantId, gatewayIds)
        return delivered(credential, material.secret)
      })
    },
    async rotate({ tenantId, applicationId, credentialId, value, issuerScopes }) {
      const at = options.now()
      if (!Number.isSafeInteger(value.grace_period_seconds) || value.grace_period_seconds < 0 || value.grace_period_seconds > 86400) {
        throw new PlatformApiError("APPLICATION_CREDENTIAL_GRACE_PERIOD_INVALID", 422)
      }
      const successorId = `application-credential-${options.idFactory()}`
      const material = createApplicationApiKeyMaterial()
      return options.sql.transaction(async transaction => {
        const selected = await transaction.query<Row>(
          `select credential.*, subject.kind as subject_kind, subject.suspended_at
             from genio_one_application_api_credentials credential
             join genio_one_applications application on application.tenant_id = credential.tenant_id and application.application_id = credential.application_id and application.subject_id = credential.application_subject_id
             join genio_one_subjects subject on subject.tenant_id = credential.tenant_id and subject.subject_id = credential.application_subject_id
            where credential.tenant_id = $1 and credential.application_id = $2 and credential.credential_id = $3 and credential.kind = 'API_KEY'
            for update of credential, application, subject`,
          [tenantId, applicationId, credentialId],
        )
        const row = selected.rows[0]
        if (!row) throw new PlatformApiError("APPLICATION_CREDENTIAL_NOT_FOUND", 404)
        const current = applicationApiKeyCredential(row)
        assertApplicationCredentialScopeCeiling(current.scopes, issuerScopes)
        if (current.state !== "ACTIVE" || !applicationApiKeyIsUsable(current, at)) throw new PlatformApiError("APPLICATION_CREDENTIAL_NOT_ROTATABLE", 409)
        if (row.subject_kind !== "APPLICATION" || row.suspended_at != null) throw new PlatformApiError("APPLICATION_SUBJECT_UNAVAILABLE", 403)
        if (current.resource_id && !options.releasePublisher) throw new PlatformApiError("APPLICATION_CREDENTIAL_RELEASE_PUBLISHER_UNAVAILABLE", 503)
        await assertNewOperation(transaction, tenantId, applicationId, value.correlation_id)
        const gatewayIds = current.resource_id ? await resourceGateways(transaction, {
          tenantId, applicationSubjectId: current.application_subject_id, resourceId: current.resource_id,
          capabilityId: current.capability_id!, credentialId: successorId, now: at,
        }) : []
        await transaction.query(
          `update genio_one_application_api_credentials set state = 'REVOKED', revoked_at = to_timestamp($5)
            where tenant_id = $1 and application_id = $2 and kind = 'API_KEY'
              and resource_id is not distinct from $3 and capability_id is not distinct from $4 and state = 'RETIRED'`,
          [tenantId, applicationId, current.resource_id, current.capability_id, at],
        )
        await transaction.query(
          `update genio_one_application_api_credentials set state = 'RETIRED', valid_until = to_timestamp($4)
            where tenant_id = $1 and application_id = $2 and credential_id = $3 and state = 'ACTIVE'`,
          [tenantId, applicationId, credentialId, Math.min(at + value.grace_period_seconds, current.expires_at)],
        )
        const generation = await nextGeneration(transaction, tenantId, applicationId, current.resource_id, current.capability_id)
        const credential = await insertKey(transaction, {
          tenantId, applicationId, subjectId: current.application_subject_id, credentialId: successorId, generation,
          resourceId: current.resource_id, capabilityId: current.capability_id, displayName: current.display_name,
          scopes: current.scopes, expiresAt: current.expires_at, correlationId: value.correlation_id,
          predecessorId: credentialId, now: at, hash: material.hash, prefix: material.prefix,
        })
        await reconcile(transaction, tenantId, gatewayIds)
        return delivered(credential, material.secret)
      })
    },
    async revoke({ tenantId, applicationId, credentialId }) {
      return options.sql.transaction(async transaction => {
        const selected = await transaction.query<Row>(
          `select ${API_KEY_COLUMNS} from genio_one_application_api_credentials
            where tenant_id = $1 and application_id = $2 and credential_id = $3 and kind = 'API_KEY' for update`,
          [tenantId, applicationId, credentialId],
        )
        const row = selected.rows[0]
        if (!row) throw new PlatformApiError("APPLICATION_CREDENTIAL_NOT_FOUND", 404)
        const current = applicationApiKeyCredential(row)
        if (current.state === "REVOKED") return current
        if (current.resource_id && !options.releasePublisher) throw new PlatformApiError("APPLICATION_CREDENTIAL_RELEASE_PUBLISHER_UNAVAILABLE", 503)
        const gateways = current.resource_id ? await transaction.query<Row>(
          `select distinct gateway_id from genio_one_publications
            where tenant_id = $1 and resource_id = $2 and publication_state in ('PUBLISHED', 'DEPRECATED')
            order by gateway_id`,
          [tenantId, current.resource_id],
        ) : { rows: [] }
        const result = await transaction.query<Row>(
          `update genio_one_application_api_credentials set state = 'REVOKED', revoked_at = to_timestamp($4)
            where tenant_id = $1 and application_id = $2 and credential_id = $3 returning ${API_KEY_COLUMNS}`,
          [tenantId, applicationId, credentialId, options.now()],
        )
        await reconcile(transaction, tenantId, gateways.rows.map(publication => {
          if (typeof publication.gateway_id !== "string" || !publication.gateway_id) throw new PlatformApiError("APPLICATION_CREDENTIAL_DATA_INVALID", 500)
          return publication.gateway_id
        }))
        return applicationApiKeyCredential(result.rows[0]!)
      })
    },
    async authenticateApiKey({ tenantId, token }) {
      const hash = applicationApiKeyHash(token)
      if (!hash) return null
      const at = options.now()
      const selected = await options.sql.query<Row>(
        `select credential.* from genio_one_application_api_credentials credential
           join genio_one_applications application on application.tenant_id = credential.tenant_id and application.application_id = credential.application_id and application.subject_id = credential.application_subject_id
           join genio_one_subjects subject on subject.tenant_id = credential.tenant_id and subject.subject_id = credential.application_subject_id
          where credential.tenant_id = $1 and credential.api_key_hash = $2 and credential.kind = 'API_KEY'
            and credential.resource_id is null and credential.capability_id is null
            and credential.expires_at > to_timestamp($3) and credential.revoked_at is null
            and (credential.state = 'ACTIVE' or (credential.state = 'RETIRED' and credential.valid_until > to_timestamp($3)))
            and subject.kind = 'APPLICATION' and subject.suspended_at is null`,
        [tenantId, hash, at],
      )
      const row = selected.rows[0]
      if (!row) return null
      const credential = applicationApiKeyCredential(row)
      if (credential.resource_id !== null || credential.capability_id !== null || !applicationApiKeyIsUsable(credential, at)) return null
      try {
        validateApplicationApiKeyInput({ kind: 'API_KEY', correlation_id: credential.credential_id,
          display_name: credential.display_name, scopes: credential.scopes, expires_at: credential.expires_at }, at)
      } catch {
        return null
      }
      return { tenant_id: tenantId, subject_id: credential.application_subject_id, client_id: credential.credential_id,
        role: 'USER', organization_ids: [], scopes: [...credential.scopes] }
    },
  }
}
