import type { ConnectionCertificate } from "../connections/contract"

export interface EnforcementConnectionReadiness {
  status: string
  lifecycle: string
  verification_state: string
  health_state: string
  certificate?: Pick<ConnectionCertificate, "status"> | null
}

export function isEnforcementConnectionReady(connection: EnforcementConnectionReadiness): boolean {
  const certificateStatus = connection.certificate?.status
  return connection.status === "READY" &&
    connection.lifecycle === "ENABLED" &&
    connection.verification_state === "VERIFIED" &&
    connection.health_state === "HEALTHY" &&
    (certificateStatus === undefined || ["NOT_CONFIGURED", "VALID", "EXPIRING"].includes(certificateStatus))
}
