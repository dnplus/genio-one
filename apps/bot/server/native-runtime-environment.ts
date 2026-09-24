import type { RuntimeSession } from "./runtime-broker"
import type { NativeRuntimeEnvironment } from "./native-runtime-policy"

export function canonicalRuntimeEnvironments(session: RuntimeSession, value: unknown, botId?: string) {
  if (value === undefined || value === null) return [] as Array<{ environmentId: string; cwd: string; runtimeWorkspaceRoots: string[] }>
  if (!Array.isArray(value)) throw new Error("RUNTIME_ENVIRONMENTS_INVALID")
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("RUNTIME_ENVIRONMENT_NOT_OWNED")
    const environmentId = (entry as { environmentId?: unknown }).environmentId
    const owned = ownedRuntimeEnvironment(session, environmentId, undefined, botId)
    if (!owned || !owned.environmentId) throw new Error("RUNTIME_ENVIRONMENT_NOT_OWNED")
    return {
      environmentId: owned.environmentId,
      cwd: owned.cwd,
      runtimeWorkspaceRoots: [owned.cwd],
    }
  })
}

export function ownedRuntimeEnvironment(session: RuntimeSession, environmentId: unknown, execServerUrl?: unknown, botId?: string | null) {
  if (typeof environmentId !== "string" || !environmentId.trim()) return null
  return Object.values(session.runtimeDetails).find((details) =>
    details.tier !== "none" &&
    details.execReady &&
    (!details.botId || details.botId === (botId ?? session.selectedBotId)) &&
    (!details.endpoint || (details.execReady && details.endpoint.botId === (botId ?? session.selectedBotId))) &&
    details.environmentId === environmentId &&
    (execServerUrl === undefined || details.execServerUrl === execServerUrl)
  ) ?? null
}

export function nativeRuntimeEnvironment(
  session: RuntimeSession,
  params: unknown,
  botId?: string,
): NativeRuntimeEnvironment {
  const record = params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : null
  const requested = record?.environments
  if (!Array.isArray(requested)) {
    return { hasRuntimeEnvironment: false, hasDesktopRuntime: false }
  }
  const owned = requested.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
    return ownedRuntimeEnvironment(session, (entry as { environmentId?: unknown }).environmentId, undefined, botId)
  })
  return {
    hasRuntimeEnvironment: requested.length > 0 && owned.length === requested.length && owned.every((environment) => environment?.tier !== "none" && environment?.execReady === true),
    hasDesktopRuntime: owned.some((environment) => environment?.tier === "desktop" && environment.execReady === true),
  }
}
