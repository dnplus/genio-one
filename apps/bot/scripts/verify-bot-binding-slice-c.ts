/**
 * Slice C verification: BotBinding projection + catalog Add state machine.
 * Run: bun apps/bot/scripts/verify-bot-binding-slice-c.ts
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  bindingStateForAdd,
  isInstalledBindingStillAuthorized,
  resolveCatalogAddState,
} from "../server/bot-binding-add"
import { BotRegistry } from "../server/bot-registry"
import type { GenioPrincipal } from "../server/runtime-broker"

const owner: GenioPrincipal = {
  tenant_id: "tenant-verify-slice-c",
  subject_id: "person-verify",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

const dir = mkdtempSync(join(tmpdir(), "slice-c-bot-binding-"))
const registry = new BotRegistry(join(dir, "registry.sqlite"), join(dir, "artifacts"))

try {
  const aqua = registry.create(owner, {
    name: "阿庫婭",
    title: "切片 C 驗證",
    description: "BotBinding + catalog Add；無 entitlement 不可用。",
  })
  if (aqua.bindings.length !== 0) throw new Error("new bot must start with zero bindings")

  const entitled = resolveCatalogAddState({
    access: "ENTITLED",
    hub_status: "AVAILABLE",
    connection_status: "IDLE",
    approval_policy_ref: "policy/one-default",
    skill_id: "servicenow-csm",
  })
  if (entitled.state !== "ENTITLED" || !entitled.installBinding) throw new Error("ENTITLED should install")
  const installed = registry.upsertBinding(aqua.id, owner, {
    resourceId: "servicenow-csm",
    capabilityId: "servicenow.csm.read_case",
    state: bindingStateForAdd(entitled)!,
    kind: "MCP",
    skillId: entitled.skillId,
    approvalPolicyRef: entitled.approvalPolicyRef,
    reason: entitled.reason,
  })
  if (installed.state !== "INSTALLED") throw new Error("expected INSTALLED projection")
  if (installed.approvalPolicyRef !== "policy/one-default") throw new Error("approval policy ref missing")

  const request = resolveCatalogAddState({ access: "REQUEST", hub_status: "AVAILABLE", connection_status: "READY" })
  if (request.state !== "REQUEST" || bindingStateForAdd(request) !== "PENDING") throw new Error("REQUEST pending")
  registry.upsertBinding(aqua.id, owner, {
    resourceId: "jira",
    capabilityId: "jira.issue.read",
    state: "PENDING",
    kind: "MCP",
    reason: request.reason,
  })

  const needs = resolveCatalogAddState({
    access: "AUTO_GRANT",
    hub_status: "REQUEST_ACCESS",
    connection_status: "UNAVAILABLE",
  })
  if (needs.state !== "NEEDS_CONNECTION" || bindingStateForAdd(needs) !== null) {
    throw new Error("NEEDS_CONNECTION must not install")
  }

  const connected = resolveCatalogAddState({
    access: "AUTO_GRANT",
    hub_status: "CONNECTED",
    connection_status: "READY",
  })
  if (connected.state !== "CONNECTED") throw new Error("expected CONNECTED")
  registry.upsertBinding(aqua.id, owner, {
    resourceId: "github",
    capabilityId: "github.pr.read",
    state: "INSTALLED",
    kind: "MCP",
    reason: connected.reason,
  })

  const denied = resolveCatalogAddState({ access: "DENIED", denial_reason: "policy_denied" })
  if (denied.state !== "DENIED") throw new Error("expected DENIED")
  if (resolveCatalogAddState({ access: null }).state !== "DENIED") {
    throw new Error("missing entitlement must be DENIED — never default-available")
  }

  if (isInstalledBindingStillAuthorized("INSTALLED", { access: "DENIED" })) {
    throw new Error("revoked catalog must make INSTALLED projection unusable")
  }
  if (!isInstalledBindingStillAuthorized("INSTALLED", {
    access: "ENTITLED",
    hub_status: "AVAILABLE",
    connection_status: "READY",
  })) {
    throw new Error("entitled+ready should keep projection authorized")
  }

  registry.close()
  const again = new BotRegistry(join(dir, "registry.sqlite"), join(dir, "artifacts"))
  const live = again.getOwned(aqua.id, owner)!
  again.close()
  if (live.bindings.length !== 3) throw new Error(`expected 3 bindings, got ${live.bindings.length}`)
  if (!live.bindings.some((b) => b.state === "PENDING" && b.reason === "access_request_required")) {
    throw new Error("pending request reason lost")
  }

  console.log("OK slice C BotBinding + catalog Add state machine")
  console.log(JSON.stringify({
    botId: aqua.id,
    bindings: live.bindings.map((b) => ({
      capabilityId: b.capabilityId,
      state: b.state,
      skillId: b.skillId,
      approvalPolicyRef: b.approvalPolicyRef,
      reason: b.reason,
    })),
  }, null, 2))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
