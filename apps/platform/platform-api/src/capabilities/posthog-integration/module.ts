import { PlatformApiError } from "../errors"
import type {
  PostHogBrowserConfiguration,
  PostHogIntegration,
  UpdatePostHogIntegration,
} from "./contract"

export interface PostHogIntegrationStore {
  get(input: { tenantId: string }): Promise<PostHogIntegration>
  listEnabledTenantIds(): Promise<string[]>
  update(input: {
    tenantId: string
    configuredBySubjectId: string
    value: UpdatePostHogIntegration
  }): Promise<PostHogIntegration>
  browserConfiguration(input: { tenantId: string }): Promise<PostHogBrowserConfiguration | null>
}

export function requirePostHogBinding(value: UpdatePostHogIntegration): void {
  const hasBinding = value.host !== undefined ||
    value.project_id !== undefined ||
    value.project_token !== undefined
  const hasCompleteBinding = value.host !== undefined &&
    value.project_id !== undefined &&
    value.project_token !== undefined
  if (value.enabled && !hasCompleteBinding) {
    throw new PlatformApiError("POSTHOG_BROWSER_CONFIGURATION_REQUIRED", 422)
  }
  if (!value.enabled && hasBinding && !hasCompleteBinding) {
    throw new PlatformApiError("POSTHOG_BROWSER_CONFIGURATION_REQUIRED", 422)
  }
}
