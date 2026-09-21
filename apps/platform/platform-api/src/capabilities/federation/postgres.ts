import { createHash } from "node:crypto"

import type { SqlAdapter } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type {
  CreateFederationTrustRevisionInput,
  FederationExchangeEvent,
  FederationTrustRevision,
} from "./contract"
import type {
  ApplicationTokenBroker,
  FederationService,
  VerifiedWorkloadAssertion,
  WorkloadAssertionVerifier,
} from "./module"

type Row = Record<string, unknown>

const TRUST_COLUMNS = `revision.tenant_id, revision.trust_id, revision.revision,
  revision.application_id, revision.application_subject_id, revision.display_name,
  revision.issuer, revision.jwks_uri, revision.audiences, revision.algorithms,
  revision.external_subject_id, revision.required_claims,
  revision.max_assertion_ttl_seconds, head.state,
  revision.created_by_subject_id, revision.created_at`

const EXCHANGE_COLUMNS = `tenant_id, exchange_id, correlation_id, trust_id,
  trust_revision, external_issuer, external_subject_id, application_id,
  application_subject_id, credential_id, credential_generation, resource_id,
  capability_id, audience, scope, outcome, rejection_reason,
  upstream_attempted, occurred_at`

function text(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || !value) throw new PlatformApiError("FEDERATION_DATA_INVALID", 500)
  return value
}

function integer(row: Row, key: string): number {
  const value = Number(row[key])
  if (!Number.isSafeInteger(value)) throw new PlatformApiError("FEDERATION_DATA_INVALID", 500)
  return value
}

function timestamp(row: Row, key: string): number {
  const value = row[key]
  const milliseconds = value instanceof Date ? value.getTime() : new Date(String(value)).getTime()
  if (!Number.isFinite(milliseconds)) throw new PlatformApiError("FEDERATION_DATA_INVALID", 500)
  return Math.floor(milliseconds / 1000)
}

function stringArray(row: Row, key: string): string[] {
  const value = row[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new PlatformApiError("FEDERATION_DATA_INVALID", 500)
  }
  return value
}

function requiredClaims(row: Row): Array<{ name: string; value: string }> {
  const value = typeof row.required_claims === "string"
    ? JSON.parse(row.required_claims)
    : row.required_claims
  if (
    !Array.isArray(value) ||
    value.some((item) =>
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      typeof (item as Row).name !== "string" ||
      typeof (item as Row).value !== "string"
    )
  ) throw new PlatformApiError("FEDERATION_DATA_INVALID", 500)
  return value as Array<{ name: string; value: string }>
}

function trust(row: Row): FederationTrustRevision {
  return {
    tenant_id: text(row, "tenant_id"),
    trust_id: text(row, "trust_id"),
    revision: integer(row, "revision"),
    application_id: text(row, "application_id"),
    application_subject_id: text(row, "application_subject_id"),
    display_name: text(row, "display_name"),
    issuer: text(row, "issuer"),
    jwks_uri: text(row, "jwks_uri"),
    audiences: stringArray(row, "audiences"),
    algorithms: stringArray(row, "algorithms") as FederationTrustRevision["algorithms"],
    external_subject_id: text(row, "external_subject_id"),
    required_claims: requiredClaims(row),
    max_assertion_ttl_seconds: integer(row, "max_assertion_ttl_seconds"),
    state: text(row, "state") as FederationTrustRevision["state"],
    created_by_subject_id: text(row, "created_by_subject_id"),
    created_at: timestamp(row, "created_at"),
  }
}

function exchangeEvent(row: Row): FederationExchangeEvent {
  return {
    tenant_id: text(row, "tenant_id"),
    exchange_id: text(row, "exchange_id"),
    correlation_id: text(row, "correlation_id"),
    trust_id: text(row, "trust_id"),
    trust_revision: integer(row, "trust_revision"),
    external_issuer: text(row, "external_issuer"),
    external_subject_id: row.external_subject_id === null ? null : text(row, "external_subject_id"),
    application_id: text(row, "application_id"),
    application_subject_id: text(row, "application_subject_id"),
    credential_id: row.credential_id === null ? null : text(row, "credential_id"),
    credential_generation: row.credential_generation === null ? null : integer(row, "credential_generation"),
    resource_id: text(row, "resource_id"),
    capability_id: text(row, "capability_id"),
    audience: text(row, "audience"),
    scope: text(row, "scope"),
    outcome: text(row, "outcome") as FederationExchangeEvent["outcome"],
    rejection_reason: row.rejection_reason === null ? null : text(row, "rejection_reason"),
    upstream_attempted: false,
    occurred_at: timestamp(row, "occurred_at"),
  }
}

