/**
 * Epic C: Bot detail「能力／工具」unified surface.
 *
 * Enterprise binding／catalog rows + Runtime discover rows share one list model.
 * Primary UI copy is human-readable (可用／需連線／需申請／無法使用／審批中);
 * AUTO_GRANT / DENIED / PEP / HTTP must never be the primary status or CTA label.
 *
 * No real Codex hook, constraint editor, E2B, or separate Runtime admin UI.
 */
import {
  CODEX_CORE_CAPABILITY_DEFS,
  type CodexCoreCapabilityDef,
} from "./codex-runtime-catalog"
import type { CatalogAddState } from "./bot-binding-add"
import { formatRuntimeTarget } from "./runtime-capability"
import {
  denialCopyFor,
  entitlementRequestCopy,
  humanDenialFor,
  pendingApprovalCopy,
} from "./bot-capability-deny-copy"
import type { RuntimePolicySnapshot } from "./runtime-policy-contract"

export type CapabilitySurfaceSource = "enterprise" | "runtime"

/** UX status — never expose raw AUTO_GRANT / DENIED as primary copy. */
export type CapabilitySurfaceStatus =
  | "available"
  | "connect_first"
  | "request"
  | "unavailable"
  | "pending"
  | "added"

export type RuntimeEffectiveDecision = "ALLOW" | "DENY"

export interface RuntimeExposePolicy {
  /** Capability ids allowed to expose. Empty = allow all not denied. */
  allow: string[]
  /** Capability ids denied; deny wins over allow. */
  deny: string[]
}

/** A-1 contract-reviewer draft: shell/fs/web_search allow, browser deny. */
export const DEFAULT_RUNTIME_EXPOSE_POLICY: RuntimeExposePolicy = {
  allow: ["shell.exec", "filesystem.read", "filesystem.write", "web_search.query"],
  deny: ["browser.open"],
}

export interface EnterpriseSurfaceInput {
  resourceId: string
  capabilityId: string
  resourceDisplayName: string
  capabilityDisplayName: string
  addState: CatalogAddState
  reason?: string | null
  binding?: { state: "INSTALLED" | "PENDING" | "DENIED" | "FAILED" } | null
}

export interface CapabilitySurfaceRow {
  key: string
  source: CapabilitySurfaceSource
  title: string
  subtitle: string
  status: CapabilitySurfaceStatus
  /** Human primary status — never AUTO_GRANT / DENIED. */
  statusLabel: string
  /** Human primary CTA — never AUTO_GRANT / DENIED. */
  ctaLabel: string
  ctaDisabled: boolean
  /** Runtime: effective expose; enterprise: usable-now projection. */
  effectiveAllow: boolean
  reasonCode?: string
  /** Present for runtime rows. */
  runtime?: {
    capabilityId: string
    kind: string
    target: string
    effective: RuntimeEffectiveDecision
  }
  /** Present for enterprise rows. */
  enterprise?: {
    resourceId: string
    capabilityId: string
    addState: CatalogAddState
  }
  /** UX P0: human explanation — never PEP / HTTP / enum. */
  userMessage?: string
  /** UX P0 denial category when not fully available. */
  denialKind?: "exposure" | "entitlement" | "connection" | "execution"
}

/** List-facing status vocabulary (UX P0). */
export const HUMAN_STATUS_LABELS = ["可用", "需連線", "需申請", "無法使用", "審批中"] as const

const FORBIDDEN_PRIMARY_TOKENS = [
  "AUTO_GRANT",
  "DENIED",
  "NEEDS_CONNECTION",
  "ENTITLED",
  "CONNECTED",
  "PEP",
  "HTTP",
  "runtime_expose_deny",
  "runtime_invoke_deny",
  "BOT_ACCESS_DENIED",
  "403",
  "401",
  "409",
] as const

export function statusLabelFor(status: CapabilitySurfaceStatus): string {
  switch (status) {
    case "available":
      return "可用"
    case "connect_first":
      return "需連線"
    case "request":
      return "需申請"
    case "unavailable":
      return "無法使用"
    case "pending":
      return "審批中"
    case "added":
      // Installed binding is usable — stay within the five-word vocabulary.
      return "可用"
  }
}

