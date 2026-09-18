/**
 * UX P0: capability denial → human-readable copy only.
 *
 * Never surface PEP ids, HTTP status codes, or raw policy enums
 * (AUTO_GRANT / DENIED / NEEDS_CONNECTION / runtime_*_deny / BOT_*).
 *
 * Four denial kinds each have status + message + CTA for acceptance.
 */
import type { CapabilitySurfaceStatus } from "./bot-capability-surface"

/** User-facing denial categories (not protocol enums). */
export type CapabilityDenialKind =
  | "exposure"
  | "entitlement"
  | "connection"
  | "execution"

export interface CapabilityDenialCopy {
  kind: CapabilityDenialKind
  /** List status — one of 可用／需連線／需申請／無法使用／審批中 */
  status: CapabilitySurfaceStatus
  statusLabel: string
  /** Short human explanation — no PEP / HTTP / enum tokens. */
  message: string
  /** Primary CTA label. */
  ctaLabel: string
  ctaDisabled: boolean
  /** Optional next step hint for Connect card / request flow. */
  nextStep?: string
}

/** Tokens that must never appear in primary user-facing denial copy. */
export const FORBIDDEN_DENY_COPY_TOKENS = [
  "PEP",
  "HTTP",
  "AUTO_GRANT",
  "DENIED",
  "NEEDS_CONNECTION",
  "ENTITLED",
  "CONNECTED",
  "REQUEST",
  "runtime_expose_deny",
  "runtime_invoke_deny",
  "runtime_expose_allow",
  "runtime_invoke_allow",
  "BOT_ACCESS_DENIED",
  "BOT_BINDING",
  "BOT_CONNECTION",
  "agent-runtime-pep",
  "policy_denied",
  "no_entitlement",
  "403",
  "401",
  "409",
] as const

const KIND_COPY: Record<CapabilityDenialKind, CapabilityDenialCopy> = {
  exposure: {
    kind: "exposure",
    status: "unavailable",
    statusLabel: "無法使用",
    message: "此能力未對目前 Bot 開放，無法在列表中啟用。",
    ctaLabel: "無法使用",
    ctaDisabled: true,
    nextStep: "請改用已開放的能力，或向管理員申請開放範圍。",
  },
  entitlement: {
    kind: "entitlement",
    status: "unavailable",
    statusLabel: "無法使用",
    message: "尚未取得使用權限，無法直接加入此能力。",
    ctaLabel: "無法使用",
    ctaDisabled: true,
    nextStep: "若政策允許，可改走「需申請」流程。",
  },
  connection: {
    kind: "connection",
    status: "connect_first",
    statusLabel: "需連線",
    message: "此能力需要先完成帳號連線，才能加入與呼叫。",
    ctaLabel: "連接",
    ctaDisabled: false,
    nextStep: "開啟連接卡，完成 OAuth 或從企業目錄選取連線。",
  },
  execution: {
    kind: "execution",
    status: "unavailable",
    statusLabel: "無法使用",
    message: "目前無法執行此操作；執行前檢查未通過。",
    ctaLabel: "無法使用",
    ctaDisabled: true,
    nextStep: "確認能力已開放且已連線後再試。",
  },
}

/** Requestable entitlement (not hard deny) — separate from DENIED. */
export function entitlementRequestCopy(): CapabilityDenialCopy {
  return {
    kind: "entitlement",
    status: "request",
    statusLabel: "需申請",
    message: "尚未授權，但可以提出申請。",
    ctaLabel: "申請",
    ctaDisabled: false,
    nextStep: "送出申請後狀態會改為審批中。",
  }
}

export function pendingApprovalCopy(): CapabilityDenialCopy {
  return {
    kind: "entitlement",
    status: "pending",
    statusLabel: "審批中",
    message: "使用申請已送出，等待核准。",
    ctaLabel: "審批中",
    ctaDisabled: true,
  }
}

export function denialCopyFor(kind: CapabilityDenialKind): CapabilityDenialCopy {
  return { ...KIND_COPY[kind] }
}

/**
 * Map internal reason / add-state / runtime reason → denial kind.
 * Unknown → entitlement hard deny (safe default, no leak).
 */
