import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { dirname, relative, resolve, sep } from "node:path"

export interface HandsAsset {
  path: string
  content: ArrayBuffer
}

export const HANDS_PLUGIN_ROOT = "/home/user/.genio/plugins"
const MAX_FILES = 64
const MAX_BYTES = 2 * 1024 * 1024
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/
const SEGMENT = { test: (value: string) => SEGMENT_PATTERN.test(value) && value !== "." && value !== ".." }

interface MaterializedPlugins {
  root: string
  plugins: Array<{ name: string; marketplacePath?: string }>
}

function inside(root: string, path: string) {
  return path === root || path.startsWith(`${root}${sep}`)
}

function localPluginDirectory(packageRoot: string, marketplacePath: string, name: string) {
  const root = resolve(packageRoot)
  const resolvedMarketplacePath = resolve(marketplacePath)
  if (!inside(root, resolvedMarketplacePath)) throw new Error("HANDS_ASSET_PATH_INVALID")
  const marketplace = JSON.parse(readFileSync(resolvedMarketplacePath, "utf8")) as { plugins?: Array<{ name?: string; source?: { source?: string; path?: string } }> }
  const entry = marketplace.plugins?.find((plugin) => plugin.name === name)
  if (entry?.source?.source !== "local" || typeof entry.source.path !== "string") return null
  const marketplaceRoot = resolvedMarketplacePath === resolve(root, ".agents/plugins/marketplace.json") ? root : dirname(resolvedMarketplacePath)
  const directory = resolve(marketplaceRoot, entry.source.path)
  if (!inside(root, directory)) throw new Error("HANDS_ASSET_PATH_INVALID")
  return directory
}

export function collectHandsAssets(materialized: MaterializedPlugins): HandsAsset[] {
  const assets: HandsAsset[] = []
  let bytes = 0
  for (const plugin of materialized.plugins) {
    if (!plugin.marketplacePath || !SEGMENT.test(plugin.name)) continue
    const directory = localPluginDirectory(materialized.root, plugin.marketplacePath, plugin.name)
    if (!directory) continue
    const handsRoot = resolve(directory, "hands")
    let rootStat
    try { rootStat = lstatSync(handsRoot) } catch { continue }
    if (!rootStat.isDirectory()) throw new Error("HANDS_ASSET_PATH_INVALID")
    const walk = (current: string) => {
      for (const name of readdirSync(current).sort()) {
        const path = resolve(current, name)
        const stat = lstatSync(path)
        if (stat.isSymbolicLink() || !inside(handsRoot, path)) throw new Error("HANDS_ASSET_PATH_INVALID")
        if (stat.isDirectory()) { walk(path); continue }
        if (!stat.isFile()) continue
        const segments = relative(handsRoot, path).split(sep)
        if (!segments.every((segment) => SEGMENT.test(segment))) throw new Error("HANDS_ASSET_PATH_INVALID")
        bytes += stat.size
        if (assets.length >= MAX_FILES || bytes > MAX_BYTES) throw new Error("HANDS_ASSET_LIMIT_EXCEEDED")
        assets.push({ path: [plugin.name, ...segments].join("/"), content: Uint8Array.from(readFileSync(path)).buffer })
      }
    }
    walk(handsRoot)
  }
  return assets
}
