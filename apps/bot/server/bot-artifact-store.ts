import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import type { Database } from "bun:sqlite"

import type { GenioPrincipal } from "./runtime-broker"

export type RuntimeTier = "none" | "headless" | "desktop"

export interface ArtifactRef {
  artifactId: string
  tenantId: string
  botId: string
  sourceTier: RuntimeTier
  sourceEnvironmentId: string
  path: string
  digest: string
  contentType: string
  size: number
  createdAt: number
}

function isRuntimeTier(value: unknown): value is RuntimeTier {
  return value === "none" || value === "headless" || value === "desktop"
}

export class BotArtifactStore {
  constructor(
    private readonly db: Database,
    readonly artifactStoreRoot: string,
    private readonly getOwnedBot: (botId: string, principal: GenioPrincipal) => { id: string } | null,
  ) {
    mkdirSync(this.artifactStoreRoot, { recursive: true })
  }

  artifactStoragePath(artifactId: string): string {
    if (!/^artifact-[a-f0-9-]+$/i.test(artifactId)) throw new Error("ARTIFACT_ID_INVALID")
    return resolve(this.artifactStoreRoot, artifactId)
  }

  storeArtifactBytes(artifactId: string, bytes: Uint8Array): string {
    const destination = this.artifactStoragePath(artifactId)
    const temporary = `${destination}.tmp-${randomUUID()}`
    writeFileSync(temporary, bytes)
    renameSync(temporary, destination)
    return destination
  }

  readArtifactBytes(artifactId: string): Buffer {
    return readFileSync(this.artifactStoragePath(artifactId))
  }

  registerArtifact(principal: GenioPrincipal, input: {
    botId: string
    sourceTier: RuntimeTier
    sourceEnvironmentId: string
    path: string
    digest: string
    contentType?: string
    size?: number
  }): ArtifactRef {
    const bot = this.getOwnedBot(input.botId, principal)
    if (!bot) throw new Error("BOT_NOT_FOUND")
    if (!isRuntimeTier(input.sourceTier) || input.sourceTier === "none") throw new Error("ARTIFACT_RUNTIME_TIER_INVALID")
    const path = input.path.trim()
    if (!/^\/home\/user\/[A-Za-z0-9._/-]+$/.test(path) || path.split("/").includes("..")) throw new Error("ARTIFACT_PATH_INVALID")
    const digest = input.digest.trim()
    if (!digest) throw new Error("ARTIFACT_DIGEST_REQUIRED")
    const artifact: ArtifactRef = {
      artifactId: `artifact-${randomUUID()}`,
      tenantId: principal.tenant_id,
      botId: bot.id,
      sourceTier: input.sourceTier,
      sourceEnvironmentId: input.sourceEnvironmentId.trim(),
      path,
      digest,
      contentType: input.contentType?.trim() || "application/octet-stream",
      size: Number.isFinite(input.size) && (input.size ?? 0) >= 0 ? Math.floor(input.size!) : 0,
      createdAt: Date.now(),
    }
    if (!artifact.sourceEnvironmentId) throw new Error("ARTIFACT_ENVIRONMENT_REQUIRED")
    this.db.query(`insert into bot_artifacts (artifact_id, tenant_id, bot_id, source_tier, source_environment_id, path, digest, content_type, size, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      artifact.artifactId,
      artifact.tenantId,
      artifact.botId,
      artifact.sourceTier,
      artifact.sourceEnvironmentId,
      artifact.path,
      artifact.digest,
      artifact.contentType,
      artifact.size,
      artifact.createdAt,
    )
    return artifact
  }

  listArtifacts(principal: GenioPrincipal, botId: string): ArtifactRef[] {
    const bot = this.getOwnedBot(botId, principal)
    if (!bot) throw new Error("BOT_NOT_FOUND")
    const rows = this.db.query("select * from bot_artifacts where tenant_id = ? and bot_id = ? order by created_at desc").all(principal.tenant_id, bot.id) as Record<string, unknown>[]
    return rows.map((row) => this.mapArtifact(row))
  }

  getArtifact(principal: GenioPrincipal, botId: string, artifactId: string): ArtifactRef | null {
    const bot = this.getOwnedBot(botId, principal)
    if (!bot) throw new Error("BOT_NOT_FOUND")
    const row = this.db.query("select * from bot_artifacts where tenant_id = ? and bot_id = ? and artifact_id = ?").get(principal.tenant_id, bot.id, artifactId) as Record<string, unknown> | null
    return row ? this.mapArtifact(row) : null
  }

  mapArtifact(row: Record<string, unknown>): ArtifactRef {
    return {
      artifactId: String(row.artifact_id),
      tenantId: String(row.tenant_id),
      botId: String(row.bot_id),
      sourceTier: isRuntimeTier(row.source_tier) ? row.source_tier : "headless",
      sourceEnvironmentId: String(row.source_environment_id),
      path: String(row.path),
      digest: String(row.digest),
      contentType: String(row.content_type),
      size: Number(row.size),
      createdAt: Number(row.created_at),
    }
  }
}
