import { PlatformApiError } from "../errors"
import type {
  EndpointEnforcement,
  EndpointHeartbeat,
  RegisteredEndpoint,
} from "./contract"

export function assertEndpointSubject(
  device: RegisteredEndpoint,
  subjectId: string,
  evidence: EndpointHeartbeat | EndpointEnforcement,
) {
  if (
    device.lifecycle_state === "REVOKED" ||
    device.subject_id !== subjectId ||
    evidence.evidence_level !== "VERIFIED" ||
    evidence.subject.evidence_level !== "VERIFIED" ||
    evidence.subject.subject_id !== subjectId
  ) {
    throw new PlatformApiError(
      device.lifecycle_state === "REVOKED" ? "DEVICE_REVOKED" : "ENDPOINT_SUBJECT_EVIDENCE_INVALID",
      403,
    )
  }
}

export function assertAppliedState(
  appliedStateRevision: string | null,
  appliedPolicyVersion: string | null,
  expected: { revision: string; policy_version: string },
) {
  if (
    !appliedStateRevision ||
    !appliedPolicyVersion ||
    appliedStateRevision !== expected.revision ||
    appliedPolicyVersion !== expected.policy_version
  ) {
    throw new PlatformApiError("ENDPOINT_DESIRED_STATE_NOT_APPLIED", 409)
  }
}

export function assertEndpointAcknowledged(
  device: RegisteredEndpoint,
  expected: { revision: string; policy_version: string },
  now: number,
  staleAfterSeconds: number,
) {
  assertAppliedState(
    device.observed_state.applied_state_revision,
    device.observed_state.applied_policy_version,
    expected,
  )
  if (now - device.last_seen_at >= staleAfterSeconds) {
    throw new PlatformApiError("ENDPOINT_HEARTBEAT_STALE", 409)
  }
}
