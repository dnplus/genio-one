import { useCallback, useEffect, useRef, useState } from "react"

import type { OverviewSnapshot } from "@/domain/contracts"
import { LatestRequestGate } from "@/lib/latest-request"
import { loadOverview } from "@/lib/product-api"
import { isMockMode } from "@/lib/runtime-mode"
import { createMockOverview } from "@/mocks/overview"

export function useOverview(tenantId: string, enabled = true, demoMode = isMockMode) {
  const [data, setData] = useState<OverviewSnapshot | null>(() => demoMode ? createMockOverview() : null)
  const [loading, setLoading] = useState(!demoMode)
  const [refreshing, setRefreshing] = useState(false)
  const requestGate = useRef(new LatestRequestGate())
  const normalizedTenantId = tenantId.trim()
  const canLoad = enabled && normalizedTenantId.length > 0

  const refresh = useCallback(async () => {
    if (!canLoad) {
      setLoading(false)
      setRefreshing(false)
      return
    }
    if (demoMode) {
      setData(createMockOverview())
      setLoading(false)
      setRefreshing(false)
      return
    }
    const generation = requestGate.current.begin()
    setRefreshing(true)
    try {
      const next = await loadOverview(normalizedTenantId)
      if (requestGate.current.isLatest(generation)) setData(next)
    } finally {
      if (requestGate.current.isLatest(generation)) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [canLoad, demoMode, normalizedTenantId])

  useEffect(() => {
    requestGate.current.begin()
    setData(demoMode ? createMockOverview() : null)
    setLoading(!demoMode && canLoad)
    setRefreshing(false)
  }, [canLoad, demoMode, normalizedTenantId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { data, loading, refreshing, refresh }
}
