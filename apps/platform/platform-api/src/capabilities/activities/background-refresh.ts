import type { PostHogIntegrationStore } from "../posthog-integration/module"
import type { GatewayActivityMaterializer } from "./module"

const BACKGROUND_GATEWAY_ACTIVITY_REFRESH_INTERVAL_MILLIS = 20_000

export interface GatewayActivityBackgroundRefresh {
  refreshEnabledTenants(): Promise<void>
  stop(): void
}

export function createSingleFlightGatewayActivityMaterializer(
  materializer: GatewayActivityMaterializer,
): GatewayActivityMaterializer {
  const inFlightByTenant = new Map<string, Promise<void>>()

  return {
    refresh({ tenantId }) {
      const existing = inFlightByTenant.get(tenantId)
      if (existing) return existing

      const task = Promise.resolve().then(() => materializer.refresh({ tenantId }))
      inFlightByTenant.set(tenantId, task)
      void task.then(
        () => {
          if (inFlightByTenant.get(tenantId) === task) inFlightByTenant.delete(tenantId)
        },
        () => {
          if (inFlightByTenant.get(tenantId) === task) inFlightByTenant.delete(tenantId)
        },
      )
      return task
    },
  }
}

export function startGatewayActivityBackgroundRefresh(options: {
  materializer: GatewayActivityMaterializer
  integrations: Pick<PostHogIntegrationStore, "listEnabledTenantIds">
  reportFailure(input: { tenantId?: string; error: unknown }): void
}): GatewayActivityBackgroundRefresh {
  let stopped = false

  const reportFailure = (input: { tenantId?: string; error: unknown }) => {
    try {
      options.reportFailure(input)
    } catch {
      return
    }
  }

  const refreshEnabledTenants = async () => {
    if (stopped) return

    let tenantIds: string[]
    try {
      tenantIds = await options.integrations.listEnabledTenantIds()
    } catch (error) {
      reportFailure({ error })
      return
    }

    if (stopped) return
    await Promise.all([...new Set(tenantIds)].map(async (tenantId) => {
      try {
        await options.materializer.refresh({ tenantId })
      } catch (error) {
        reportFailure({ tenantId, error })
      }
    }))
  }

  void refreshEnabledTenants()
  const interval = setInterval(
    () => void refreshEnabledTenants(),
    BACKGROUND_GATEWAY_ACTIVITY_REFRESH_INTERVAL_MILLIS,
  )
  interval.unref()

  return {
    refreshEnabledTenants,
    stop() {
      stopped = true
      clearInterval(interval)
    },
  }
}
