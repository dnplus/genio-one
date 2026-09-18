/**
 * Epic A-1: Runtime Capability schema + target addressing + audit shapes.
 *
 * Separate from platform Resource (enterprise MCP/LLM/SaaS/API/EXTENSION).
 * Types + fixtures only — no real Codex hook, UI, E2B, or shell blocking.
 *
 * Placement: genio-one-bot/server (bot owns Codex-as-runtime surface;
 * platform Resource contracts live under platform-api and stay untouched).
 */

/** Native / adapter-discovered capability kinds (decision 4 core four + extensions). */
export const RUNTIME_CAPABILITY_KINDS = [
  "shell",
  "filesystem",
  "browser",
  "web_search",
  "mcp",
  "plugin",
  "skill",
  "remote_hands",
  "model",
  "sub_agent",
] as const

export type RuntimeCapabilityKind = (typeof RUNTIME_CAPABILITY_KINDS)[number]

/** Draft Runtime PEP actions (expose filter + exec + extension load). */
export const RUNTIME_ACTIONS = ["expose", "invoke", "load_extension"] as const
export type RuntimeAction = (typeof RUNTIME_ACTIONS)[number]

/** Audit event kinds for Runtime PEP (schema only in A-1). */
export const RUNTIME_AUDIT_KINDS = ["expose", "invoke", "denied"] as const
export type RuntimeAuditKind = (typeof RUNTIME_AUDIT_KINDS)[number]

export const RUNTIME_TARGET_PREFIX = "runtime:" as const

/**
 * Well-known Resource ids used in bot fixtures / gates — Runtime Capability
 * ids and targets must never collide with these (decision 2: data-layer split).
 */
export const KNOWN_RESOURCE_IDS = [
  "genio.personal-bot",
  "servicenow-csm",
  "jira",
  "secret-vault",
] as const

export interface RuntimeIdentity {
  /** Adapter / runtime product id, e.g. "codex", "e2b-desktop". */
  runtime_id: string
  /** Optional adapter implementation label. */
  adapter?: string
  /** Optional live session; capability catalog may omit. */
  session_id?: string | null
}

export interface RuntimeCapability {
  /** Capability id within the runtime namespace (not a Resource id). */
  id: string
  kind: RuntimeCapabilityKind
  runtime_identity: RuntimeIdentity
  display_name?: string
  description?: string
}

/** Addressing form: runtime:<runtime>:<capability> */
export type RuntimeTarget = `runtime:${string}:${string}`

export interface RuntimeConstraint {
  /** e.g. path_allowlist, command_deny, network_deny, approval_required */
  kind: string
  parameters: Record<string, unknown>
}

export interface RuntimeObligation {
  /** e.g. audit, redact, require_approval */
  kind: string
  enforcement_point_id?: string
  parameters: Record<string, unknown>
}

export type RuntimeAuditOutcome = "ALLOW" | "DENY"

export interface RuntimeAuditEvent {
  audit_event_id: string
  kind: RuntimeAuditKind
  action: RuntimeAction
  target: RuntimeTarget
  capability_id: string
  runtime_identity: RuntimeIdentity
  outcome: RuntimeAuditOutcome
  reason?: string
  principal?: {
    tenant_id: string
    subject_id: string
    acting_client_id?: string
  }
  constraints?: RuntimeConstraint[]
  obligations?: RuntimeObligation[]
  /** ISO-8601 timestamp */
  occurred_at: string
  correlation_id?: string
}

export function isRuntimeCapabilityKind(value: string): value is RuntimeCapabilityKind {
  return (RUNTIME_CAPABILITY_KINDS as readonly string[]).includes(value)
}

export function isRuntimeAction(value: string): value is RuntimeAction {
  return (RUNTIME_ACTIONS as readonly string[]).includes(value)
}

export function isRuntimeAuditKind(value: string): value is RuntimeAuditKind {
  return (RUNTIME_AUDIT_KINDS as readonly string[]).includes(value)
}

export function formatRuntimeTarget(runtimeId: string, capabilityId: string): RuntimeTarget {
  const runtime = runtimeId.trim()
  const capability = capabilityId.trim()
  if (!runtime) throw new Error("RUNTIME_TARGET_RUNTIME_EMPTY")
  if (!capability) throw new Error("RUNTIME_TARGET_CAPABILITY_EMPTY")
  if (runtime.includes(":")) throw new Error("RUNTIME_TARGET_RUNTIME_INVALID")
  if (capability.includes(":")) throw new Error("RUNTIME_TARGET_CAPABILITY_INVALID")
  return `runtime:${runtime}:${capability}`
}

