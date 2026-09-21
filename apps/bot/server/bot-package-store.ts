import { createHash } from "node:crypto"
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"

import type { BotPackageManifest } from "./bot-registry"
import { canonicalJson } from "@genioone/protocol/canonical"

export interface ResolvedBotPackage {
  manifest: BotPackageManifest
  artifactRoot: string | null
}

export interface MaterializedBotPlugin {
  name: string
  marketplace?: string
  marketplacePath?: string
  digest?: string
}

function safeRelativePath(value: string) {
  if (!value.trim() || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("BOT_PACKAGE_PATH_INVALID")
  }
  return value
}

function safeSegment(value: string, code: string) {
  const normalized = stringValue(value, code)
  if (normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0")) throw new Error("BOT_PACKAGE_PATH_INVALID")
  return normalized
}

function stringValue(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`BOT_PACKAGE_${field.toUpperCase()}_REQUIRED`)
  return value.trim()
}

function verifyManifestDigest(value: Record<string, unknown>) {
  const digest = stringValue(value.manifestDigest ?? value.manifest_digest, "manifest_digest")
  const { manifestDigest: _camel, manifest_digest: _snake, ...unsigned } = value
  const expected = createHash("sha256").update(canonicalJson(unsigned)).digest("hex")
  if (digest !== expected) throw new Error("BOT_PACKAGE_MANIFEST_DIGEST_MISMATCH")
}

export function validateBotPackageManifest(manifest: BotPackageManifest): BotPackageManifest {
  if (manifest.source?.kind === "FIXTURE") throw new Error("BOT_PACKAGE_SOURCE_UNSUPPORTED")
  if (manifest.packageType !== "BOT") throw new Error("BOT_PACKAGE_TYPE_INVALID")
  safeSegment(manifest.resourceId, "resource_id")
  safeSegment(manifest.version, "version")
  stringValue(manifest.profile.title, "profile_title")
  stringValue(manifest.profile.description, "profile_description")
  stringValue(manifest.manifestDigest, "manifest_digest")
  stringValue(manifest.artifactDigest, "artifact_digest")
  if (!Array.isArray(manifest.skills) || !Array.isArray(manifest.plugins) || !Array.isArray(manifest.resourceBindings)) throw new Error("BOT_PACKAGE_MANIFEST_INVALID")
  for (const skill of manifest.skills) {
    stringValue(skill.id, "skill_id")
    safeRelativePath(skill.path)
  }
  for (const plugin of manifest.plugins) {
    stringValue(plugin.name, "plugin_name")
    if (plugin.marketplacePath) safeRelativePath(plugin.marketplacePath)
  }
  for (const binding of manifest.resourceBindings) {
    stringValue(binding.resourceId, "binding_resource_id")
    stringValue(binding.capabilityId, "binding_capability_id")
  }
  if (manifest.source?.path) safeRelativePath(manifest.source.path)
  return manifest
}

