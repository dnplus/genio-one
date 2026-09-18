import type {
  Application,
  ApplicationApiCredential,
  ApplicationApiCredentialCreation,
  IssueApplicationOAuthCredentialInput,
  RegisterApplicationInput,
  RotateApplicationCredentialInput,
} from "./contract"

export interface ApplicationOAuthClientProvisioner {
  provision(input: {
    tenantId: string
    applicationId: string
    applicationSubjectId: string
    credentialId: string
    clientId: string
    issuer: string
    audience: string
    scope: string
  }): Promise<{
    clientId: string
    clientSecret: string
    tokenEndpoint: string
    issuer: string
    externalSubjectId: string
    identityProviderId: string
  }>
  revoke(input: { clientId: string }): Promise<void>
}

export interface ApplicationRegistry {
  list(input: { tenantId: string }): Promise<Application[]>
  register(input: {
    tenantId: string
    registeredBySubjectId: string
    value: RegisterApplicationInput
  }): Promise<Application>
  listCredentials(input: {
    tenantId: string
    applicationId: string
  }): Promise<ApplicationApiCredential[]>
  issueOAuthCredential(input: {
    tenantId: string
    applicationId: string
    value: IssueApplicationOAuthCredentialInput
  }): Promise<ApplicationApiCredentialCreation>
  rotateCredential(input: {
    tenantId: string
    applicationId: string
    credentialId: string
    value: RotateApplicationCredentialInput
  }): Promise<ApplicationApiCredentialCreation>
  revokeCredential(input: {
    tenantId: string
    applicationId: string
    credentialId: string
    correlationId: string
  }): Promise<ApplicationApiCredential>
  retireExpiredCredentials(): Promise<number>
}
