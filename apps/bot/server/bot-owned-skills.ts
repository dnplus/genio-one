import type { Database } from "bun:sqlite"

import type { GenioPrincipal } from "./runtime-broker"

const MAX_FILES = 32
const MAX_FILE_BYTES = 64 * 1024
const MAX_TOTAL_BYTES = 256 * 1024

export interface OwnedSkillFile {
  path: string
  content: string
}

export interface OwnedSkillRecord {
  skillName: string
  revision: number
  deleted: boolean
  files: OwnedSkillFile[]
  createdAt: number
  updatedAt: number
}

export interface OwnedSkillSummary {
  skillName: string
  revision: number
  description: string
  updatedAt: number
}

function asRecord(value: unknown, code: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code)
  return value as Record<string, unknown>
}

function validateSkillName(value: unknown) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error("OWNED_SKILL_NAME_INVALID")
  return value
}

function validatePath(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 180 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) throw new Error("OWNED_SKILL_PATH_INVALID")
  const parts = value.split("/")
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("OWNED_SKILL_PATH_INVALID")
  if (value !== "SKILL.md" && !value.startsWith("scripts/") && !value.startsWith("references/")) throw new Error("OWNED_SKILL_PATH_INVALID")
  return value
}

function utf8Bytes(value: string) {
  const bytes = new TextEncoder().encode(value)
  if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value) throw new Error("OWNED_SKILL_CONTENT_INVALID")
  return bytes
}

interface SkillFrontmatter {
  name: string
  description: string
}

function parseFrontmatter(content: string): SkillFrontmatter {
  const opening = /^---\r?\n/.exec(content)
  if (!opening) throw new Error("OWNED_SKILL_FRONTMATTER_INVALID")
  const closing = /\r?\n---[ \t]*(?:\r?\n|$)/g
  closing.lastIndex = opening[0].length
  const match = closing.exec(content)
  if (!match) throw new Error("OWNED_SKILL_FRONTMATTER_INVALID")
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(content.slice(opening[0].length, match.index))
  } catch {
    throw new Error("OWNED_SKILL_FRONTMATTER_INVALID")
  }
  const fields = asRecord(parsed, "OWNED_SKILL_FRONTMATTER_INVALID")
  if (typeof fields.name !== "string" || typeof fields.description !== "string" || !fields.description.trim()) throw new Error("OWNED_SKILL_FRONTMATTER_INVALID")
  return { name: fields.name, description: fields.description }
}

function validateFrontmatter(skillName: string, content: string) {
  const frontmatter = parseFrontmatter(content)
  if (frontmatter.name !== skillName) throw new Error("OWNED_SKILL_FRONTMATTER_INVALID")
  return frontmatter
}

function skillDescription(files: OwnedSkillFile[]) {
  const descriptor = files.find((file) => file.path === "SKILL.md")
  if (!descriptor) throw new Error("OWNED_SKILL_DESCRIPTOR_REQUIRED")
  return parseFrontmatter(descriptor.content).description.slice(0, 500)
}

export function validateOwnedSkillFiles(skillNameValue: unknown, value: unknown): OwnedSkillFile[] {
  const skillName = validateSkillName(skillNameValue)
  const files = Array.isArray(value) ? value : Object.entries(asRecord(value, "OWNED_SKILL_FILES_INVALID")).map(([path, content]) => ({ path, content }))
  if (files.length === 0 || files.length > MAX_FILES) throw new Error("OWNED_SKILL_FILES_INVALID")
  const seen = new Set<string>()
  let total = 0
  const normalized = files.map((file) => {
    const row = asRecord(file, "OWNED_SKILL_FILES_INVALID")
    const path = validatePath(row.path)
    if (seen.has(path)) throw new Error("OWNED_SKILL_PATH_DUPLICATE")
    seen.add(path)
    if (typeof row.content !== "string") throw new Error("OWNED_SKILL_CONTENT_INVALID")
    const bytes = utf8Bytes(row.content)
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("OWNED_SKILL_FILE_TOO_LARGE")
    total += bytes.byteLength
    return { path, content: row.content }
  }).sort((a, b) => a.path.localeCompare(b.path))
  if (total > MAX_TOTAL_BYTES) throw new Error("OWNED_SKILL_TOTAL_TOO_LARGE")
  const descriptor = normalized.find((file) => file.path === "SKILL.md")
  if (!descriptor) throw new Error("OWNED_SKILL_DESCRIPTOR_REQUIRED")
  validateFrontmatter(skillName, descriptor.content)
  return normalized
}

