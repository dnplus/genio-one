import { useCallback, useEffect, useState } from "react"

import type { AccessTier } from "@/features/overview/platform-topology"

const demoPreferencesStorageKey = "genioone.demo"

interface DemoPreferences {
  version: 4
  tier: AccessTier
  guideVisible: boolean
}

function readDemoPreferences(): DemoPreferences {
  try {
    const stored = JSON.parse(window.localStorage.getItem(demoPreferencesStorageKey) ?? "null") as {
      version?: number
      tier?: AccessTier
      guideVisible?: boolean
    } | null
    if (stored?.version === 3 || stored?.version === 4) {
      return {
        version: 4,
        tier: stored.tier === "T2" ? "T2" : "T1",
        guideVisible: stored.guideVisible !== false,
      }
    }
  } catch {
    // Invalid local preferences are replaced with the supported schema.
  }
  return { version: 4, tier: "T1", guideVisible: true }
}

export function useDemoMode() {
  const [preferences, setPreferences] = useState(readDemoPreferences)

  useEffect(() => {
    window.localStorage.setItem(demoPreferencesStorageKey, JSON.stringify(preferences))
  }, [preferences])

  useEffect(() => {
    const syncPreferences = (event: StorageEvent) => {
      if (event.key === demoPreferencesStorageKey) setPreferences(readDemoPreferences())
    }
    window.addEventListener("storage", syncPreferences)
    return () => window.removeEventListener("storage", syncPreferences)
  }, [])

  const setTier = useCallback((tier: AccessTier) => {
    setPreferences((current) => ({ ...current, tier }))
  }, [])

  const setGuideVisible = useCallback((guideVisible: boolean) => {
    setPreferences((current) => ({ ...current, guideVisible }))
  }, [])

  return {
    tier: preferences.tier,
    guideVisible: preferences.guideVisible,
    setTier,
    setGuideVisible,
  }
}
