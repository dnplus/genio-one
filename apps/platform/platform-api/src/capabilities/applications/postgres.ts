import { createHash } from "node:crypto"

import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type {
  Application,
  ApplicationApiCredential,
  ApplicationApiCredentialCreation,
} from "./contract"
import type { ApplicationOAuthClientProvisioner, ApplicationRegistry } from "./module"
import type { ResourceLifecycleReleasePublisher } from "../resources/module"

type Row = Record<string, unknown>

type PreparedOAuthCredential = {
  tenantId: string
  applicationId: string
  credentialId: string
  applicationSubjectId: string
  gatewayId: string
  clientId: string
  issuer: string
  audience: string
  scope: string
}

function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === "string" ? value : String(value ?? "")
}

function timestamp(row: Row): number {
  const value = row.created_at
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0
}

function optionalTimestamp(row: Row, key: string): number | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Number(value)
}

function application(row: Row): Application {
  return {
    tenant_id: text(row, "tenant_id"),
    application_id: text(row, "application_id"),
    subject_id: text(row, "subject_id"),
    display_name: text(row, "display_name"),
    owner_organization_id: text(row, "owner_organization_id"),
    registered_by: {
      subject_id: text(row, "registered_by_subject_id"),
      evidence_level: "VERIFIED",
    },
    created_at: timestamp(row),
  }
}

const COLUMNS = `tenant_id, application_id, subject_id, display_name,
  owner_organization_id, registered_by_subject_id, created_at`

const CREDENTIAL_COLUMNS = `credential_id, application_id, application_subject_id,
  resource_id, capability_id, generation, kind, oauth_client_id, oauth_issuer,
  oauth_audience, oauth_scope, identity_provider_id, external_subject_id,
  state, created_at, activated_at, valid_until, revoked_at`

const CREDENTIAL_JOIN_COLUMNS = `credential.credential_id, credential.application_id,
  credential.application_subject_id, credential.resource_id, credential.capability_id,
  credential.generation, credential.kind, credential.oauth_client_id,
  credential.oauth_issuer, credential.oauth_audience, credential.oauth_scope,
  credential.identity_provider_id, credential.external_subject_id, credential.state,
  credential.created_at, credential.activated_at, credential.valid_until, credential.revoked_at`

function credential(row: Row): ApplicationApiCredential {
  return {
    credential_id: text(row, "credential_id"),
    application_id: text(row, "application_id"),
    application_subject_id: text(row, "application_subject_id"),
    resource_id: text(row, "resource_id"),
    capability_id: text(row, "capability_id"),
    generation: Number(row.generation),
    kind: "OAUTH2",
    oauth_client_id: text(row, "oauth_client_id"),
    oauth_issuer: text(row, "oauth_issuer"),
    oauth_audience: text(row, "oauth_audience"),
    oauth_scope: text(row, "oauth_scope"),
    state: text(row, "state") as ApplicationApiCredential["state"],
    created_at: optionalTimestamp(row, "created_at") ?? 0,
    activated_at: optionalTimestamp(row, "activated_at"),
    valid_until: optionalTimestamp(row, "valid_until"),
    revoked_at: optionalTimestamp(row, "revoked_at"),
  }
}

function objectValue(value: unknown, code: string): Record<string, unknown> {
  let parsed = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new PlatformApiError(code, 500)
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PlatformApiError(code, 500)
  }
  return parsed as Record<string, unknown>
}

function oauthConfiguration(value: unknown): {
  issuer: string
  audience: string
  scope: string
} {
  const metadata = objectValue(value, "APPLICATION_RESOURCE_DATA_INVALID")
  const inbound = objectValue(metadata.inbound_security, "APPLICATION_RESOURCE_DATA_INVALID")
  if (inbound.type !== "OAUTH2") {
    throw new PlatformApiError("APPLICATION_OAUTH_RESOURCE_REQUIRED", 422)
  }
  const issuer = typeof inbound.issuer === "string" ? inbound.issuer.trim().replace(/\/$/, "") : ""
  const audience = typeof inbound.audience === "string" ? inbound.audience.trim() : ""
  const scope = typeof inbound.scope === "string" ? inbound.scope.trim() : ""
  if (!issuer || !audience || !scope) {
    throw new PlatformApiError("APPLICATION_RESOURCE_DATA_INVALID", 500)
  }
  return { issuer, audience, scope }
}

