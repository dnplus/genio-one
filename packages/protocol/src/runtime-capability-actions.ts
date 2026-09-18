export type CapabilityAction = "expose" | "invoke" | "load_extension" | "use" | "execute"

export function capabilityActions(capabilityId: string, resourceKind?: string): CapabilityAction[] {
  if (capabilityId === "codex.subscription" || capabilityId === "remote_hands.use") return ["expose", "use"]
  if (capabilityId === "shell.exec") return ["expose", "execute"]
  if (resourceKind === "EXTENSION") return ["expose", "load_extension"]
  return ["expose", "invoke"]
}