function trustedUrl(value: string, field: string): string {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new PlatformApiError(`FEDERATION_${field}_INVALID`, 422)
  }
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || !url.hostname) {
    throw new PlatformApiError(`FEDERATION_${field}_INVALID`, 422)
  }
  return url.toString().replace(/\/$/, "")
}

export function normalizeTrust(value: CreateFederationTrustRevisionInput) {
  const rawAudiences = value.audiences
  const audLen = rawAudiences.length
  const audiences = new Array<string>(audLen)
  for (let i = 0; i < audLen; i++) {
    const trimmed = rawAudiences[i]!.trim()
    if (!trimmed) throw new PlatformApiError("FEDERATION_TRUST_DUPLICATE_SELECTOR", 422)
    audiences[i] = trimmed
  }
  if (audLen > 1) {
    audiences.sort()
    for (let i = 1; i < audLen; i++) {
      if (audiences[i] === audiences[i - 1]) throw new PlatformApiError("FEDERATION_TRUST_DUPLICATE_SELECTOR", 422)
    }
  }

  const rawAlgs = value.algorithms
  const algLen = rawAlgs.length
  const algorithms = new Array<string>(algLen) as FederationTrustRevision["algorithms"]
  for (let i = 0; i < algLen; i++) {
    algorithms[i] = rawAlgs[i]!
  }
  if (algLen > 1) {
    algorithms.sort()
    for (let i = 1; i < algLen; i++) {
      if (algorithms[i] === algorithms[i - 1]) throw new PlatformApiError("FEDERATION_TRUST_DUPLICATE_SELECTOR", 422)
    }
  }

  const rawClaims = value.required_claims
  const claimLen = rawClaims.length
  const required = new Array<{ name: string; value: string }>(claimLen)
  for (let i = 0; i < claimLen; i++) {
    const item = rawClaims[i]!
    required[i] = { name: item.name.trim(), value: item.value.trim() }
  }
  if (claimLen > 1) {
    required.sort((left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value))
    for (let i = 1; i < claimLen; i++) {
      if (required[i]!.name === required[i - 1]!.name) throw new PlatformApiError("FEDERATION_TRUST_DUPLICATE_SELECTOR", 422)
    }
  }

  return {
    displayName: value.display_name.trim(),
    issuer: trustedUrl(value.issuer, "ISSUER"),
    jwksUri: trustedUrl(value.jwks_uri, "JWKS_URI"),
    audiences,
    algorithms,
    externalSubjectId: value.external_subject_id.trim(),
    requiredClaims: required,
    maxAssertionTtlSeconds: value.max_assertion_ttl_seconds,
  }
}

function errorCode(error: unknown): string {
  return error instanceof PlatformApiError ? error.code : "FEDERATION_EXCHANGE_FAILED"
}

