import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Database } from "bun:sqlite"
import type { HandsProvider, HandsWorkspace } from "@genioone/protocol/hands"
import type { GenioPrincipal } from "./runtime-broker"

export function configuredHandsProvider(environment: NodeJS.ProcessEnv = process.env): HandsProvider {
  const value = environment.GENIO_BOT_RUNTIME?.trim() || "e2b-self-hosted"
  if (value === "local") return "e2b-self-hosted"
  if (value === "e2b-self-hosted" || value === "cloudflare-hands") return value
  throw new Error("HANDS_PROVIDER_INVALID")
}

export class BotWorkspaceStore {
  private readonly isolateTasks = new Map<string, { requestId: string; digest: string; pending: Promise<unknown> }>()

  constructor(
    private readonly db: Database,
    private readonly getOwnedBot: (botId: string, principal: GenioPrincipal) => { id: string } | null,
    private readonly root = process.env.GENIO_BOT_WORKSPACE_STORE?.trim() || resolve(import.meta.dir, "../.local/workspaces"),
  ) {
    mkdirSync(this.root, { recursive: true })
    this.db.exec(`create table if not exists bot_workspaces (
      workspace_id text primary key,
      tenant_id text not null,
      bot_id text not null,
      owner_subject_id text not null,
      acting_client_id text not null,
      provider text not null,
      revision integer not null,
      active integer not null,
      orphaned_at integer,
      created_at integer not null,
      updated_at integer not null
    );
    create unique index if not exists bot_workspaces_active on bot_workspaces(bot_id) where active = 1;
    create index if not exists bot_workspaces_owner on bot_workspaces(tenant_id, bot_id, owner_subject_id);
    create table if not exists bot_workspace_lease_attempts (
      workspace_id text not null,
      tier text not null,
      revision integer not null,
      generation integer not null,
      request_key text not null,
      state text not null,
      brain_session_id text not null,
      actor_client_id text not null,
      updated_at integer not null,
      primary key (workspace_id, tier)
    );`)
    const attemptColumns = this.db.query("pragma table_info(bot_workspace_lease_attempts)").all() as Array<{ name: string }>
    if (!attemptColumns.some((column) => column.name === "brain_session_id")) this.db.exec("alter table bot_workspace_lease_attempts add column brain_session_id text not null default ''")
    if (!attemptColumns.some((column) => column.name === "actor_client_id")) this.db.exec("alter table bot_workspace_lease_attempts add column actor_client_id text not null default ''")
  }

  private owned(principal: GenioPrincipal, botId: string) {
    if (!this.getOwnedBot(botId, principal)) throw new Error("BOT_NOT_FOUND")
  }

  belongsToOwner(principal: GenioPrincipal, botId: string) {
    return Boolean(this.db.query("select 1 from bots where id = ? and tenant_id = ? and owner_subject_id = ?").get(botId, principal.tenant_id, principal.subject_id))
  }

