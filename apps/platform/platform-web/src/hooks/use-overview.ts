import { useCallback, useEffect, useRef, useState } from "react"

import type { IdentitySession, OverviewFailure, OverviewSnapshot } from "@/domain/contracts"
import { LatestRequestGate } from "@/lib/latest-request"
import { loadAuditEvents, loadOverview, ProductApiError } from "@/lib/product-api"
import { isMockMode } from "@/lib/runtime-mode"
import { createMockOverview } from "@/mocks/overview"

function auditFailure(error: unknown): OverviewFailure {
  return {
    source: "Audit",
    code: error instanceof Error ? error.message : "UNKNOWN_ERROR",
    ...(error instanceof ProductApiError ? { status: error.status } : {}),
  }
}

export function useOverview(tenantId: string, enabled = true, demoMode = isMockMode, role?: IdentitySession["role"]) {
  const [data, setData] = useState<OverviewSnapshot | null>(() => demoMode ? createMockOverview() : null)
  const [loading, setLoading] = useState(!demoMode)
  const [refreshing, setRefreshing] = useState(false)
  const requestGate = useRef(new LatestRequestGate())
  const normalizedTenantId = tenantId.trim()
  const canLoad = enabled && normalizedTenantId.length > 0

  const refresh = useCallback(async (scope: "all" | "audit" = "all") => {
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
      if (scope === "audit") {
        try {
          const auditEvents = await loadAuditEvents(normalizedTenantId)
          if (requestGate.current.isLatest(generation)) {
            setData(current => current
              ? {
                ...current,
                auditEvents,
                failures: current.failures.filter((failure) => failure.source !== "Audit"),
              }
              : current)
          }
        } catch (error) {
          if (requestGate.current.isLatest(generation)) {
            const failure = auditFailure(error)
            setData(current => current
              ? {
                ...current,
                failures: [...current.failures.filter((item) => item.source !== "Audit"), failure],
              }
              : current)
          }
        }
        return
      }
      const next = await loadOverview(normalizedTenantId, role)
      if (requestGate.current.isLatest(generation)) setData(next)
    } finally {
      if (requestGate.current.isLatest(generation)) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [canLoad, demoMode, normalizedTenantId, role])

  useEffect(() => {
    requestGate.current.begin()
    setData(demoMode ? createMockOverview() : null)
    setLoading(!demoMode && canLoad)
    setRefreshing(false)
  }, [canLoad, demoMode, normalizedTenantId, role])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { data, loading, refreshing, refresh }
}
