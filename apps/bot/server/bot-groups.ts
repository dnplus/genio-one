import { randomUUID } from "node:crypto"
import type { Database } from "bun:sqlite"
import type { GenioPrincipal } from "./runtime-broker"
import type { BotRecord } from "./bot-registry"
export const GROUP_FOLDER_MIN_MEMBERS = 1
export const GROUP_MAX_MEMBERS = 6
export interface BotGroupRecord {
  groupId: string
  tenantId: string
  ownerSubjectId: string
  name: string
  memberBotIds: string[]
  createdAt: number
  updatedAt: number
}

export interface CreateGroupInput { name: string; memberBotIds: string[] }
export class GroupMemberCountError extends Error {
  readonly code = "GROUP_MEMBER_COUNT"
  constructor(count: number) {
    super(`Group requires 1–6 members (got ${count})`)
    this.name = "GroupMemberCountError"
  }
}
export function normalizeFolderMembers(memberBotIds: string[]): string[] {
  const ids = [...new Set(memberBotIds.map((id) => id.trim()).filter(Boolean))]
  if (ids.length < GROUP_FOLDER_MIN_MEMBERS || ids.length > GROUP_MAX_MEMBERS) {
    throw new GroupMemberCountError(ids.length)
  }
  return ids
}

export function ensureBotGroupSchema(db: Database) {
  db.exec(`
    create table if not exists bot_groups (
      group_id text primary key,
      tenant_id text not null,
      owner_subject_id text not null,
      name text not null,
      member_bot_ids_json text not null,
      created_at integer not null,
      updated_at integer not null
    );
    create index if not exists idx_bot_groups_tenant_owner on bot_groups(tenant_id, owner_subject_id);
  `)
}

export class BotGroupStore {
  constructor(
    private readonly db: Database,
    private readonly getOwnedBot: (botId: string, principal: GenioPrincipal) => BotRecord | null,
  ) {
    ensureBotGroupSchema(this.db)
  }

  createGroup(principal: GenioPrincipal, input: CreateGroupInput): BotGroupRecord {
    const memberBotIds = normalizeFolderMembers(input.memberBotIds)
    const name = input.name.trim()
    if (!name) throw new Error("GROUP_NAME_REQUIRED")
    if (name.length > 120) throw new Error("GROUP_NAME_TOO_LONG")

    for (const botId of memberBotIds) {
      const bot = this.getOwnedBot(botId, principal)
      if (!bot) throw new Error("BOT_NOT_FOUND")
    }

    const now = Date.now()
    const groupId = `bot-group-${randomUUID()}`
    this.db.query(`insert into bot_groups (
      group_id, tenant_id, owner_subject_id, name, member_bot_ids_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?)`).run(
      groupId,
      principal.tenant_id,
      principal.subject_id,
      name,
      JSON.stringify(memberBotIds),
      now,
      now,
    )
    return this.getGroup(principal, groupId)!
  }

  getGroup(principal: GenioPrincipal, groupId: string): BotGroupRecord | null {
    const row = this.db.query(`select * from bot_groups where group_id = ? and tenant_id = ?`).get(
      groupId,
      principal.tenant_id,
    ) as Record<string, unknown> | null
    if (!row) return null
    if (String(row.owner_subject_id) !== principal.subject_id) return null
    return this.mapGroup(row)
  }

  updateGroupMembers(principal: GenioPrincipal, groupId: string, memberBotIds: string[]): BotGroupRecord {
    const group = this.getGroup(principal, groupId)
    if (!group) throw new Error("GROUP_NOT_FOUND")
    const next = [...new Set(memberBotIds.map((id) => id.trim()).filter(Boolean))]
    if (next.length > GROUP_MAX_MEMBERS) throw new GroupMemberCountError(next.length)
    for (const botId of next) {
      const bot = this.getOwnedBot(botId, principal)
      if (!bot) throw new Error("BOT_NOT_FOUND")
    }
    const now = Date.now()
    this.db.query(`update bot_groups set member_bot_ids_json = ?, updated_at = ? where group_id = ?`).run(
      JSON.stringify(next),
      now,
      groupId,
    )
    return this.getGroup(principal, groupId)!
  }

  listGroups(principal: GenioPrincipal): BotGroupRecord[] {
    const rows = this.db.query(
      `select * from bot_groups where tenant_id = ? and owner_subject_id = ? order by updated_at desc`,
    ).all(principal.tenant_id, principal.subject_id) as Array<Record<string, unknown>>
    return rows.map((row) => this.mapGroup(row))
  }

  private mapGroup(row: Record<string, unknown>): BotGroupRecord {
    return {
      groupId: String(row.group_id),
      tenantId: String(row.tenant_id),
      ownerSubjectId: String(row.owner_subject_id),
      name: String(row.name),
      memberBotIds: JSON.parse(String(row.member_bot_ids_json)) as string[],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }
}