  private map(row: Record<string, unknown>): HandsWorkspace {
    if (row.provider !== "cloudflare-hands" && row.provider !== "e2b-self-hosted") throw new Error("HANDS_PROVIDER_INVALID")
    return {
      workspaceId: String(row.workspace_id),
      tenantId: String(row.tenant_id),
      botId: String(row.bot_id),
      ownerSubjectId: String(row.owner_subject_id),
      actingClientId: String(row.acting_client_id),
      provider: row.provider,
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  list(principal: GenioPrincipal, botId: string): HandsWorkspace[] {
    this.owned(principal, botId)
    const rows = this.db.query("select * from bot_workspaces where tenant_id = ? and bot_id = ? and owner_subject_id = ? and orphaned_at is null order by active desc, created_at desc").all(principal.tenant_id, botId, principal.subject_id) as Record<string, unknown>[]
    return rows.map((row) => this.map(row))
  }

  get(principal: GenioPrincipal, botId: string, workspaceId: string): HandsWorkspace | null {
    this.owned(principal, botId)
    const row = this.db.query("select * from bot_workspaces where workspace_id = ? and tenant_id = ? and bot_id = ? and owner_subject_id = ? and orphaned_at is null").get(workspaceId, principal.tenant_id, botId, principal.subject_id) as Record<string, unknown> | null
    return row ? this.map(row) : null
  }

  active(principal: GenioPrincipal, botId: string): HandsWorkspace | null {
    this.owned(principal, botId)
    const row = this.db.query("select * from bot_workspaces where tenant_id = ? and bot_id = ? and owner_subject_id = ? and active = 1 and orphaned_at is null").get(principal.tenant_id, botId, principal.subject_id) as Record<string, unknown> | null
    return row ? this.map(row) : null
  }

  ensureActive(principal: GenioPrincipal, botId: string): HandsWorkspace {
    return this.active(principal, botId) ?? this.create(principal, botId, configuredHandsProvider())
  }

  create(principal: GenioPrincipal, botId: string, provider: HandsProvider): HandsWorkspace {
    this.owned(principal, botId)
    if (provider !== "e2b-self-hosted" && provider !== "cloudflare-hands") throw new Error("HANDS_PROVIDER_INVALID")
    const workspaceId = randomUUID()
    const now = Date.now()
    const transaction = this.db.transaction(() => {
      this.db.query("update bot_workspaces set active = 0, updated_at = ? where tenant_id = ? and bot_id = ? and owner_subject_id = ? and active = 1").run(now, principal.tenant_id, botId, principal.subject_id)
      this.db.query("insert into bot_workspaces (workspace_id, tenant_id, bot_id, owner_subject_id, acting_client_id, provider, revision, active, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)").run(workspaceId, principal.tenant_id, botId, principal.subject_id, principal.acting_client_id, provider, now, now)
    })
    transaction()
    return this.active(principal, botId)!
  }

  setActive(principal: GenioPrincipal, botId: string, workspaceId: string): HandsWorkspace {
    const workspace = this.get(principal, botId, workspaceId)
    if (!workspace) throw new Error("WORKSPACE_NOT_FOUND")
    const now = Date.now()
    const transaction = this.db.transaction(() => {
      this.db.query("update bot_workspaces set active = 0, updated_at = ? where tenant_id = ? and bot_id = ? and owner_subject_id = ? and active = 1").run(now, principal.tenant_id, botId, principal.subject_id)
      this.db.query("update bot_workspaces set active = 1, updated_at = ? where workspace_id = ?").run(now, workspaceId)
    })
    transaction()
    return this.active(principal, botId)!
  }

  updateRevision(workspaceId: string, revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("WORKSPACE_REVISION_INVALID")
    const row = this.db.query("select revision from bot_workspaces where workspace_id = ?").get(workspaceId) as { revision: number } | null
    if (!row || revision < row.revision) throw new Error("WORKSPACE_REVISION_STALE")
    this.db.query("update bot_workspaces set revision = ?, updated_at = ? where workspace_id = ?").run(revision, Date.now(), workspaceId)
  }

  unresolvedLeaseAttempt(principal: GenioPrincipal, brainSessionId: string): { workspaceId: string; botId: string; tier: "headless" | "desktop" } | null {
    const row = this.db.query(`select attempts.workspace_id, workspaces.bot_id, attempts.tier
      from bot_workspace_lease_attempts attempts join bot_workspaces workspaces on workspaces.workspace_id = attempts.workspace_id
      where workspaces.tenant_id = ? and workspaces.owner_subject_id = ? and attempts.actor_client_id = ? and attempts.brain_session_id = ? and workspaces.orphaned_at is null
        and attempts.state = 'PENDING'
      order by attempts.updated_at limit 1`).get(principal.tenant_id, principal.subject_id, principal.acting_client_id, brainSessionId) as { workspace_id: string; bot_id: string; tier: string } | null
    if (!row) return null
    if (row.tier !== "headless" && row.tier !== "desktop") throw new Error("HANDS_LEASE_ATTEMPT_INVALID")
    return { workspaceId: row.workspace_id, botId: row.bot_id, tier: row.tier }
  }

  reserveLeaseAttempt(workspace: HandsWorkspace, tier: "headless" | "desktop", brainSessionId: string, actorClientId: string): string {
    return this.db.transaction(() => {
      const current = this.db.query("select revision, provider from bot_workspaces where workspace_id = ? and tenant_id = ? and bot_id = ? and owner_subject_id = ? and orphaned_at is null").get(workspace.workspaceId, workspace.tenantId, workspace.botId, workspace.ownerSubjectId) as { revision: number; provider: string } | null
      if (!current || current.provider !== "cloudflare-hands" || current.revision !== workspace.revision) throw new Error("WORKSPACE_REVISION_STALE")
      const previous = this.db.query("select revision, request_key, state, actor_client_id from bot_workspace_lease_attempts where workspace_id = ? and tier = ?").get(workspace.workspaceId, tier) as { revision: number; request_key: string; state: string; actor_client_id: string } | null
      if (previous?.state === "PENDING" || (previous?.state === "READY" && previous.revision === workspace.revision)) {
        if (previous.actor_client_id !== actorClientId) throw new Error("WORKSPACE_BUSY")
        this.db.query("update bot_workspace_lease_attempts set state = 'PENDING', brain_session_id = ?, updated_at = ? where workspace_id = ? and tier = ?").run(brainSessionId, Date.now(), workspace.workspaceId, tier)
        return previous.request_key
      }
      const requestKey = randomUUID()
      this.db.query(`insert into bot_workspace_lease_attempts (workspace_id, tier, revision, generation, request_key, state, brain_session_id, actor_client_id, updated_at)
        values (?, ?, ?, 0, ?, 'PENDING', ?, ?, ?)
        on conflict(workspace_id, tier) do update set revision = excluded.revision, generation = 0,
          request_key = excluded.request_key, state = 'PENDING', brain_session_id = excluded.brain_session_id,
          actor_client_id = excluded.actor_client_id, updated_at = excluded.updated_at`).run(workspace.workspaceId, tier, workspace.revision, requestKey, brainSessionId, actorClientId, Date.now())
      return requestKey
    })()
  }

  markLeaseAttemptReady(workspaceId: string, tier: "headless" | "desktop", requestKey: string) {
    const result = this.db.query("update bot_workspace_lease_attempts set revision = (select revision from bot_workspaces where workspace_id = ?), state = 'READY', updated_at = ? where workspace_id = ? and tier = ? and request_key = ?").run(workspaceId, Date.now(), workspaceId, tier, requestKey)
    if (result.changes !== 1) throw new Error("HANDS_LEASE_ATTEMPT_CHANGED")
  }

  rotateLostLeaseAttempt(workspaceId: string, tier: "headless" | "desktop", expectedKey: string): string {
    return this.db.transaction(() => {
      const row = this.db.query("select request_key from bot_workspace_lease_attempts where workspace_id = ? and tier = ?").get(workspaceId, tier) as { request_key: string } | null
      if (!row) throw new Error("HANDS_LEASE_ATTEMPT_MISSING")
      if (row.request_key !== expectedKey) return row.request_key
      const nextKey = randomUUID()
      this.db.query("update bot_workspace_lease_attempts set generation = generation + 1, request_key = ?, state = 'PENDING', updated_at = ? where workspace_id = ? and tier = ? and request_key = ?").run(nextKey, Date.now(), workspaceId, tier, expectedKey)
      return nextKey
    })()
  }

  hasInFlightForBot(botId: string) {
    if (this.isolateTasks.size === 0) return false
    const rows = this.db.query("select workspace_id from bot_workspaces where bot_id = ?").all(botId) as Array<{ workspace_id: string }>
    return rows.some((row) => this.isolateTasks.has(row.workspace_id))
  }

  recoverable(principal: GenioPrincipal) {
    const rows = this.db.query("select * from bot_workspaces where tenant_id = ? and owner_subject_id = ? and orphaned_at is not null order by orphaned_at desc").all(principal.tenant_id, principal.subject_id) as Record<string, unknown>[]
    return rows.map((row) => ({ ...this.map(row), orphanedAt: Number(row.orphaned_at) }))
  }

  getRecoverable(principal: GenioPrincipal, workspaceId: string) {
    const row = this.db.query("select * from bot_workspaces where workspace_id = ? and tenant_id = ? and owner_subject_id = ? and orphaned_at is not null").get(workspaceId, principal.tenant_id, principal.subject_id) as Record<string, unknown> | null
    return row ? { ...this.map(row), orphanedAt: Number(row.orphaned_at) } : null
  }

  runIsolate<T>(workspaceId: string, requestId: string, input: unknown, task: () => Promise<T>): Promise<T> {
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex")
    const existing = this.isolateTasks.get(workspaceId)
    if (existing) {
      if (existing.requestId !== requestId) throw new Error("WORKSPACE_BUSY")
      if (existing.digest !== digest) throw new Error("HANDS_REQUEST_ID_CONFLICT")
      return existing.pending as Promise<T>
    }
    const pending = Promise.resolve().then(task).finally(() => {
      if (this.isolateTasks.get(workspaceId)?.pending === pending) this.isolateTasks.delete(workspaceId)
    })
    this.isolateTasks.set(workspaceId, { requestId, digest, pending })
    return pending
  }

  readCheckpoint(workspaceId: string, revision: number): Uint8Array | null {
    if (revision === 0) return null
    const path = this.checkpointPath(workspaceId, revision)
    if (!existsSync(path)) throw new Error("WORKSPACE_CHECKPOINT_MISSING")
    return readFileSync(path)
  }

  saveCheckpoint(workspaceId: string, expectedRevision: number, bytes: Uint8Array): number {
    const row = this.db.query("select revision from bot_workspaces where workspace_id = ? and provider = 'e2b-self-hosted'").get(workspaceId) as { revision: number } | null
    if (!row || row.revision !== expectedRevision) throw new Error("WORKSPACE_REVISION_STALE")
    const revision = expectedRevision + 1
    const path = this.checkpointPath(workspaceId, revision)
    mkdirSync(resolve(this.root, workspaceId), { recursive: true })
    const temporary = `${path}.tmp-${randomUUID()}`
    writeFileSync(temporary, bytes)
    const descriptor = openSync(temporary, "r")
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
    renameSync(temporary, path)
    this.updateRevision(workspaceId, revision)
    return revision
  }

  private checkpointPath(workspaceId: string, revision: number) {
    if (!/^[a-f0-9-]{36}$/.test(workspaceId) || !Number.isSafeInteger(revision) || revision < 1) throw new Error("WORKSPACE_CHECKPOINT_PATH_INVALID")
    return resolve(this.root, workspaceId, `${revision}.tar.gz`)
  }
}
