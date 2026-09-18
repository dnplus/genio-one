import type { RuntimeSession } from "./runtime-broker"
import { requireRuntimePolicyDecision } from "./runtime-policy"
import type { RuntimePolicyResolver, RuntimePolicySnapshot } from "./runtime-policy-contract"

export const NATIVE_RUNTIME_EXPOSURE_CAPABILITIES = [
  "shell.exec",
  "filesystem.read",
  "filesystem.write",
  "browser.open",
  "web_search.query",
] as const

export interface NativeRuntimeExposure {
  shell: boolean
  filesystemRead: boolean
  filesystemWrite: boolean
  browser: boolean
  webSearch: boolean
}

export interface NativeRuntimeEnvironment {
  hasRuntimeEnvironment: boolean
  hasDesktopRuntime: boolean
}

function allows(snapshot: RuntimePolicySnapshot, capabilityId: string): boolean {
  const decision = snapshot.decisions.find((candidate) => candidate.capability_id === capabilityId && candidate.action === "expose")
  if (!decision) return false
  try {
    requireRuntimePolicyDecision(decision)
    return true
  } catch {
    return false
  }
}

export async function readNativeRuntimeExposure(input: {
  runtimePolicy: RuntimePolicyResolver
  session: RuntimeSession
  botId: string
  accessToken?: string
}): Promise<NativeRuntimeExposure> {
  const snapshot = await input.runtimePolicy.read({
    principal: input.session.principal,
    botId: input.botId,
    runtimeId: "codex",
    capabilityIds: NATIVE_RUNTIME_EXPOSURE_CAPABILITIES,
    action: "expose",
    sessionId: input.session.id,
    ...(input.accessToken ? { accessToken: input.accessToken } : {}),
  })
  return {
    shell: allows(snapshot, "shell.exec"),
    filesystemRead: allows(snapshot, "filesystem.read"),
    filesystemWrite: allows(snapshot, "filesystem.write"),
    browser: allows(snapshot, "browser.open"),
    webSearch: allows(snapshot, "web_search.query"),
  }
}

export function nativeRuntimeConfig(
  exposure: NativeRuntimeExposure,
  environment: NativeRuntimeEnvironment,
): Record<string, unknown> {
  const shell = exposure.shell && exposure.filesystemRead && environment.hasRuntimeEnvironment
  const browser = exposure.browser && environment.hasDesktopRuntime
  return {
    "features.shell_tool": shell,
    "features.unified_exec": shell,
    "features.browser_use": browser,
    "features.browser_use_external": browser,
    "features.browser_use_full_cdp_access": browser,
    web_search: exposure.webSearch ? "live" : "disabled",
  }
}

export function nativeRuntimeSandboxMode(
  exposure: NativeRuntimeExposure,
  environment: NativeRuntimeEnvironment,
): { writable: boolean; hasExecution: boolean } {
  return {
    writable: environment.hasRuntimeEnvironment && exposure.filesystemWrite,
    hasExecution: environment.hasRuntimeEnvironment && exposure.shell && exposure.filesystemRead,
  }
}
