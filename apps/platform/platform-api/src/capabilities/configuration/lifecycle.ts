import { PlatformApiError } from "../errors"
import { assertLoginBranding } from "./branding"
import type { TenantConfiguration, TenantConfigurationRevision } from "./contract"
import type { ConfigurationTransition } from "./module"

export function assertTenantConfiguration(value: TenantConfiguration): void {
  const options = new Set(value.ttl_options_seconds)
  if (
    value.brand_name.trim() === "" || value.language.trim() === "" ||
    value.catalog_visibility.trim() === "" || value.approval_workflow_version.trim() === "" ||
    !options.has(value.request_form.default_ttl_seconds) ||
    options.size !== value.ttl_options_seconds.length ||
    new Set(value.request_form.required_fields).size !== value.request_form.required_fields.length
  ) {
    throw new PlatformApiError("TENANT_CONFIGURATION_INVALID", 422)
  }
  assertLoginBranding(value.login_branding)
}

export function transitionConfiguration(
  current: TenantConfigurationRevision,
  transition: ConfigurationTransition,
  at: number,
  failureReason?: string,
): TenantConfigurationRevision {
  if (current.state === "PUBLISHED") throw new PlatformApiError("CONFIGURATION_TRANSITION_INVALID", 409)
  const next = structuredClone(current)
  if (transition === "validate") {
    if (next.state !== "DRAFT") throw new PlatformApiError("CONFIGURATION_TRANSITION_INVALID", 409)
    assertTenantConfiguration(next.settings)
    next.state = "VALIDATED"
    next.validated_at = at
  } else if (transition === "preview") {
    if (next.state !== "VALIDATED") throw new PlatformApiError("CONFIGURATION_TRANSITION_INVALID", 409)
    next.previewed_at = at
  } else if (transition === "review") {
    if (next.state !== "VALIDATED" || next.previewed_at === null) {
      throw new PlatformApiError("CONFIGURATION_TRANSITION_INVALID", 409)
    }
    next.state = "REVIEWED"
    next.reviewed_at = at
  } else {
    if (next.state !== "REVIEWED") throw new PlatformApiError("CONFIGURATION_TRANSITION_INVALID", 409)
    next.state = "PUBLISHED"
    next.published_at = at
    next.projection.observed_revision = null
    next.projection.drift = true
    next.projection.last_reconciled_at = at
    const reason = failureReason?.trim()
    next.projection.status = reason ? "FAILED" : "PENDING"
    next.projection.last_error = reason || null
  }
  return next
}
