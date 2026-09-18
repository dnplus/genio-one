import type {
  CreateFederationTrustRevisionInput,
  FederationExchangeEvent,
  FederationTokenExchangeInput,
  FederationTokenExchangeResponse,
  FederationTrustRevision,
} from "./contract"

export interface VerifiedWorkloadAssertion {
  issuer: string
  subject: string
  issued_at: number
  expires_at: number
  jti: string
  claims: Readonly<Record<string, unknown>>
}

export interface WorkloadAssertionVerifier {
  verify(input: {
    token: string
    trust: FederationTrustRevision
    now: number
  }): Promise<VerifiedWorkloadAssertion>
}

export interface ApplicationTokenBroker {
  mint(input: {
    clientId: string
    scope: string
  }): Promise<{
    accessToken: string
    tokenType: "Bearer"
    expiresIn: number
    scope: string
  }>
}

export interface FederationService {
  listTrusts(input: { tenantId: string; applicationId: string }): Promise<FederationTrustRevision[]>
  createTrustRevision(input: {
    tenantId: string
    applicationId: string
    createdBySubjectId: string
    value: CreateFederationTrustRevisionInput
  }): Promise<FederationTrustRevision>
  exchange(input: {
    tenantId: string
    value: FederationTokenExchangeInput
  }): Promise<FederationTokenExchangeResponse>
  listExchangeEvents(input: {
    tenantId: string
    applicationId: string
  }): Promise<FederationExchangeEvent[]>
}
