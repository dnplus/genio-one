import type {
  PostHogBrowserConfiguration,
  PostHogIntegration,
} from "./contract"
import { requirePostHogBinding, type PostHogIntegrationStore } from "./module"

function defaults(): PostHogIntegration {
  return {
    enabled: false,
    host: null,
    project_id: null,
    project_token: null,
    configured_by: null,
    configured_at: null,
  }
}

function browserConfiguration(value: PostHogIntegration): PostHogBrowserConfiguration | null {
  if (!value.enabled || !value.host || !value.project_id || !value.project_token) return null
  return {
    enabled: true,
    host: value.host,
    project_id: value.project_id,
    project_token: value.project_token,
  }
}

export function createInMemoryPostHogIntegrationStore(options: {
  now?: () => number
} = {}): PostHogIntegrationStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  const integrations = new Map<string, PostHogIntegration>()
  return {
    async get({ tenantId }) {
      return structuredClone(integrations.get(tenantId) ?? defaults())
    },
    async listEnabledTenantIds() {
      return [...integrations]
        .flatMap(([tenantId, integration]) => integration.enabled ? [tenantId] : [])
        .sort()
    },
    async update({ tenantId, configuredBySubjectId, value }) {
      requirePostHogBinding(value)
      const current = integrations.get(tenantId) ?? defaults()
      const next: PostHogIntegration = {
        enabled: value.enabled,
        host: value.host ?? current.host,
        project_id: value.project_id ?? current.project_id,
        project_token: value.project_token ?? current.project_token,
        configured_by: configuredBySubjectId,
        configured_at: now(),
      }
      integrations.set(tenantId, next)
      return structuredClone(next)
    },
    async browserConfiguration({ tenantId }) {
      return browserConfiguration(integrations.get(tenantId) ?? defaults())
    },
  }
}