export function resolveDenialKind(input: {
  reasonCode?: string | null
  addState?: string | null
  runtimeEffective?: "ALLOW" | "DENY" | null
  phase?: "expose" | "invoke" | "list" | null
}): CapabilityDenialKind | null {
  const reason = (input.reasonCode ?? "").trim().toLowerCase()
  const addState = (input.addState ?? "").trim().toUpperCase()
  const phase = input.phase ?? "list"

  // Positive / non-denial add states → not a denial.
  if (
    addState === "ENTITLED" ||
    addState === "AUTO_GRANT" ||
    addState === "CONNECTED" ||
    addState === "INSTALLED"
  ) {
    return null
  }

  if (addState === "NEEDS_CONNECTION") return "connection"
  if (addState === "REQUEST") return "entitlement"
  if (addState === "DENIED") return "entitlement"

  if (phase === "invoke" || reason.includes("invoke") || reason.includes("execution")) {
    return "execution"
  }
  if (
    input.runtimeEffective === "DENY" ||
    reason.includes("expose") ||
    reason === "runtime_expose_deny"
  ) {
    return "exposure"
  }
  if (reason.includes("needs_connection") || reason === "connection_required" || reason.includes("bot_connection")) {
    return "connection"
  }
  if (reason.includes("entitlement") || reason.includes("access") || reason.includes("denied")) {
    return "entitlement"
  }
  return null
}

export function humanDenialFor(input: {
  reasonCode?: string | null
  addState?: string | null
  runtimeEffective?: "ALLOW" | "DENY" | null
  phase?: "expose" | "invoke" | "list" | null
}): CapabilityDenialCopy | null {
  const addState = (input.addState ?? "").trim().toUpperCase()
  if (addState === "REQUEST") return entitlementRequestCopy()
  if (addState === "PENDING" || input.phase === "list" && addState === "") {
    /* fall through */
  }
  const kind = resolveDenialKind(input)
  if (!kind) return null
  if (kind === "entitlement" && addState === "REQUEST") return entitlementRequestCopy()
  return denialCopyFor(kind)
}

/** Assert primary user copy does not leak protocol tokens. */
export function assertNoProtocolLeak(...labels: string[]): void {
  for (const label of labels) {
    const upper = label.toUpperCase()
    for (const token of FORBIDDEN_DENY_COPY_TOKENS) {
      if (upper.includes(token.toUpperCase()) || label.includes(token)) {
        // Numeric HTTP codes: only flag when standalone-ish
        if (/^\d{3}$/.test(token)) {
          if (new RegExp(`\\b${token}\\b`).test(label)) {
            throw new Error(`DENY_COPY_LEAKS_${token}`)
          }
          continue
        }
        throw new Error(`DENY_COPY_LEAKS_${token}`)
      }
    }
  }
}

/**
 * Sanitize free-form API / error text into human feedback.
 * Strips known protocol tokens; falls back to generic message.
 */
export function sanitizeUserFacingError(raw: string, fallback = "操作未完成，請稍後再試。"): string {
  const text = (raw ?? "").trim()
  if (!text) return fallback
  try {
    assertNoProtocolLeak(text)
    return text
  } catch {
    // Map common codes without echoing them
    const lower = text.toLowerCase()
    if (lower.includes("connection") || lower.includes("oauth")) {
      return denialCopyFor("connection").message
    }
    if (lower.includes("invoke") || lower.includes("execution") || lower.includes("host_execution")) {
      return denialCopyFor("execution").message
    }
    if (lower.includes("expose") || lower.includes("pep")) {
      return denialCopyFor("exposure").message
    }
    if (lower.includes("denied") || lower.includes("entitlement") || lower.includes("access") || lower.includes("403")) {
      return denialCopyFor("entitlement").message
    }
    return fallback
  }
}

/** Acceptance fixture: all four kinds with human status + CTA. */
export function allDenialAcceptanceRows(): CapabilityDenialCopy[] {
  return [
    denialCopyFor("exposure"),
    denialCopyFor("entitlement"),
    denialCopyFor("connection"),
    denialCopyFor("execution"),
  ]
}