export function createPostgresFederationService(options: {
  sql: SqlAdapter
  verifier?: WorkloadAssertionVerifier
  tokenBroker?: ApplicationTokenBroker
  idFactory?: () => string
  now?: () => number
}): FederationService {
  const idFactory = options.idFactory ?? (() => crypto.randomUUID())
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))

  async function activeTrust(tenantId: string, trustId: string): Promise<FederationTrustRevision> {
    const result = await options.sql.query<Row>(
      `select ${TRUST_COLUMNS}
         from genio_one_federation_trust_heads head
         join genio_one_federation_trust_revisions revision
           on revision.tenant_id = head.tenant_id
          and revision.trust_id = head.trust_id
          and revision.revision = head.current_revision
        where head.tenant_id = $1 and head.trust_id = $2 and head.state = 'ACTIVE'`,
      [tenantId, trustId],
    )
    if (!result.rows[0]) throw new PlatformApiError("FEDERATION_TRUST_NOT_ACTIVE", 401)
    return trust(result.rows[0])
  }

  async function recordExchange(input: {
    trust: FederationTrustRevision
    value: Parameters<FederationService["exchange"]>[0]["value"]
    verified?: VerifiedWorkloadAssertion
    credential?: { credentialId: string; generation: number }
    outcome: "ISSUED" | "REJECTED"
    rejectionReason?: string
  }): Promise<void> {
    await options.sql.query(
      `insert into genio_one_federation_exchange_events
         (tenant_id, exchange_id, correlation_id, trust_id, trust_revision,
          external_issuer, external_subject_id, application_id,
          application_subject_id, credential_id, credential_generation,
          resource_id, capability_id, audience, scope, outcome, rejection_reason,
          upstream_attempted, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,false,to_timestamp($18))`,
      [
        input.trust.tenant_id,
        `federation-exchange-${idFactory()}`,
        input.value.correlation_id,
        input.trust.trust_id,
        input.trust.revision,
        input.trust.issuer,
        input.verified?.subject ?? null,
        input.trust.application_id,
        input.trust.application_subject_id,
        input.credential?.credentialId ?? null,
        input.credential?.generation ?? null,
        input.value.resource_id,
        input.value.capability_id,
        input.value.audience,
        input.value.scope,
        input.outcome,
        input.rejectionReason ?? null,
        now(),
      ],
    )
  }

  async function reserveAssertion(input: {
    trust: FederationTrustRevision
    verified: VerifiedWorkloadAssertion
    correlationId: string
  }): Promise<void> {
    const digest = createHash("sha256").update(input.verified.jti).digest("hex")
    try {
      await options.sql.query(
        `insert into genio_one_federation_assertion_uses
           (tenant_id, trust_id, trust_revision, assertion_jti_sha256,
            correlation_id, expires_at)
         values ($1,$2,$3,$4,$5,to_timestamp($6))`,
        [
          input.trust.tenant_id,
          input.trust.trust_id,
          input.trust.revision,
          digest,
          input.correlationId,
          input.verified.expires_at,
        ],
      )
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        const constraint = "constraint" in error ? error.constraint : undefined
        const duplicateCorrelation = constraint === "genio_one_federation_assertion_correlation_unique"
        throw new PlatformApiError(
          duplicateCorrelation ? "FEDERATION_EXCHANGE_ALREADY_RECORDED" : "FEDERATION_ASSERTION_REPLAYED",
          duplicateCorrelation ? 409 : 401,
        )
      }
      throw error
    }
  }

  return {
    async listTrusts({ tenantId, applicationId }) {
      const result = await options.sql.query<Row>(
        `select ${TRUST_COLUMNS}
           from genio_one_federation_trust_heads head
           join genio_one_federation_trust_revisions revision
             on revision.tenant_id = head.tenant_id
            and revision.trust_id = head.trust_id
            and revision.revision = head.current_revision
          where head.tenant_id = $1 and head.application_id = $2
          order by revision.display_name, revision.trust_id`,
        [tenantId, applicationId],
      )
      return result.rows.map(trust)
    },

    async createTrustRevision({ tenantId, applicationId, createdBySubjectId, value }) {
      const normalized = normalizeTrust(value)
      return options.sql.transaction(async (transaction) => {
        const application = await transaction.query<Row>(
          `select subject_id
             from genio_one_applications
            where tenant_id = $1 and application_id = $2
            for update`,
          [tenantId, applicationId],
        )
        if (!application.rows[0]) throw new PlatformApiError("APPLICATION_NOT_FOUND", 404)
        const trustId = value.trust_id ?? `federation-trust-${idFactory()}`
        const head = await transaction.query<Row>(
          `select application_id, current_revision
             from genio_one_federation_trust_heads
            where tenant_id = $1 and trust_id = $2
            for update`,
          [tenantId, trustId],
        )
        if (head.rows[0] && text(head.rows[0], "application_id") !== applicationId) {
          throw new PlatformApiError("FEDERATION_TRUST_APPLICATION_CONFLICT", 409)
        }
        const revision = head.rows[0] ? integer(head.rows[0], "current_revision") + 1 : 1
        const inserted = await transaction.query<Row>(
          `insert into genio_one_federation_trust_revisions
             (tenant_id, trust_id, revision, application_id, application_subject_id,
              display_name, issuer, jwks_uri, audiences, algorithms,
              external_subject_id, required_claims, max_assertion_ttl_seconds,
              created_by_subject_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::text[],$11,$12::text::jsonb,$13,$14)
           returning tenant_id, trust_id, revision, application_id,
             application_subject_id, display_name, issuer, jwks_uri, audiences,
             algorithms, external_subject_id, required_claims,
             max_assertion_ttl_seconds, created_by_subject_id, created_at`,
          [
            tenantId,
            trustId,
            revision,
            applicationId,
            text(application.rows[0], "subject_id"),
            normalized.displayName,
            normalized.issuer,
            normalized.jwksUri,
            normalized.audiences,
            normalized.algorithms,
            normalized.externalSubjectId,
            JSON.stringify(normalized.requiredClaims),
            normalized.maxAssertionTtlSeconds,
            createdBySubjectId,
          ],
        )
        await transaction.query(
          `insert into genio_one_federation_trust_heads
             (tenant_id, trust_id, application_id, current_revision, state)
           values ($1,$2,$3,$4,'ACTIVE')
           on conflict (tenant_id, trust_id) do update set
             current_revision = excluded.current_revision,
             state = 'ACTIVE', updated_at = now()`,
          [tenantId, trustId, applicationId, revision],
        )
        return trust({ ...inserted.rows[0]!, state: "ACTIVE" })
      })
    },

    async exchange({ tenantId, value }) {
      if (!options.verifier || !options.tokenBroker) {
        throw new PlatformApiError("FEDERATION_EXCHANGE_UNAVAILABLE", 503)
      }
      const duplicate = await options.sql.query<Row>(
        `select outcome, rejection_reason
           from genio_one_federation_exchange_events
          where tenant_id = $1 and correlation_id = $2`,
        [tenantId, value.correlation_id],
      )
      if (duplicate.rows[0]) throw new PlatformApiError("FEDERATION_EXCHANGE_ALREADY_RECORDED", 409)
      const selectedTrust = await activeTrust(tenantId, value.trust_id)
      let verified: VerifiedWorkloadAssertion | undefined
      try {
        verified = await options.verifier.verify({ token: value.subject_token, trust: selectedTrust, now: now() })
        await reserveAssertion({ trust: selectedTrust, verified, correlationId: value.correlation_id })
        const eligible = await options.sql.query<Row>(
          `select credential.credential_id, credential.generation,
                  credential.oauth_client_id, credential.oauth_audience,
                  credential.oauth_scope
             from genio_one_application_api_credentials credential
            where credential.tenant_id = $1
              and credential.application_id = $2
              and credential.application_subject_id = $3
              and credential.resource_id = $4
              and credential.capability_id = $5
              and credential.state = 'ACTIVE'
              and credential.oauth_audience = $6
              and credential.oauth_scope = $7
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
            order by credential.generation desc
            limit 1`,
          [
            tenantId,
            selectedTrust.application_id,
            selectedTrust.application_subject_id,
            value.resource_id,
            value.capability_id,
            value.audience,
            value.scope,
          ],
        )
        const credential = eligible.rows[0]
        if (!credential) throw new PlatformApiError("FEDERATION_EXCHANGE_NOT_AUTHORIZED", 403)
        const minted = await options.tokenBroker.mint({
          clientId: text(credential, "oauth_client_id"),
          scope: value.scope,
        })
        if (minted.expiresIn > verified.expires_at - now()) {
          throw new PlatformApiError("FEDERATION_ASSERTION_LIFETIME_TOO_SHORT", 401)
        }
        const credentialEvidence = {
          credentialId: text(credential, "credential_id"),
          generation: integer(credential, "generation"),
        }
        await recordExchange({
          trust: selectedTrust,
          value,
          verified,
          credential: credentialEvidence,
          outcome: "ISSUED",
        })
        return {
          access_token: minted.accessToken,
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: minted.tokenType,
          expires_in: minted.expiresIn,
          scope: minted.scope,
          application_subject_id: selectedTrust.application_subject_id,
          credential_generation: credentialEvidence.generation,
          exchange_correlation_id: value.correlation_id,
        }
      } catch (error) {
        await recordExchange({
          trust: selectedTrust,
          value,
          verified,
          outcome: "REJECTED",
          rejectionReason: errorCode(error),
        }).catch(() => undefined)
        throw error
      }
    },

    async listExchangeEvents({ tenantId, applicationId }) {
      const result = await options.sql.query<Row>(
        `select ${EXCHANGE_COLUMNS}
           from genio_one_federation_exchange_events
          where tenant_id = $1 and application_id = $2
          order by occurred_at desc, exchange_id desc
          limit 500`,
        [tenantId, applicationId],
      )
      return result.rows.map(exchangeEvent)
    },
  }
}
