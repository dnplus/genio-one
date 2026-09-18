import { describe, expect, test } from "bun:test"

import {
  bindingStateForAdd,
  isInstalledBindingStillAuthorized,
  resolveCatalogAddState,
  resolveConnectionStatus,
} from "./bot-binding-add"

describe("slice C catalog Add state machine", () => {
  test("DENIED when no entitlement — never default-available", () => {
    const d = resolveCatalogAddState({ access: null, hub_status: "AVAILABLE", connection_status: "READY" })
    expect(d.state).toBe("DENIED")
    expect(d.installBinding).toBe(false)
    expect(d.usableFromCatalogAlone).toBe(false)
    expect(d.reason).toBe("no_entitlement")
    expect(bindingStateForAdd(d)).toBe("DENIED")
  })

  test("REQUEST → pending, not usable", () => {
    const d = resolveCatalogAddState({
      access: "REQUEST",
      hub_status: "AVAILABLE",
      connection_status: "READY",
      capability_id: "mcp-tool-x",
    })
    expect(d.state).toBe("REQUEST")
    expect(d.pendingBinding).toBe(true)
    expect(d.installBinding).toBe(false)
    expect(bindingStateForAdd(d)).toBe("PENDING")
  })

  test("NEEDS_CONNECTION when entitled but connection missing", () => {
    const d = resolveCatalogAddState({
      access: "ENTITLED",
      hub_status: "REQUEST_ACCESS",
      connection_status: "UNAVAILABLE",
    })
    expect(d.state).toBe("NEEDS_CONNECTION")
    expect(d.connectionStatus).toBe("NEEDS_CONNECTION")
    expect(d.installBinding).toBe(false)
    expect(bindingStateForAdd(d)).toBeNull()
  })

  test("CONNECTED reuses account connection and may install binding", () => {
    const d = resolveCatalogAddState({
      access: "AUTO_GRANT",
      hub_status: "CONNECTED",
      connection_status: "READY",
      approval_policy_ref: "policy/one-default",
      skill_id: "servicenow-csm",
    })
    expect(d.state).toBe("CONNECTED")
    expect(d.installBinding).toBe(true)
    expect(d.approvalPolicyRef).toBe("policy/one-default")
    expect(d.skillId).toBe("servicenow-csm")
    expect(bindingStateForAdd(d)).toBe("INSTALLED")
  })

  test("ENTITLED / AUTO_GRANT when connection available", () => {
    expect(resolveCatalogAddState({
      access: "ENTITLED",
      hub_status: "AVAILABLE",
      connection_status: "IDLE",
    }).state).toBe("ENTITLED")
    expect(resolveCatalogAddState({
      access: "AUTO_GRANT",
      hub_status: "AVAILABLE",
      connection_status: "IDLE",
    }).state).toBe("AUTO_GRANT")
  })

  test("connection status projection", () => {
    expect(resolveConnectionStatus({ connection_status: "READY" })).toBe("CONNECTED")
    expect(resolveConnectionStatus({ hub_status: "PENDING_APPROVAL" })).toBe("NEEDS_CONNECTION")
    expect(resolveConnectionStatus({ hub_status: "AVAILABLE" })).toBe("AVAILABLE")
  })

  test("INSTALLED binding is projection — revoked catalog makes it unusable", () => {
    expect(isInstalledBindingStillAuthorized("INSTALLED", {
      access: "ENTITLED",
      hub_status: "AVAILABLE",
      connection_status: "READY",
    })).toBe(true)
    expect(isInstalledBindingStillAuthorized("INSTALLED", { access: "DENIED" })).toBe(false)
    expect(isInstalledBindingStillAuthorized("PENDING", {
      access: "ENTITLED",
      hub_status: "AVAILABLE",
      connection_status: "READY",
    })).toBe(false)
    expect(isInstalledBindingStillAuthorized("INSTALLED", null)).toBe(false)
  })
})