function parseManifest(value: unknown): BotPackageManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BOT_PACKAGE_MANIFEST_INVALID")
  const source = value as Record<string, unknown>
  verifyManifestDigest(source)
  if (source.packageType !== "BOT" && source.package_type !== "BOT") throw new Error("BOT_PACKAGE_TYPE_INVALID")
  const profile = source.profile as Record<string, unknown> | undefined
  const skills = Array.isArray(source.skills) ? source.skills : []
  const plugins = Array.isArray(source.plugins) ? source.plugins : []
  const resourceBindings = Array.isArray(source.resourceBindings) ? source.resourceBindings : Array.isArray(source.resource_bindings) ? source.resource_bindings : []
  return validateBotPackageManifest({
    packageType: "BOT",
    resourceId: stringValue(source.resourceId ?? source.resource_id, "resource_id"),
    version: stringValue(source.version, "version"),
    profile: {
      title: stringValue(profile?.title, "profile_title"),
      description: stringValue(profile?.description, "profile_description"),
      avatar: profile?.avatar ?? { shape: "cercle", color: "turquoise", expression: "neutre" },
    },
    skills: skills.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BOT_PACKAGE_SKILL_INVALID")
      const item = value as Record<string, unknown>
      return { id: stringValue(item.id, "skill_id"), path: safeRelativePath(stringValue(item.path, "skill_path")), ...(typeof item.digest === "string" ? { digest: item.digest } : {}) }
    }),
    plugins: plugins.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BOT_PACKAGE_PLUGIN_INVALID")
      const item = value as Record<string, unknown>
      return {
        name: stringValue(item.name, "plugin_name"),
        ...(typeof item.marketplace === "string" ? { marketplace: item.marketplace } : {}),
        ...(typeof (item.marketplacePath ?? item.marketplace_path) === "string" ? { marketplacePath: safeRelativePath(String(item.marketplacePath ?? item.marketplace_path)) } : {}),
        ...(typeof item.digest === "string" ? { digest: item.digest } : {}),
      }
    }),
    resourceBindings: resourceBindings.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BOT_PACKAGE_BINDING_INVALID")
      const item = value as Record<string, unknown>
      return { resourceId: stringValue(item.resourceId ?? item.resource_id, "binding_resource_id"), capabilityId: stringValue(item.capabilityId ?? item.capability_id, "binding_capability_id") }
    }),
    defaultRuntimeTier: source.defaultRuntimeTier === "headless" || source.default_runtime_tier === "headless" ? "headless" : source.defaultRuntimeTier === "desktop" || source.default_runtime_tier === "desktop" ? "desktop" : "none",
    modelRoute: source.modelRoute === "genio-gateway" || source.model_route === "genio-gateway" ? "genio-gateway" : "codex-subscription",
    manifestDigest: stringValue(source.manifestDigest ?? source.manifest_digest, "manifest_digest"),
    artifactDigest: stringValue(source.artifactDigest ?? source.artifact_digest, "artifact_digest"),
    source: source.source && typeof source.source === "object" ? {
      kind: (source.source as Record<string, unknown>).kind === "GITHUB" || (source.source as Record<string, unknown>).kind === "UPLOAD" ? (source.source as Record<string, unknown>).kind as "GITHUB" | "UPLOAD" : "FIXTURE",
      ref: stringValue((source.source as Record<string, unknown>).ref, "source_ref"),
      ...((source.source as Record<string, unknown>).path ? { path: safeRelativePath(String((source.source as Record<string, unknown>).path)) } : {}),
    } : undefined,
  })
}

function publicManifest(resolved: ResolvedBotPackage) {
  return structuredClone(resolved.manifest)
}

export function loadBotPackages(environment: NodeJS.ProcessEnv = process.env): ResolvedBotPackage[] {
  const configured = environment.GENIO_BOT_PACKAGE_CATALOG?.trim() || environment.GENIO_BOT_DEMO_CATALOG?.trim()
  const bundled = resolve(import.meta.dir, "../demo/catalog.json")
  if (!configured && !existsSync(bundled)) return []
  const filePath = configured ? resolve(configured) : bundled
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown
  const values = Array.isArray(raw) ? raw : [raw]
  return values.map((value) => ({ manifest: parseManifest(value), artifactRoot: dirname(filePath) }))
}

export function packageCatalog(resolved: ResolvedBotPackage[]) {
  return resolved.map(publicManifest)
}

function treeDigest(root: string) {
  const hash = createHash("sha256")
  const visit = (path: string, relative: string) => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error("BOT_PACKAGE_ARTIFACT_SYMLINK")
    if (stat.isDirectory()) {
      hash.update("directory\0")
      hash.update(relative)
      hash.update("\0")
      for (const name of readdirSync(path).sort()) visit(resolve(path, name), relative ? `${relative}/${name}` : name)
      return
    }
    if (!stat.isFile()) throw new Error("BOT_PACKAGE_ARTIFACT_ENTRY_INVALID")
    hash.update("file\0")
    hash.update(relative)
    hash.update("\0")
    hash.update(String(stat.size))
    hash.update("\0")
    hash.update(readFileSync(path))
  }
  visit(root, "")
  return hash.digest("hex")
}

function resolveArtifactSource(resolved: ResolvedBotPackage) {
  if (!resolved.artifactRoot || !existsSync(resolved.artifactRoot)) throw new Error("BOT_PACKAGE_ARTIFACT_NOT_FOUND")
  const artifactRoot = resolve(resolved.artifactRoot)
  const sourcePath = resolved.manifest.source?.path ? resolve(artifactRoot, safeRelativePath(resolved.manifest.source.path)) : artifactRoot
  if (!sourcePath.startsWith(`${artifactRoot}/`) && sourcePath !== artifactRoot) throw new Error("BOT_PACKAGE_PATH_INVALID")
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) throw new Error("BOT_PACKAGE_ARTIFACT_NOT_FOUND")
  if (resolved.manifest.artifactDigest !== treeDigest(sourcePath)) throw new Error("BOT_PACKAGE_ARTIFACT_DIGEST_MISMATCH")
  return sourcePath
}

