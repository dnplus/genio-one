export const RUNTIME_POLICY_ACTIONS = [
  "expose",
  "invoke",
  "load_extension",
  "use",
  "execute",
] as const

export type RuntimePolicyAction = (typeof RUNTIME_POLICY_ACTIONS)[number]

export const RUNTIME_CAPABILITY_REGISTRY = {
  "codex.subscription": ["expose", "use"],
  "model.invoke": ["expose", "invoke"],
  "shell.exec": ["expose", "execute"],
  "filesystem.read": ["expose", "invoke"],
  "filesystem.write": ["expose", "invoke"],
  "browser.open": ["expose"],
  "web_search.query": ["expose"],
  "mcp.invoke": ["expose", "invoke"],
  "remote_hands.use": ["expose", "use"],
  "computer.use": ["expose", "invoke"],
} as const satisfies Record<string, readonly RuntimePolicyAction[]>

export type RuntimeCapabilityId = keyof typeof RUNTIME_CAPABILITY_REGISTRY
export type RuntimeCapabilityAction = (typeof RUNTIME_CAPABILITY_REGISTRY)[RuntimeCapabilityId][number]

export const RUNTIME_CAPABILITY_IDS = Object.freeze(Object.keys(RUNTIME_CAPABILITY_REGISTRY) as RuntimeCapabilityId[])

export function isRuntimeCapabilityId(value: unknown): value is RuntimeCapabilityId {
  return typeof value === "string" && Object.hasOwn(RUNTIME_CAPABILITY_REGISTRY, value)
}

export function runtimeCapabilityActions(capabilityId: string): readonly RuntimeCapabilityAction[] | null {
  if (!isRuntimeCapabilityId(capabilityId)) return null
  return RUNTIME_CAPABILITY_REGISTRY[capabilityId]
}

export function isRuntimeCapabilityAction(
  capabilityId: string,
  action: string,
): action is RuntimeCapabilityAction {
  return runtimeCapabilityActions(capabilityId)?.includes(action as RuntimeCapabilityAction) ?? false
}

export function defaultRuntimeCapabilityAction(capabilityId: string): RuntimeCapabilityAction | null {
  const actions = runtimeCapabilityActions(capabilityId)
  if (!actions) return null
  return actions.find((action) => action !== "expose") ?? actions[0] ?? null
}

export type CapabilityAction = RuntimePolicyAction

export function capabilityActions(capabilityId: string, resourceKind?: string): CapabilityAction[] {
  const registered = runtimeCapabilityActions(capabilityId)
  if (registered) return [...registered]
  if (resourceKind === "EXTENSION") return ["expose", "load_extension"]
  return ["expose", "invoke"]
}