function parseFiles(value: unknown): OwnedSkillFile[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value
    if (!Array.isArray(parsed)) throw new Error("OWNED_SKILL_FILES_INVALID")
    return parsed.map((file) => {
      const row = asRecord(file, "OWNED_SKILL_FILES_INVALID")
      if (typeof row.path !== "string" || typeof row.content !== "string") throw new Error("OWNED_SKILL_FILES_INVALID")
      return { path: row.path, content: row.content }
    })
  } catch (error) {
    throw error instanceof Error ? error : new Error("OWNED_SKILL_FILES_INVALID")
  }
}

function tombstoneFiles(value: unknown) {
  return parseFiles(value).length === 0
}

export class BotOwnedSkills {
  constructor(
    private readonly db: Database,
    private readonly owns: (botId: string, principal: GenioPrincipal) => boolean,
  ) {
    this.db.exec(`
      create table if not exists bot_owned_skills (
        bot_id text not null,
        skill_name text not null,
        revision integer not null,
        deleted integer not null default 0,
        created_at integer not null,
        updated_at integer not null,
        primary key (bot_id, skill_name)
      );
      create table if not exists bot_owned_skill_revisions (
        bot_id text not null,
        skill_name text not null,
        revision integer not null,
        files_json text not null,
        created_at integer not null,
        primary key (bot_id, skill_name, revision)
      );
    `)
  }

  list(principal: GenioPrincipal, botId: string): OwnedSkillSummary[] {
    this.requireOwner(botId, principal)
    const rows = this.db.query("select skill_name, revision, updated_at from bot_owned_skills where bot_id = ? and deleted = 0 order by skill_name").all(botId) as Array<{ skill_name: string; revision: number; updated_at: number }>
    return rows.map((row) => {
      const record = this.record(botId, row.skill_name, { revision: Number(row.revision), deleted: false, createdAt: 0, updatedAt: Number(row.updated_at) })
      return { skillName: row.skill_name, revision: Number(row.revision), description: skillDescription(record.files), updatedAt: Number(row.updated_at) }
    })
  }

  read(principal: GenioPrincipal, botId: string, skillNameValue: unknown): OwnedSkillRecord {
    this.requireOwner(botId, principal)
    const skillName = validateSkillName(skillNameValue)
    const row = this.current(botId, skillName)
    if (!row) throw new Error("OWNED_SKILL_NOT_FOUND")
    return this.record(botId, skillName, row)
  }

  revisions(principal: GenioPrincipal, botId: string, skillNameValue: unknown) {
    this.requireOwner(botId, principal)
    const skillName = validateSkillName(skillNameValue)
    const current = this.current(botId, skillName)
    if (!current) throw new Error("OWNED_SKILL_NOT_FOUND")
    const rows = this.db.query("select revision, files_json, created_at from bot_owned_skill_revisions where bot_id = ? and skill_name = ? order by revision desc").all(botId, skillName) as Array<{ revision: number; files_json: string; created_at: number }>
    return rows.map((row) => ({ revision: Number(row.revision), updatedAt: Number(row.created_at), deleted: tombstoneFiles(row.files_json) }))
  }

  write(principal: GenioPrincipal, botId: string, input: { skillName: unknown; files: unknown; expectedRevision: unknown }): OwnedSkillRecord {
    this.requireOwner(botId, principal)
    const skillName = validateSkillName(input.skillName)
    const expectedRevision = this.expectedRevision(input.expectedRevision)
    const files = validateOwnedSkillFiles(skillName, input.files)
    return this.db.transaction(() => this.commit(botId, skillName, files, expectedRevision))()
  }

