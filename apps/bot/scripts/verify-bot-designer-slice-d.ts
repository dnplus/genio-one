/**
 * Slice D verification: Bot Designer draft → CreateBot → GET read-back → conversation-ready.
 * Does not enable routines or install plugins.
 * Run: bun apps/bot/scripts/verify-bot-designer-slice-d.ts
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  assertDesignerReadBack,
  designerCreatePayload,
  parseDesignerDescription,
  type BotDesignerDraft,
} from "../server/bot-designer"
import { BotRegistry, toBotProfile } from "../server/bot-registry"
import type { GenioPrincipal } from "../server/runtime-broker"

const owner: GenioPrincipal = {
  tenant_id: "tenant-verify-slice-d",
  subject_id: "person-verify",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

const draft: BotDesignerDraft = {
  name: "阿庫婭",
  oneJob: "把模糊需求收成可驗收切片",
  antiJobs: "不代寄信、不擅自啟用 routine、不裝市集插件",
  voice: "直球、短句、可靠",
  wake: "both",
  avatar: { shape: "cercle", color: "turquoise", expression: "attentif" },
}

const dir = mkdtempSync(join(tmpdir(), "slice-d-bot-designer-"))
const registry = new BotRegistry(join(dir, "registry.sqlite"), join(dir, "artifacts"))

try {
  const payload = designerCreatePayload(draft)
  if (payload.skills.length !== 0) throw new Error("designer must not install skills")
  if (payload.defaultRuntimeTier !== "none") throw new Error("designer must keep runtime none")

  const created = registry.create(owner, payload)
  if (created.skills.length !== 0) throw new Error("created bot must have zero skills")
  if (created.bindings.length !== 0) throw new Error("created bot must have zero bindings")
  if (created.sharePolicy.visibility !== "PRIVATE") throw new Error("must be PRIVATE")
  if (created.wake !== "both") throw new Error("wake preference not stored")

  const profile = registry.getProfile(created.id, owner)
  if (!profile) throw new Error("GET profile returned null")
  assertDesignerReadBack(draft, profile)
  if (profile.visibility !== "PRIVATE") throw new Error("profile visibility not PRIVATE")

  const parsed = parseDesignerDescription(profile.description)
  if (!parsed || parsed.oneJob !== draft.oneJob || parsed.wake !== "both") {
    throw new Error("description does not round-trip designer fields")
  }

  // Conversation-ready session projection (no routine enablement)
  const session = registry.saveSession({ botId: created.id, activeRuntimeTier: "none" })
  if (session.workState !== "idle") throw new Error("session not idle for chat")

  registry.close()
  const again = new BotRegistry(join(dir, "registry.sqlite"), join(dir, "artifacts"))
  const live = again.getProfile(created.id, owner)
  const roster = again.listRoster(owner)
  again.close()
  if (!live || live.name !== draft.name || live.antiJobs !== draft.antiJobs) {
    throw new Error("profile lost after reopen")
  }
  if (JSON.stringify(toBotProfile(created)) === "") throw new Error("unexpected empty profile")
  if (roster.length !== 1 || roster[0]!.session.workState !== "idle") {
    throw new Error("roster/session not conversation-ready")
  }

  console.log("OK slice D Bot Designer")
  console.log(JSON.stringify({
    createdId: created.id,
    profile: live,
    skills: created.skills,
    bindings: created.bindings.length,
    wakeStoredNotEnabled: live.wake,
    rosterReady: true,
  }, null, 2))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