function verifyMaterializedArtifact(root: string, resolved: ResolvedBotPackage) {
  if (resolved.manifest.artifactDigest !== treeDigest(root)) throw new Error("BOT_PACKAGE_ARTIFACT_DIGEST_MISMATCH")
  for (const skill of resolved.manifest.skills) {
    const skillRoot = resolve(root, safeRelativePath(skill.path))
    if (!skillRoot.startsWith(`${root}/`) || !existsSync(skillRoot)) throw new Error("BOT_PACKAGE_SKILL_NOT_FOUND")
    if (!existsSync(resolve(skillRoot, "SKILL.md"))) throw new Error("BOT_PACKAGE_SKILL_DESCRIPTOR_NOT_FOUND")
    if (skill.digest && skill.digest !== treeDigest(skillRoot)) throw new Error("BOT_PACKAGE_SKILL_DIGEST_MISMATCH")
  }
  for (const plugin of resolved.manifest.plugins) {
    if (!plugin.digest) continue
    if (!plugin.marketplacePath) throw new Error("BOT_PACKAGE_PLUGIN_DIGEST_SOURCE_REQUIRED")
    const marketplacePath = resolve(root, safeRelativePath(plugin.marketplacePath))
    if (!marketplacePath.startsWith(`${root}/`) || !existsSync(marketplacePath)) throw new Error("BOT_PACKAGE_MARKETPLACE_NOT_FOUND")
    const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8")) as { plugins?: Array<{ name?: unknown; source?: { path?: unknown } }> }
    const entry = marketplace.plugins?.find((candidate) => candidate?.name === plugin.name)
    const relativePath = typeof entry?.source?.path === "string" ? entry.source.path.replace(/^\.\//, "") : ""
    if (!relativePath) throw new Error("BOT_PACKAGE_PLUGIN_NOT_FOUND")
    const marketplaceRoot = marketplacePath === resolve(root, ".agents/plugins/marketplace.json") ? root : dirname(marketplacePath)
    const pluginPath = resolve(marketplaceRoot, safeRelativePath(relativePath))
    if (!pluginPath.startsWith(`${root}/`) || !existsSync(pluginPath)) throw new Error("BOT_PACKAGE_PLUGIN_NOT_FOUND")
    if (plugin.digest !== treeDigest(pluginPath)) throw new Error("BOT_PACKAGE_PLUGIN_DIGEST_MISMATCH")
  }
}

export function verifyBotPackageArtifact(resolved: ResolvedBotPackage) {
  const sourcePath = resolveArtifactSource(resolved)
  verifyMaterializedArtifact(sourcePath, resolved)
}

export function materializeBotPackage(
  resolved: ResolvedBotPackage,
  botId: string,
  destinationRoot = process.env.GENIO_BOT_PACKAGE_STORE?.trim() || resolve(import.meta.dir, "../.local/bot-packages"),
) {
  const root = resolve(destinationRoot, safeSegment(botId, "bot_id"), safeSegment(resolved.manifest.resourceId, "resource_id"), safeSegment(resolved.manifest.version, "version"))
  mkdirSync(root, { recursive: true })
  if (resolved.artifactRoot && existsSync(resolved.artifactRoot)) {
    const sourcePath = resolveArtifactSource(resolved)
    verifyMaterializedArtifact(sourcePath, resolved)
    cpSync(sourcePath, root, { recursive: true, force: true })
  } else if (resolved.manifest.skills.length > 0) {
    const allPresent = resolved.manifest.skills.every((skill) => {
      const path = resolve(root, safeRelativePath(skill.path))
      return (path.startsWith(`${root}/`) || path === root) && existsSync(path)
    })
    if (!allPresent) {
      throw new Error("BOT_PACKAGE_ARTIFACT_NOT_FOUND")
    }
  }
  verifyMaterializedArtifact(root, resolved)
  const skillRoots = resolved.manifest.skills.map((skill) => {
    const path = resolve(root, safeRelativePath(skill.path))
    if (!path.startsWith(`${root}/`) && path !== root) throw new Error("BOT_PACKAGE_PATH_INVALID")
    if (!existsSync(path)) throw new Error("BOT_PACKAGE_SKILL_NOT_MATERIALIZED")
    return path
  })
  const plugins: MaterializedBotPlugin[] = resolved.manifest.plugins.map((plugin) => {
    const marketplacePath = plugin.marketplacePath ? resolve(root, safeRelativePath(plugin.marketplacePath)) : undefined
    if (marketplacePath && (!marketplacePath.startsWith(`${root}/`) || !existsSync(marketplacePath))) throw new Error("BOT_PACKAGE_MARKETPLACE_NOT_FOUND")
    return { ...plugin, ...(marketplacePath ? { marketplacePath } : {}) }
  })
  return { root, skillRoots, plugins }
}

export function packageDigest(path: string) {
  const hash = createHash("sha256")
  if (existsSync(path)) hash.update(readFileSync(path))
  return hash.digest("hex")
}