  revert(principal: GenioPrincipal, botId: string, input: { skillName: unknown; revision: unknown; expectedRevision: unknown }): OwnedSkillRecord {
    this.requireOwner(botId, principal)
    const skillName = validateSkillName(input.skillName)
    const revision = this.expectedRevision(input.revision)
    const expectedRevision = this.expectedRevision(input.expectedRevision)
    const source = this.db.query("select files_json from bot_owned_skill_revisions where bot_id = ? and skill_name = ? and revision = ?").get(botId, skillName, revision) as { files_json?: string } | null
    if (!source) throw new Error("OWNED_SKILL_REVISION_NOT_FOUND")
    if (tombstoneFiles(source.files_json)) throw new Error("OWNED_SKILL_REVISION_TOMBSTONED")
    const files = validateOwnedSkillFiles(skillName, parseFiles(source.files_json))
    return this.db.transaction(() => this.commit(botId, skillName, files, expectedRevision))()
  }

  delete(principal: GenioPrincipal, botId: string, input: { skillName: unknown; expectedRevision: unknown }) {
    this.requireOwner(botId, principal)
    const skillName = validateSkillName(input.skillName)
    const expectedRevision = this.expectedRevision(input.expectedRevision)
    return this.db.transaction(() => {
      const current = this.current(botId, skillName)
      if (!current || current.deleted) throw new Error("OWNED_SKILL_NOT_FOUND")
      if (current.revision !== expectedRevision) throw new Error("OWNED_SKILL_REVISION_CONFLICT")
      const revision = current.revision + 1
      const now = Date.now()
      this.db.query("insert into bot_owned_skill_revisions (bot_id, skill_name, revision, files_json, created_at) values (?, ?, ?, ?, ?)").run(botId, skillName, revision, "[]", now)
      this.db.query("update bot_owned_skills set revision = ?, deleted = 1, updated_at = ? where bot_id = ? and skill_name = ? and revision = ?").run(revision, now, botId, skillName, current.revision)
      return { skillName, revision, deleted: true }
    })()
  }

  private requireOwner(botId: string, principal: GenioPrincipal) {
    if (!this.owns(botId, principal)) throw new Error("BOT_NOT_FOUND")
  }

  private expectedRevision(value: unknown) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("OWNED_SKILL_REVISION_INVALID")
    return Number(value)
  }

  private current(botId: string, skillName: string) {
    const row = this.db.query("select revision, deleted, created_at, updated_at from bot_owned_skills where bot_id = ? and skill_name = ?").get(botId, skillName) as { revision: number; deleted: number; created_at: number; updated_at: number } | null
    return row ? { revision: Number(row.revision), deleted: Number(row.deleted) === 1, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) } : null
  }

  private record(botId: string, skillName: string, current: { revision: number; deleted: boolean; createdAt: number; updatedAt: number }): OwnedSkillRecord {
    const source = this.db.query("select files_json from bot_owned_skill_revisions where bot_id = ? and skill_name = ? and revision = ?").get(botId, skillName, current.revision) as { files_json?: string } | null
    if (!source) throw new Error("OWNED_SKILL_REVISION_NOT_FOUND")
    const files = current.deleted ? parseFiles(source.files_json) : validateOwnedSkillFiles(skillName, parseFiles(source.files_json))
    return { skillName, revision: current.revision, deleted: current.deleted, files, createdAt: current.createdAt, updatedAt: current.updatedAt }
  }

  private commit(botId: string, skillName: string, files: OwnedSkillFile[], expectedRevision: number): OwnedSkillRecord {
    const current = this.current(botId, skillName)
    const actual = current?.revision ?? 0
    if (actual !== expectedRevision) throw new Error("OWNED_SKILL_REVISION_CONFLICT")
    const revision = actual + 1
    const now = Date.now()
    this.db.query("insert into bot_owned_skill_revisions (bot_id, skill_name, revision, files_json, created_at) values (?, ?, ?, ?, ?)").run(botId, skillName, revision, JSON.stringify(files), now)
    if (current) {
      this.db.query("update bot_owned_skills set revision = ?, deleted = 0, updated_at = ? where bot_id = ? and skill_name = ? and revision = ?").run(revision, now, botId, skillName, current.revision)
    } else {
      this.db.query("insert into bot_owned_skills (bot_id, skill_name, revision, deleted, created_at, updated_at) values (?, ?, ?, 0, ?, ?)").run(botId, skillName, revision, now, now)
    }
    return { skillName, revision, deleted: false, files, createdAt: current?.createdAt ?? now, updatedAt: now }
  }
}