export function parseRuntimeTarget(target: string): {
  runtime_id: string
  capability_id: string
} | null {
  const trimmed = target.trim()
  if (!trimmed.startsWith(RUNTIME_TARGET_PREFIX)) return null
  const rest = trimmed.slice(RUNTIME_TARGET_PREFIX.length)
  const sep = rest.indexOf(":")
  if (sep <= 0 || sep === rest.length - 1) return null
  const runtime_id = rest.slice(0, sep)
  const capability_id = rest.slice(sep + 1)
  if (!runtime_id || !capability_id || capability_id.includes(":")) return null
  return { runtime_id, capability_id }
}

export function isRuntimeTarget(value: string): value is RuntimeTarget {
  return parseRuntimeTarget(value) !== null
}

/** True when a candidate id looks like / equals a Resource id (must not share namespace). */
export function conflictsWithResourceId(
  candidate: string,
  resourceIds: readonly string[] = KNOWN_RESOURCE_IDS,
): boolean {
  const id = candidate.trim()
  if (!id) return false
  if (resourceIds.includes(id)) return true
  // Resource targets are never "runtime:…" — reject if someone uses resource-shaped addressing.
  if (id.startsWith("resource:")) return true
  return false
}

export function assertRuntimeCapabilityShape(capability: RuntimeCapability): void {
  if (!capability.id?.trim()) throw new Error("RUNTIME_CAPABILITY_ID_REQUIRED")
  if (!isRuntimeCapabilityKind(capability.kind)) throw new Error("RUNTIME_CAPABILITY_KIND_INVALID")
  if (!capability.runtime_identity?.runtime_id?.trim()) {
    throw new Error("RUNTIME_IDENTITY_RUNTIME_ID_REQUIRED")
  }
  if (conflictsWithResourceId(capability.id)) {
    throw new Error("RUNTIME_CAPABILITY_ID_COLLIDES_WITH_RESOURCE")
  }
  const target = formatRuntimeTarget(capability.runtime_identity.runtime_id, capability.id)
  if (conflictsWithResourceId(target)) {
    throw new Error("RUNTIME_TARGET_COLLIDES_WITH_RESOURCE")
  }
}

export function assertRuntimeAuditEventShape(event: RuntimeAuditEvent): void {
  if (!event.audit_event_id?.trim()) throw new Error("RUNTIME_AUDIT_ID_REQUIRED")
  if (!isRuntimeAuditKind(event.kind)) throw new Error("RUNTIME_AUDIT_KIND_INVALID")
  if (!isRuntimeAction(event.action)) throw new Error("RUNTIME_AUDIT_ACTION_INVALID")
  if (!isRuntimeTarget(event.target)) throw new Error("RUNTIME_AUDIT_TARGET_INVALID")
  if (!event.capability_id?.trim()) throw new Error("RUNTIME_AUDIT_CAPABILITY_REQUIRED")
  if (!event.runtime_identity?.runtime_id?.trim()) throw new Error("RUNTIME_AUDIT_RUNTIME_REQUIRED")
  if (event.outcome !== "ALLOW" && event.outcome !== "DENY") {
    throw new Error("RUNTIME_AUDIT_OUTCOME_INVALID")
  }
  if (!event.occurred_at?.trim()) throw new Error("RUNTIME_AUDIT_OCCURRED_AT_REQUIRED")
  if (conflictsWithResourceId(event.capability_id)) {
    throw new Error("RUNTIME_AUDIT_CAPABILITY_COLLIDES_WITH_RESOURCE")
  }
  const parsed = parseRuntimeTarget(event.target)
  if (!parsed || parsed.capability_id !== event.capability_id) {
    throw new Error("RUNTIME_AUDIT_TARGET_MISMATCH")
  }
}

export function targetForCapability(capability: RuntimeCapability): RuntimeTarget {
  assertRuntimeCapabilityShape(capability)
  return formatRuntimeTarget(capability.runtime_identity.runtime_id, capability.id)
}
