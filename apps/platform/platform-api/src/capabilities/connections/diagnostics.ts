import type { ConnectionRegistration } from "./contract"
import type { ConnectionVerifier } from "./module"
import type { ProviderCredentialProfileRevision } from "../provider-credentials/contract"
import { PlatformApiError } from "../errors"

export async function diagnoseConnection(input: {
  connection: ConnectionRegistration
  verifier?: ConnectionVerifier
  providerCredentialProfile?: ProviderCredentialProfileRevision
}) {
  if (!input.verifier) throw new PlatformApiError("CONNECTION_VERIFIER_UNAVAILABLE", 503)
  const started = Date.now()
  const certificateUsable = !["EXPIRED", "NOT_YET_VALID", "INVALID"].includes(input.connection.certificate?.status ?? "")
  let passed = false
  let diagnostic: { passed: boolean; reason_code: string; http_status: number | null } | null = null
  try {
    if (certificateUsable && input.verifier.diagnose) { diagnostic = await input.verifier.diagnose(input); passed = diagnostic.passed }
    else passed = certificateUsable && await input.verifier.verify(input)
  } catch {
    passed = false
  }
  return {
    connection_id: input.connection.connection_id,
    configuration_revision: input.connection.configuration_revision,
    checked_at: Math.floor(Date.now() / 1000),
    duration_ms: Date.now() - started,
    source: "CONTROL_PLANE" as const,
    passed,
    http_status: diagnostic?.http_status ?? null,
    check: input.connection.connection_kind === "MCP"
      ? !input.connection.connector_configuration && input.connection.downstream_identity.mode.startsWith("USER_") ? "PROTECTED_ENDPOINT" as const : "MCP_DISCOVERY" as const
      : input.connection.connection_kind === "API" ? "HTTP_REACHABILITY" as const : "PROVIDER_CONNECTIVITY" as const,
    reason_code: !certificateUsable ? "CONNECTION_CERTIFICATE_NOT_USABLE" : diagnostic?.reason_code ?? (passed ? "CONNECTION_TEST_PASSED" : "CONNECTION_TEST_FAILED"),
  }
}