function applicationClientId(input: {
  tenantId: string
  credentialId: string
}): string {
  const digest = createHash("sha256")
    .update(`${input.tenantId}\u0000${input.credentialId}`)
    .digest("hex")
    .slice(0, 32)
  return `genio-app-${digest}`
}

export function createPostgresApplicationRegistry(options: {
  sql: SqlAdapter
  idFactory?: () => string
  oauthProvisioner?: ApplicationOAuthClientProvisioner
  releasePublisher?: ResourceLifecycleReleasePublisher
  now?: () => number
}): ApplicationRegistry {
  const idFactory = options.idFactory ?? (() => crypto.randomUUID())
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  async function markProvisioningRevoked(prepared: PreparedOAuthCredential): Promise<void> {
    await options.sql.query(
      `update genio_one_application_api_credentials
          set state = 'REVOKED', revoked_at = now()
        where tenant_id = $1 and credential_id = $2 and state = 'PROVISIONING'`,
      [prepared.tenantId, prepared.credentialId],
    )
  }
  async function provisionAndActivate(
    prepared: PreparedOAuthCredential,
    beforeActivation?: (
      transaction: SqlTransaction,
      provisioned: Awaited<ReturnType<ApplicationOAuthClientProvisioner["provision"]>>,
    ) => Promise<void>,
  ): Promise<ApplicationApiCredentialCreation> {
    let provisioned: Awaited<ReturnType<ApplicationOAuthClientProvisioner["provision"]>>
    try {
      provisioned = await options.oauthProvisioner!.provision({
        tenantId: prepared.tenantId,
        applicationId: prepared.applicationId,
        applicationSubjectId: prepared.applicationSubjectId,
        credentialId: prepared.credentialId,
        clientId: prepared.clientId,
        issuer: prepared.issuer,
        audience: prepared.audience,
        scope: prepared.scope,
      })
    } catch (error) {
      await options.oauthProvisioner!.revoke({ clientId: prepared.clientId }).catch(() => undefined)
      await markProvisioningRevoked(prepared)
      throw error
    }
    try {
      const activated = await options.sql.transaction(async (transaction) => {
        await transaction.query(
          `insert into genio_one_external_identity_bindings
             (tenant_id, provider_id, external_subject_id, subject_id)
           values ($1, $2, $3, $4)
           on conflict (tenant_id, provider_id, external_subject_id) do nothing`,
          [
            prepared.tenantId,
            provisioned.identityProviderId,
            provisioned.externalSubjectId,
            prepared.applicationSubjectId,
          ],
        )
        const binding = await transaction.query<Row>(
          `select subject_id from genio_one_external_identity_bindings
            where tenant_id = $1 and provider_id = $2 and external_subject_id = $3`,
          [prepared.tenantId, provisioned.identityProviderId, provisioned.externalSubjectId],
        )
        if (binding.rows[0]?.subject_id !== prepared.applicationSubjectId) {
          throw new PlatformApiError("APPLICATION_OAUTH_IDENTITY_CONFLICT", 409)
        }
        await beforeActivation?.(transaction, provisioned)
        const result = await transaction.query<Row>(
          `update genio_one_application_api_credentials
              set state = 'ACTIVE', activated_at = now(), oauth_client_id = $3,
                  oauth_issuer = $4, identity_provider_id = $5,
                  external_subject_id = $6
            where tenant_id = $1 and credential_id = $2 and state = 'PROVISIONING'
            returning ${CREDENTIAL_COLUMNS}`,
          [
            prepared.tenantId,
            prepared.credentialId,
            provisioned.clientId,
            provisioned.issuer,
            provisioned.identityProviderId,
            provisioned.externalSubjectId,
          ],
        )
        if (!result.rows[0]) {
          throw new PlatformApiError("APPLICATION_CREDENTIAL_STATE_CONFLICT", 409)
        }
        await options.releasePublisher!.reconcileInTransaction({
          transaction,
          tenantId: prepared.tenantId,
          gatewayId: prepared.gatewayId,
          issuedAt: now(),
        })
        return credential(result.rows[0])
      })
      return {
        credential: activated,
        api_key: null,
        oauth_client_secret: provisioned.clientSecret,
        oauth_token_endpoint: provisioned.tokenEndpoint,
        credential_delivery: "ONE_TIME",
      }
    } catch (error) {
      await options.oauthProvisioner!.revoke({ clientId: prepared.clientId }).catch(() => undefined)
      await markProvisioningRevoked(prepared)
      throw error
    }
  }
  return {
    async list({ tenantId }) {
      const result = await options.sql.query<Row>(
        `select ${COLUMNS} from genio_one_applications
          where tenant_id = $1
          order by display_name asc, application_id asc`,
        [tenantId],
      )
      return result.rows.map(application)
    },
    async register({ tenantId, registeredBySubjectId, value }) {
      const displayName = value.display_name.trim()
      if (!displayName) throw new PlatformApiError("APPLICATION_DISPLAY_NAME_REQUIRED", 422)
      const suffix = idFactory()
      const applicationId = `application-${suffix}`
      const subjectId = `application-subject-${suffix}`
      try {
        return await options.sql.transaction(async (transaction) => {
          await transaction.query(
            `insert into genio_one_subjects
               (tenant_id, subject_id, kind, display_name)
             values ($1, $2, 'APPLICATION', $3)`,
            [tenantId, subjectId, displayName],
          )
          await transaction.query(
            `insert into genio_one_subject_roles (tenant_id, subject_id, role)
             values ($1, $2, 'USER')`,
            [tenantId, subjectId],
          )
          const result = await transaction.query<Row>(
            `insert into genio_one_applications
               (tenant_id, application_id, subject_id, display_name,
                owner_organization_id, registered_by_subject_id)
             values ($1, $2, $3, $4, $5, $6)
             returning ${COLUMNS}`,
            [
              tenantId,
              applicationId,
              subjectId,
              displayName,
              value.owner_organization_id,
              registeredBySubjectId,
            ],
          )
          return application(result.rows[0]!)
        })
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error) {
          if (error.code === "23503") throw new PlatformApiError("APPLICATION_OWNER_OR_SUBJECT_NOT_FOUND", 422)
          if (error.code === "23505") throw new PlatformApiError("APPLICATION_EXISTS", 409)
        }
        throw error
      }
    },
    async listCredentials({ tenantId, applicationId }) {
      const result = await options.sql.query<Row>(
        `select ${CREDENTIAL_COLUMNS}
           from genio_one_application_api_credentials
          where tenant_id = $1 and application_id = $2
          order by generation desc, created_at desc, credential_id desc`,
        [tenantId, applicationId],
      )
      return result.rows.map(credential)
    },
    async issueOAuthCredential({ tenantId, applicationId, value }) {
      if (!options.oauthProvisioner) {
        throw new PlatformApiError("APPLICATION_CREDENTIAL_PROVISIONER_UNAVAILABLE", 503)
      }
      if (!options.releasePublisher) {
        throw new PlatformApiError("APPLICATION_CREDENTIAL_RELEASE_PUBLISHER_UNAVAILABLE", 503)
      }
      const prepared = await options.sql.transaction(async (transaction) => {
        const eligible = await transaction.query<Row>(
          `select application.subject_id as application_subject_id,
                  resource.api_metadata,
                  publication.gateway_id
             from genio_one_applications application
             join genio_one_resources resource
               on resource.tenant_id = application.tenant_id
              and resource.resource_id = $3
             join genio_one_publications publication
               on publication.tenant_id = resource.tenant_id
              and publication.resource_id = resource.resource_id
              and publication.publication_state in ('PUBLISHED', 'DEPRECATED')
            where application.tenant_id = $1
              and application.application_id = $2
              and resource.kind = 'API'
              and resource.lifecycle in ('PUBLISHED', 'DEPRECATED')
              and resource.capabilities @> jsonb_build_array(jsonb_build_object('capability_id', $4::text))
              and exists (
                select 1 from genio_one_model_entitlements entitlement
                 where entitlement.tenant_id = application.tenant_id
                   and entitlement.subject_id = application.subject_id
                   and entitlement.resource_id = resource.resource_id
                   and entitlement.capability_id = $4
                   and entitlement.state = 'ACTIVE'
                   and entitlement.starts_at <= now()
                   and (entitlement.expires_at is null or entitlement.expires_at > now())
              )
            order by publication.endpoint_revision desc
            limit 1
            for update of application, resource, publication`,
          [tenantId, applicationId, value.resource_id, value.capability_id],
        )
        const row = eligible.rows[0]
        if (!row) throw new PlatformApiError("APPLICATION_CREDENTIAL_NOT_ENTITLED", 403)
        const active = await transaction.query<Row>(
          `select credential_id
             from genio_one_application_api_credentials
            where tenant_id = $1 and application_id = $2
              and resource_id = $3 and capability_id = $4 and state = 'ACTIVE'
            limit 1
            for update`,
          [tenantId, applicationId, value.resource_id, value.capability_id],
        )
        if (active.rows[0]) throw new PlatformApiError("APPLICATION_CREDENTIAL_ACTIVE", 409)
        const generationResult = await transaction.query<Row>(
          `select coalesce(max(generation), 0)::integer + 1 as next_generation
             from genio_one_application_api_credentials
            where tenant_id = $1 and application_id = $2
              and resource_id = $3 and capability_id = $4`,
          [tenantId, applicationId, value.resource_id, value.capability_id],
        )
        const configuration = oauthConfiguration(row.api_metadata)
        const credentialId = `application-credential-${idFactory()}`
        const clientId = applicationClientId({ tenantId, credentialId })
        const generation = Number(generationResult.rows[0]?.next_generation)
        if (!Number.isSafeInteger(generation) || generation < 1) {
          throw new PlatformApiError("APPLICATION_CREDENTIAL_DATA_INVALID", 500)
        }
        await transaction.query(
          `insert into genio_one_application_api_credentials
             (tenant_id, credential_id, application_id, application_subject_id,
              resource_id, capability_id, generation, kind, oauth_client_id,
              oauth_issuer, oauth_audience, oauth_scope, operation_correlation_id,
              state)
           values ($1, $2, $3, $4, $5, $6, $7, 'OAUTH2', $8, $9, $10, $11, $12,
                   'PROVISIONING')`,
          [
            tenantId,
            credentialId,
            applicationId,
            text(row, "application_subject_id"),
            value.resource_id,
            value.capability_id,
            generation,
            clientId,
            configuration.issuer,
            configuration.audience,
            configuration.scope,
            value.correlation_id,
          ],
        )
        return {
          tenantId,
          applicationId,
          credentialId,
          applicationSubjectId: text(row, "application_subject_id"),
          gatewayId: text(row, "gateway_id"),
          clientId,
          ...configuration,
        }
      })
      return provisionAndActivate(prepared)
    },
    async rotateCredential({ tenantId, applicationId, credentialId, value }) {
      if (!options.oauthProvisioner) {
        throw new PlatformApiError("APPLICATION_CREDENTIAL_PROVISIONER_UNAVAILABLE", 503)
      }
      if (!options.releasePublisher) {
        throw new PlatformApiError("APPLICATION_CREDENTIAL_RELEASE_PUBLISHER_UNAVAILABLE", 503)
      }
      const validUntil = now() + value.grace_period_seconds
      const prepared = await options.sql.transaction(async (transaction) => {
        const duplicate = await transaction.query<Row>(
          `select credential_id
             from genio_one_application_api_credentials
            where tenant_id = $1 and application_id = $2
              and operation_correlation_id = $3
            limit 1`,
          [tenantId, applicationId, value.correlation_id],
        )
        if (duplicate.rows[0]) {
          throw new PlatformApiError("APPLICATION_CREDENTIAL_SECRET_ALREADY_DELIVERED", 409)
        }
        const selected = await transaction.query<Row>(
          `select ${CREDENTIAL_JOIN_COLUMNS}, resource.api_metadata, publication.gateway_id
             from genio_one_application_api_credentials credential
             join genio_one_resources resource
               on resource.tenant_id = credential.tenant_id
              and resource.resource_id = credential.resource_id
             join lateral (
               select active.gateway_id
                 from genio_one_publications active
                where active.tenant_id = resource.tenant_id
                  and active.resource_id = resource.resource_id
                  and active.publication_state in ('PUBLISHED', 'DEPRECATED')
                order by active.endpoint_revision desc
                limit 1
             ) publication on true
            where credential.tenant_id = $1
              and credential.application_id = $2
              and credential.credential_id = $3
              and resource.kind = 'API'
              and resource.lifecycle in ('PUBLISHED', 'DEPRECATED')
              and exists (
                select 1 from genio_one_model_entitlements entitlement
                 where entitlement.tenant_id = credential.tenant_id
                   and entitlement.subject_id = credential.application_subject_id
                   and entitlement.resource_id = credential.resource_id
                   and entitlement.capability_id = credential.capability_id
                   and entitlement.state = 'ACTIVE'
                   and entitlement.starts_at <= now()
                   and (entitlement.expires_at is null or entitlement.expires_at > now())
              )
            for update of credential, resource`,
          [tenantId, applicationId, credentialId],
        )
        const current = selected.rows[0]
        if (!current) throw new PlatformApiError("APPLICATION_CREDENTIAL_NOT_ROTATABLE", 409)
        const predecessor = credential(current)
        if (predecessor.state !== "ACTIVE") {
          throw new PlatformApiError("APPLICATION_CREDENTIAL_STATE_CONFLICT", 409)
        }
        const generationResult = await transaction.query<Row>(
          `select coalesce(max(generation), 0)::integer + 1 as next_generation
             from genio_one_application_api_credentials
            where tenant_id = $1 and application_id = $2
              and resource_id = $3 and capability_id = $4`,
          [tenantId, applicationId, predecessor.resource_id, predecessor.capability_id],
        )
        const generation = Number(generationResult.rows[0]?.next_generation)
        if (!Number.isSafeInteger(generation) || generation <= predecessor.generation) {
          throw new PlatformApiError("APPLICATION_CREDENTIAL_DATA_INVALID", 500)
        }
        const configuration = oauthConfiguration(current.api_metadata)
        const successorCredentialId = `application-credential-${idFactory()}`
        const clientId = applicationClientId({ tenantId, credentialId: successorCredentialId })
        await transaction.query(
          `insert into genio_one_application_api_credentials
             (tenant_id, credential_id, application_id, application_subject_id,
              resource_id, capability_id, generation, kind, oauth_client_id,
              oauth_issuer, oauth_audience, oauth_scope,
              predecessor_credential_id, operation_correlation_id, state)
           values ($1, $2, $3, $4, $5, $6, $7, 'OAUTH2', $8, $9, $10, $11,
                   $12, $13, 'PROVISIONING')`,
          [
            tenantId,
            successorCredentialId,
            applicationId,
            predecessor.application_subject_id,
            predecessor.resource_id,
            predecessor.capability_id,
            generation,
            clientId,
            configuration.issuer,
            configuration.audience,
            configuration.scope,
            credentialId,
            value.correlation_id,
          ],
        )
        return {
          tenantId,
          applicationId,
          credentialId: successorCredentialId,
          applicationSubjectId: predecessor.application_subject_id,
          gatewayId: text(current, "gateway_id"),
          clientId,
          ...configuration,
        }
      })
      return provisionAndActivate(prepared, async (transaction) => {
        const retired = await transaction.query<Row>(
          `update genio_one_application_api_credentials
              set state = 'RETIRED', valid_until = to_timestamp($4)
            where tenant_id = $1 and application_id = $2
              and credential_id = $3 and state = 'ACTIVE'
            returning credential_id`,
          [tenantId, applicationId, credentialId, validUntil],
        )
        if (!retired.rows[0]) {
          throw new PlatformApiError("APPLICATION_CREDENTIAL_STATE_CONFLICT", 409)
        }
      })
    },
    async revokeCredential({ tenantId, applicationId, credentialId }) {
      if (!options.oauthProvisioner) {
        throw new PlatformApiError("APPLICATION_CREDENTIAL_PROVISIONER_UNAVAILABLE", 503)
      }
      if (!options.releasePublisher) {
        throw new PlatformApiError("APPLICATION_CREDENTIAL_RELEASE_PUBLISHER_UNAVAILABLE", 503)
      }
      const selected = await options.sql.query<Row>(
        `select ${CREDENTIAL_JOIN_COLUMNS}, publication.gateway_id
           from genio_one_application_api_credentials credential
           join genio_one_resources resource
             on resource.tenant_id = credential.tenant_id
            and resource.resource_id = credential.resource_id
           left join lateral (
             select active.gateway_id
               from genio_one_publications active
              where active.tenant_id = resource.tenant_id
                and active.resource_id = resource.resource_id
                and active.publication_state in ('PUBLISHED', 'DEPRECATED')
              order by active.endpoint_revision desc
              limit 1
           ) publication on true
          where credential.tenant_id = $1 and credential.application_id = $2
            and credential.credential_id = $3`,
        [tenantId, applicationId, credentialId],
      )
      const current = selected.rows[0]
      if (!current) throw new PlatformApiError("APPLICATION_CREDENTIAL_NOT_FOUND", 404)
      const mapped = credential(current)
      if (mapped.state === "REVOKED") return mapped
      await options.oauthProvisioner.revoke({ clientId: mapped.oauth_client_id })
      return options.sql.transaction(async (transaction) => {
        if (current.identity_provider_id && current.external_subject_id) {
          await transaction.query(
            `delete from genio_one_external_identity_bindings
              where tenant_id = $1 and provider_id = $2 and external_subject_id = $3
                and subject_id = $4`,
            [
              tenantId,
              current.identity_provider_id,
              current.external_subject_id,
              mapped.application_subject_id,
            ],
          )
        }
        const result = await transaction.query<Row>(
          `update genio_one_application_api_credentials
              set state = 'REVOKED', revoked_at = now()
            where tenant_id = $1 and application_id = $2 and credential_id = $3
            returning ${CREDENTIAL_COLUMNS}`,
          [tenantId, applicationId, credentialId],
        )
        const gatewayId = text(current, "gateway_id").trim()
        if (gatewayId) {
          await options.releasePublisher!.reconcileInTransaction({
            transaction,
            tenantId,
            gatewayId,
            issuedAt: now(),
          })
        }
        return credential(result.rows[0]!)
      })
    },
    async retireExpiredCredentials() {
      if (!options.oauthProvisioner) return 0
      const at = now()
      const selected = await options.sql.query<Row>(
        `select tenant_id, credential_id, application_subject_id, oauth_client_id,
                identity_provider_id, external_subject_id
           from genio_one_application_api_credentials
          where state = 'RETIRED' and valid_until <= to_timestamp($1)
            and identity_provider_id is not null and external_subject_id is not null
          order by valid_until, tenant_id, credential_id
          limit 100`,
        [at],
      )
      let retired = 0
      for (const candidate of selected.rows) {
        const clientId = text(candidate, "oauth_client_id")
        await options.oauthProvisioner.revoke({ clientId })
        const result = await options.sql.transaction(async (transaction) => {
          await transaction.query(
            `delete from genio_one_external_identity_bindings
              where tenant_id = $1 and provider_id = $2 and external_subject_id = $3
                and subject_id = $4`,
            [
              text(candidate, "tenant_id"),
              text(candidate, "identity_provider_id"),
              text(candidate, "external_subject_id"),
              text(candidate, "application_subject_id"),
            ],
          )
          return transaction.query<Row>(
            `update genio_one_application_api_credentials
                set identity_provider_id = null, external_subject_id = null
              where tenant_id = $1 and credential_id = $2 and state = 'RETIRED'
                and valid_until <= to_timestamp($3)
                and external_subject_id is not null
              returning credential_id`,
            [text(candidate, "tenant_id"), text(candidate, "credential_id"), at],
          )
        })
        if (result.rows[0]) retired += 1
      }
      return retired
    },
  }
}
