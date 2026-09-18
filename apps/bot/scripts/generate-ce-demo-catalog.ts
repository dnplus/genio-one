import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { CE_DEMO_RESOURCE_IDS, CE_DEMO_VERSION } from "../../../packages/protocol/src/ce-demo"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function digestTree(root: string): string {
  const hash = createHash("sha256")
  const visit = (path: string, relative: string) => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`CE_DEMO_ARTIFACT_SYMLINK:${relative}`)
    if (stat.isDirectory()) {
      hash.update("directory\0")
      hash.update(relative)
      hash.update("\0")
      for (const name of readdirSync(path).sort()) visit(resolve(path, name), relative ? `${relative}/${name}` : name)
      return
    }
    if (!stat.isFile()) throw new Error(`CE_DEMO_ARTIFACT_ENTRY_INVALID:${relative}`)
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

function manifestDigest(manifest: Record<string, JsonValue>): string {
  const { manifest_digest: _manifestDigest, manifestDigest: _camelManifestDigest, ...unsigned } = manifest
  return createHash("sha256").update(canonical(unsigned)).digest("hex")
}

const demoRoot = resolve(import.meta.dir, "../demo")
const packageRoot = resolve(demoRoot, "package")
const artifactDigest = digestTree(packageRoot)
const archifyDigest = digestTree(resolve(packageRoot, "skills/archify"))
const productManagementDigest = digestTree(resolve(packageRoot, "plugins/product-management"))

const common = {
  package_type: "BOT",
  version: CE_DEMO_VERSION,
  source: { kind: "UPLOAD", ref: "ce-demo-bundle", path: "package" },
  resource_bindings: [],
  default_runtime_tier: "none",
  artifact_digest: artifactDigest,
} satisfies Record<string, JsonValue>

const manifests = [
  {
    ...common,
    resource_id: CE_DEMO_RESOURCE_IDS.bot,
    profile: {
      title: "CE 文件與規格 Bot",
      description: "查詢技術文件、整理產品規格並建立架構圖。",
      avatar: { shape: "cercle", color: "turquoise", expression: "neutre" },
    },
    skills: [{ id: "archify", path: "skills/archify", digest: archifyDigest }],
    plugins: [{ name: "product-management", marketplace: "personal", marketplace_path: ".agents/plugins/marketplace.json", digest: productManagementDigest }],
    model_route: "codex-subscription",
  },
  {
    ...common,
    resource_id: CE_DEMO_RESOURCE_IDS.geminiBot,
    profile: {
      title: "CE 訪談整理 Bot",
      description: "用受管 Gemini 路線整理訪談，保留未知事項。",
      avatar: { shape: "cercle", color: "violet", expression: "neutre" },
    },
    skills: [],
    plugins: [],
    model_route: "genio-gateway",
  },
].map((manifest) => ({ ...manifest, manifest_digest: manifestDigest(manifest) }))

const output = `${JSON.stringify(manifests, null, 2)}\n`
writeFileSync(resolve(demoRoot, "catalog.json"), output)
writeFileSync(resolve(import.meta.dir, "../../../packages/protocol/src/ce-demo-package.json"), output)