export function assertHumanPrimaryCopy(...labels: string[]): void {
  for (const label of labels) {
    for (const token of FORBIDDEN_PRIMARY_TOKENS) {
      if (/^\d{3}$/.test(token)) {
        if (new RegExp(`\\b${token}\\b`).test(label)) {
          throw new Error(`PRIMARY_COPY_LEAKS_${token}`)
        }
        continue
      }
      if (label.includes(token)) {
        throw new Error(`PRIMARY_COPY_LEAKS_${token}`)
      }
    }
  }
}

/**
 * Effective Runtime expose: deny wins; non-empty allow list is closed-world;
 * empty allow + empty deny → allow discovered (Epic C default open for native).
 */
export function resolveRuntimeEffectiveAllow(
  capabilityId: string,
  policy: RuntimeExposePolicy = DEFAULT_RUNTIME_EXPOSE_POLICY,
): RuntimeEffectiveDecision {
  const id = capabilityId.trim()
  if (!id) return "DENY"
  if (policy.deny.includes(id)) return "DENY"
  if (policy.allow.length > 0 && !policy.allow.includes(id)) return "DENY"
  return "ALLOW"
}

export function runtimeExposePolicyFromSnapshot(snapshot: RuntimePolicySnapshot | null): RuntimeExposePolicy {
  if (!snapshot) {
    return {
      allow: [],
      deny: [...snapshotCapabilityIds()],
    }
  }
  const exposed = new Map<string, RuntimeEffectiveDecision>()
  for (const decision of snapshot.decisions) {
    if (decision.action === "expose" || (decision.capability_id === "codex.subscription" && decision.action === "use" && !exposed.has(decision.capability_id))) {
      exposed.set(decision.capability_id, decision.decision)
    }
  }
  const allow = [...exposed.entries()]
    .filter(([, decision]) => decision === "ALLOW")
    .map(([capabilityId]) => capabilityId)
  const deny = snapshotCapabilityIds().filter((capabilityId) => exposed.get(capabilityId) !== "ALLOW")
  return { allow, deny }
}

function snapshotCapabilityIds(): string[] {
  return [
    "codex.subscription",
    ...CODEX_CORE_CAPABILITY_DEFS.map((definition) => definition.id),
  ]
}

export function mapEnterpriseToSurfaceStatus(
  input: Pick<EnterpriseSurfaceInput, "addState" | "binding">,
): CapabilitySurfaceStatus {
  const bindingState = input.binding?.state
  if (bindingState === "INSTALLED") return "added"
  if (bindingState === "PENDING") return "pending"
  if (bindingState === "DENIED" || bindingState === "FAILED") return "unavailable"
  switch (input.addState) {
    case "ENTITLED":
    case "AUTO_GRANT":
    case "CONNECTED":
      return "available"
    case "NEEDS_CONNECTION":
      return "connect_first"
    case "REQUEST":
      return "request"
    case "DENIED":
      return "unavailable"
  }
}

export function enterpriseCtaLabel(
  status: CapabilitySurfaceStatus,
  addState: CatalogAddState,
): { label: string; disabled: boolean } {
  switch (status) {
    case "added":
      return { label: "已加入", disabled: true }
    case "pending":
      return { label: "審批中", disabled: true }
    case "unavailable":
      return { label: "無法使用", disabled: true }
    case "connect_first":
      return { label: "連接", disabled: false }
    case "request":
      return { label: "申請", disabled: false }
    case "available":
      return {
        label: addState === "AUTO_GRANT" ? "加入" : "加入",
        disabled: false,
      }
  }
}

export function runtimeCtaLabel(effective: RuntimeEffectiveDecision): {
  label: string
  disabled: boolean
  status: CapabilitySurfaceStatus
} {
  if (effective === "ALLOW") {
    return { label: "已就緒", disabled: true, status: "available" }
  }
  return { label: "無法使用", disabled: true, status: "unavailable" }
}

