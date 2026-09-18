import type {
  EndpointDesiredState,
  EndpointCredential,
  EndpointBootstrap,
  RegisteredEndpoint,
  EndpointLifecycleEvent,
  EndpointEnforcement,
  EndpointEnrollment,
  EndpointHeartbeat,
  EndpointHeartbeatOutcome,
  EndpointRouteResolution,
  EnrollEndpoint,
} from "./contract"

export interface EndpointCredentialIdentity {
  credentialId: string
  tenantId: string
  deviceId: string
  subjectId: string
  kind: "BOOTSTRAP" | "RUNTIME"
  expiresAt: number
}

export interface EndpointRuntimeStore {
  bootstrap(input: { tenantId: string; subjectId: string; correlationId: string }): Promise<EndpointBootstrap>
  authenticateCredential(input: { tenantId: string; token: string }): Promise<EndpointCredentialIdentity>
  rotateCredential(input: { tenantId: string; deviceId: string; credentialId: string }): Promise<EndpointCredential>
  list(input: { tenantId: string }): Promise<RegisteredEndpoint[]>
  get(input: { tenantId: string; deviceId: string }): Promise<RegisteredEndpoint>
  lifecycleEvents(input: { tenantId: string; deviceId: string }): Promise<EndpointLifecycleEvent[]>
  revoke(input: {
    tenantId: string
    deviceId: string
    subjectId: string
    correlationId: string
    reason: string
  }): Promise<RegisteredEndpoint>
  assertApplied(input: {
    tenantId: string
    deviceId: string
    subjectId: string
    appliedStateRevision: string
    appliedPolicyVersion: string
  }): Promise<void>
  enroll(input: {
    credentialId: string
    tenantId: string
    subjectId: string
    value: EnrollEndpoint
  }): Promise<EndpointEnrollment>
  heartbeat(input: {
    tenantId: string
    deviceId: string
    subjectId: string
    value: EndpointHeartbeat
  }): Promise<EndpointHeartbeatOutcome>
  enforce(input: {
    tenantId: string
    deviceId: string
    subjectId: string
    value: EndpointEnforcement
  }): Promise<EndpointRouteResolution>
}

export interface EndpointRuntimeStoreOptions {
  desiredState?: EndpointDesiredState
  heartbeatIntervalSeconds?: number
  staleAfterSeconds?: number
  now?: () => number
}

export function endpointRuntimeConfiguration(options: EndpointRuntimeStoreOptions) {
  return {
    heartbeat_interval_seconds: options.heartbeatIntervalSeconds ?? 30,
    stale_after_seconds: options.staleAfterSeconds ?? 90,
    desired_state: options.desiredState ?? {
      revision: "endpoint-direct-v1",
      policy_version: "endpoint-direct-policy-v1",
      routing: { default_route: "DIRECT" as const, rules: [] },
    },
  }
}
