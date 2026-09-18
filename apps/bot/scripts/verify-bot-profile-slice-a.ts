/**
 * Slice A verification: CreateBot → GET profile fields, server SoT (no browser storage).
 * Run: bun apps/bot/scripts/verify-bot-profile-slice-a.ts
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BotRegistry, toBotProfile } from "../server/bot-registry"
import type { GenioPrincipal } from "../server/runtime-broker"

const owner: GenioPrincipal = {
  tenant_id: "tenant-verify-slice-a",
  subject_id: "person-verify",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

const dir = mkdtempSync(join(tmpdir(), "slice-a-bot-profile-"))
const registry = new BotRegistry(join(dir, "registry.sqlite"), join(dir, "artifacts"))

try {
  const created = registry.create(owner, {
    name: "阿庫婭",
    title: "切片 A 驗證 Bot",
    description: "server-side BotProfile；清 browser storage 後仍在。",
    avatar: { shape: "cercle", color: "turquoise", expression: "attentif" },
    modelRoute: "codex-subscription",
  })
  const profile = registry.getProfile(created.id, owner)
  if (!profile) throw new Error("GET profile returned null")

  const required = ["botId", "name", "title", "description", "avatar", "modelRoute", "tenantId", "ownerSubjectId", "createdAt", "updatedAt"] as const
  for (const key of required) {
    if (profile[key] === undefined || profile[key] === null || profile[key] === "") {
      throw new Error(`missing profile field: ${key}`)
    }
  }
  if (profile.title === profile.description) throw new Error("title must not collapse into description")
  if (profile.tenantId !== owner.tenant_id || profile.ownerSubjectId !== owner.subject_id) {
    throw new Error("owner/tenant mismatch")
  }
  if (JSON.stringify(toBotProfile(created)) !== JSON.stringify(profile)) {
    throw new Error("toBotProfile mismatch vs getProfile")
  }

  // Simulate "clear browser storage": reopen DB file, roster still there
  registry.close()
  const again = new BotRegistry(join(dir, "registry.sqlite"), join(dir, "artifacts"))
  const listed = again.list(owner)
  const live = again.getProfile(created.id, owner)
  again.close()
  if (listed.length !== 1 || !live || live.name !== "阿庫婭") {
    throw new Error("roster/profile lost after reopen (server SoT failed)")
  }

  console.log("OK slice A BotProfile")
  console.log(JSON.stringify({ createdId: created.id, profile: live, rosterCount: listed.length }, null, 2))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