export function buildEnterpriseSurfaceRow(input: EnterpriseSurfaceInput): CapabilitySurfaceRow {
  const status = mapEnterpriseToSurfaceStatus(input)
  const statusLabel = statusLabelFor(status)
  const cta = enterpriseCtaLabel(status, input.addState)
  assertHumanPrimaryCopy(statusLabel, cta.label)

  let userMessage: string | undefined
  let denialKind: CapabilitySurfaceRow["denialKind"]
  if (status === "connect_first") {
    const copy = denialCopyFor("connection")
    userMessage = copy.message
    denialKind = "connection"
  } else if (status === "request") {
    const copy = entitlementRequestCopy()
    userMessage = copy.message
    denialKind = "entitlement"
  } else if (status === "pending") {
    const copy = pendingApprovalCopy()
    userMessage = copy.message
    denialKind = "entitlement"
  } else if (status === "unavailable") {
    const copy =
      humanDenialFor({ reasonCode: input.reason, addState: input.addState, phase: "list" }) ??
      denialCopyFor("entitlement")
    userMessage = copy.message
    denialKind = copy.kind
  }

  if (userMessage) assertHumanPrimaryCopy(userMessage)

  return {
    key: `enterprise:${input.resourceId}:${input.capabilityId}`,
    source: "enterprise",
    title: input.resourceDisplayName || input.resourceId,
    subtitle: input.capabilityDisplayName || input.capabilityId,
    status,
    statusLabel,
    ctaLabel: cta.label,
    ctaDisabled: cta.disabled,
    effectiveAllow: status === "added" || status === "available",
    reasonCode: input.reason ?? undefined,
    userMessage,
    denialKind,
    enterprise: {
      resourceId: input.resourceId,
      capabilityId: input.capabilityId,
      addState: input.addState,
    },
  }
}

export function buildRuntimeSurfaceRow(
  def: Pick<CodexCoreCapabilityDef, "id" | "kind" | "display_name" | "description">,
  policy: RuntimeExposePolicy = DEFAULT_RUNTIME_EXPOSE_POLICY,
  runtimeId = "codex",
): CapabilitySurfaceRow {
  const effective = resolveRuntimeEffectiveAllow(def.id, policy)
  const cta = runtimeCtaLabel(effective)
  const statusLabel = statusLabelFor(cta.status)
  assertHumanPrimaryCopy(statusLabel, cta.label)
  const target = formatRuntimeTarget(runtimeId, def.id)
  const exposureDeny = effective === "DENY" ? denialCopyFor("exposure") : null
  if (exposureDeny) assertHumanPrimaryCopy(exposureDeny.message)
  return {
    key: `runtime:${runtimeId}:${def.id}`,
    source: "runtime",
    title: def.display_name,
    subtitle: def.description,
    status: cta.status,
    statusLabel,
    ctaLabel: cta.label,
    ctaDisabled: cta.disabled,
    effectiveAllow: effective === "ALLOW",
    // Internal reasonCode kept for tests／audit — never rendered as primary UI copy.
    reasonCode: effective === "DENY" ? "runtime_expose_deny" : "runtime_expose_allow",
    userMessage: exposureDeny?.message,
    denialKind: exposureDeny ? "exposure" : undefined,
    runtime: {
      capabilityId: def.id,
      kind: def.kind,
      target,
      effective,
    },
  }
}

export function buildCapabilitySurface(options: {
  enterprise?: EnterpriseSurfaceInput[]
  runtimeDefs?: readonly CodexCoreCapabilityDef[]
  runtimePolicy?: RuntimeExposePolicy
  runtimeId?: string
}): CapabilitySurfaceRow[] {
  const enterpriseRows = (options.enterprise ?? []).map(buildEnterpriseSurfaceRow)
  const defs = options.runtimeDefs ?? CODEX_CORE_CAPABILITY_DEFS
  const runtimeRows = defs.map((def) =>
    buildRuntimeSurfaceRow(def, options.runtimePolicy ?? DEFAULT_RUNTIME_EXPOSE_POLICY, options.runtimeId ?? "codex"),
  )
  // Same list: Runtime first (native), then enterprise catalog／bindings.
  return [...runtimeRows, ...enterpriseRows]
}

export function listRuntimeSurfaceRows(
  policy: RuntimeExposePolicy = DEFAULT_RUNTIME_EXPOSE_POLICY,
): CapabilitySurfaceRow[] {
  return buildCapabilitySurface({ runtimePolicy: policy, enterprise: [] })
}
