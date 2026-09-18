import { createHash, randomBytes } from "node:crypto"
import type { Principal, PrincipalAuthenticator, PrincipalRole } from "./contract"
import { PlatformApiError } from "../errors"

export interface WorkloadIdentityClaimMapping {
  issuer: string
  audience: string
  subjectClaim?: string
  role?: PrincipalRole
}

export interface WorkloadIdentityExchangeInput {
  tenantId: string
  workloadToken: string
  provider: string
  requestedActingClientId?: string
}

export interface WorkloadIdentityExchangeResult {
  token_type: "Bearer"
  access_token: string
  expires_in: number
  scope: string
  subject_id: string
  acting_client_id: string
}

export interface WorkloadIdentityTokenRecord {
  tokenHash: string
  principal: Principal
  expiresAt: number
}

export interface WorkloadTokenVerifier {
  verify(token: string, provider: string): Promise<{
    issuer: string
    audience: string | string[]
    subject: string
    claims: Record<string, unknown>
  }>
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export class WorkloadIdentityStore {
  private readonly tokensByHash = new Map<string, WorkloadIdentityTokenRecord>()

  constructor(
    private readonly verifier?: WorkloadTokenVerifier,
    private readonly defaultTtlSeconds = 900
  ) {}

  async exchange(
    input: WorkloadIdentityExchangeInput
  ): Promise<WorkloadIdentityExchangeResult> {
    if (!input.tenantId || !input.tenantId.trim()) {
      throw new PlatformApiError("INVALID_ARGUMENT", 400, "tenantId is required")
    }
    if (!input.workloadToken || !input.workloadToken.trim()) {
      throw new PlatformApiError("INVALID_ARGUMENT", 400, "workloadToken is required")
    }

    let externalSubject = "workload-unknown"
    let issuer = input.provider

    if (this.verifier) {
      try {
        const payload = await this.verifier.verify(input.workloadToken, input.provider)
        externalSubject = payload.subject
        issuer = payload.issuer
      } catch (error) {
        throw new PlatformApiError(
          "WORKLOAD_IDENTITY_VERIFICATION_FAILED",
          401,
          error instanceof Error ? error.message : "Workload token verification failed"
        )
      }
    } else {
      const parts = input.workloadToken.split(".")
      if (parts.length === 3) {
        try {
          const payloadJson = Buffer.from(parts[1]!, "base64url").toString("utf8")
          const parsed = JSON.parse(payloadJson)
          if (parsed.sub) externalSubject = String(parsed.sub)
          if (parsed.iss) issuer = String(parsed.iss)
        } catch {
          throw new PlatformApiError("INVALID_WORKLOAD_TOKEN", 401, "Malformed JWT payload")
        }
      } else {
        throw new PlatformApiError("INVALID_WORKLOAD_TOKEN", 401, "JWT format required")
      }
    }

    const rawToken = `genio_acting_${randomBytes(24).toString("hex")}`
    const tokenHash = sha256Hex(rawToken)
    const nowSec = Math.floor(Date.now() / 1000)
    const expiresAt = nowSec + this.defaultTtlSeconds
    const actingClientId = input.requestedActingClientId?.trim() || `workload-${input.provider}`
    const subjectId = `workload:${externalSubject}`

    const principal: Principal = {
      tenant_id: input.tenantId.trim(),
      subject_id: subjectId,
      display_name: `Workload (${input.provider}:${externalSubject})`,
      role: "USER",
      organization_ids: [],
      client_id: actingClientId,
      scopes: ["genioone-invocation"],
      external_identity: {
        provider_id: issuer,
        external_subject_id: externalSubject,
      },
    }

    this.tokensByHash.set(tokenHash, {
      tokenHash,
      principal,
      expiresAt,
    })

    return {
      token_type: "Bearer",
      access_token: rawToken,
      expires_in: this.defaultTtlSeconds,
      scope: "genioone-invocation",
      subject_id: subjectId,
      acting_client_id: actingClientId,
    }
  }

  authenticate(token: string, tenantId: string): Principal | null {
    if (!token.startsWith("genio_acting_")) return null
    const tokenHash = sha256Hex(token)
    const record = this.tokensByHash.get(tokenHash)
    if (!record) return null

    const nowSec = Math.floor(Date.now() / 1000)
    if (nowSec >= record.expiresAt) {
      this.tokensByHash.delete(tokenHash)
      return null
    }

    if (record.principal.tenant_id !== tenantId) {
      return null
    }

    return {
      ...record.principal,
      organization_ids: [...record.principal.organization_ids],
      scopes: record.principal.scopes ? [...record.principal.scopes] : [],
    }
  }
}

export function createCompositePrincipalAuthenticator(
  primary: PrincipalAuthenticator,
  workloadStore: WorkloadIdentityStore
): PrincipalAuthenticator {
  return {
    async authenticate(input) {
      if (input.token.startsWith("genio_acting_")) {
        return workloadStore.authenticate(input.token, input.tenantId)
      }
      return primary.authenticate(input)
    },
  }
}
