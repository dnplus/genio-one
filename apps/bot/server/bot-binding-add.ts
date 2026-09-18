/**
 * Slice C: catalog-aware Add state machine for BotBinding projection.
 * Binding is NOT a second auth store — Gateway / One Policy still authorize each call.
 */

export type CatalogAddState =
  | "AUTO_GRANT"
  | "ENTITLED"
  | "REQUEST"
  | "NEEDS_CONNECTION"
  | "CONNECTED"
  | "DENIED"

export type CatalogConnectionStatus = "CONNECTED" | "AVAILABLE" | "NEEDS_CONNECTION"

export interface CatalogCapabilityView {
  builtin_service?: string | null
  resource_id?: string | null
  capability_id?: string | null
  access?: string | null
  hub_status?: string | null
  connection_status?: string | null
  /** Optional policy denial reason from catalog / One Policy */
  denial_reason?: string | null
  approval_policy_ref?: string | null
  skill_id?: string | null
}

export interface CatalogAddDecision {
  state: CatalogAddState
  connectionStatus: CatalogConnectionStatus
  /** May persist an INSTALLED BotBinding projection */
  installBinding: boolean
  /** May persist a PENDING binding while access request is open */
  pendingBinding: boolean
  /** Never true from catalog alone — calls still go through Gateway / One Policy */
  usableFromCatalogAlone: false
  reason: string
  approvalPolicyRef: string | null
  skillId: string | null
}

export function resolveConnectionStatus(cap: CatalogCapabilityView): CatalogConnectionStatus {
  const conn = String(cap.connection_status || "")
  const hub = String(cap.hub_status || "")
  if (conn === "READY") return "CONNECTED"
  if (conn === "UNAVAILABLE" || hub === "REQUEST_ACCESS" || hub === "PENDING_APPROVAL") {
    return "NEEDS_CONNECTION"
  }
  if (hub === "CONNECTED") return "CONNECTED"
  return "AVAILABLE"
}

/**
 * Resolve Add UI / server action state for one published capability.
 * No entitlement / unknown access → DENIED (never default-available).
 */
export function resolveCatalogAddState(cap: CatalogCapabilityView): CatalogAddDecision {
  const access = String(cap.access || "")
  const connectionStatus = resolveConnectionStatus(cap)
  const approvalPolicyRef = typeof cap.approval_policy_ref === "string" ? cap.approval_policy_ref : null
  const skillId = typeof cap.skill_id === "string" ? cap.skill_id : null
  const base = {
    connectionStatus,
    usableFromCatalogAlone: false as const,
    approvalPolicyRef,
    skillId,
  }

  if (access !== "ENTITLED" && access !== "AUTO_GRANT" && access !== "REQUEST") {
    return {
      ...base,
      state: "DENIED",
      installBinding: false,
      pendingBinding: false,
      reason: cap.denial_reason?.trim() || "no_entitlement",
    }
  }

  if (access === "REQUEST") {
    return {
      ...base,
      state: "REQUEST",
      installBinding: false,
      pendingBinding: true,
      reason: "access_request_required",
    }
  }

  if (connectionStatus === "NEEDS_CONNECTION") {
    return {
      ...base,
      state: "NEEDS_CONNECTION",
      installBinding: false,
      pendingBinding: false,
      reason: "connection_required",
    }
  }

  if (connectionStatus === "CONNECTED") {
    return {
      ...base,
      state: "CONNECTED",
      installBinding: true,
      pendingBinding: false,
      reason: "reuse_existing_connection",
    }
  }

  if (access === "ENTITLED") {
    return {
      ...base,
      state: "ENTITLED",
      installBinding: true,
      pendingBinding: false,
      reason: "already_entitled",
    }
  }

  return {
    ...base,
    state: "AUTO_GRANT",
    installBinding: true,
    pendingBinding: false,
    reason: "auto_grant_eligible",
  }
}

export function bindingStateForAdd(decision: CatalogAddDecision): "INSTALLED" | "PENDING" | "DENIED" | null {
  if (decision.installBinding) return "INSTALLED"
  if (decision.pendingBinding) return "PENDING"
  if (decision.state === "DENIED") return "DENIED"
  return null
}

/** Projection helper: INSTALLED binding is only usable while catalog still grants + connection ok. */
export function isInstalledBindingStillAuthorized(
  bindingState: string,
  cap: CatalogCapabilityView | null | undefined,
): boolean {
  if (bindingState !== "INSTALLED") return false
  if (!cap) return false
  const decision = resolveCatalogAddState(cap)
  return decision.installBinding
}
