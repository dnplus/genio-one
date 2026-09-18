import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadBotPackages, materializeBotPackage } from "../server/bot-package-store"
import { createJsonLineCollector } from "../server/jsonl"

const root = mkdtempSync(join(tmpdir(), "genio-ce-native-"))
const codexHome = join(root, "codex-home")
mkdirSync(codexHome)
const packageInfo = loadBotPackages().find((candidate) => candidate.manifest.resourceId === "genio.demo.bot")

if (!packageInfo) throw new Error("CE_DEMO_PACKAGE_NOT_FOUND")

const materialized = materializeBotPackage(packageInfo, "native-package-check", join(root, "packages"))
const child = spawn(process.env.GENIO_BOT_CODEX_BIN?.trim() || "codex", ["app-server", "-c", "analytics.enabled=false", "-c", "features.memories=false"], {
  cwd: materialized.root,
  env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: codexHome },
  stdio: ["pipe", "pipe", "pipe"],
})

const pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>()
let nextId = 1
let stderr = ""
const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
  const id = nextId++
  const timeout = setTimeout(() => {
    pending.delete(id)
    reject(new Error(`${method}: timeout`))
  }, 30_000)
  pending.set(id, {
    resolve(value) { clearTimeout(timeout); resolve(value) },
    reject(reason) { clearTimeout(timeout); reject(reason) },
  })
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
})

child.stdout.on("data", createJsonLineCollector((line) => {
  const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }
  if (typeof message.id !== "number") return
  const call = pending.get(message.id)
  if (!call) return
  pending.delete(message.id)
  if (message.error) call.reject(new Error(JSON.stringify(message.error)))
  else call.resolve(message.result)
}))
child.stderr.on("data", (chunk) => { stderr += chunk.toString() })

try {
  await request("initialize", {
    clientInfo: { name: "genio-one-ce-native-package-check", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  })
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`)
  await request("skills/extraRoots/set", { extraRoots: materialized.skillRoots })
  const skills = await request("skills/list", { cwds: [materialized.root], forceReload: true }) as { data?: Array<{ skills?: Array<{ name?: string; path?: string | null; enabled?: boolean }> }> }
  const archify = skills.data?.flatMap((entry) => entry.skills ?? []).find((skill) => skill.name === "archify")
  if (!archify?.enabled || archify.path !== realpathSync(join(materialized.skillRoots[0]!, "SKILL.md"))) throw new Error("ARCHIFY_SKILL_NOT_ROUTABLE")
  const plugin = materialized.plugins.find((candidate) => candidate.name === "product-management")
  if (!plugin?.marketplacePath) throw new Error("PRODUCT_MANAGEMENT_MARKETPLACE_NOT_MATERIALIZED")
  await request("plugin/install", {
    pluginName: plugin.name,
    marketplacePath: plugin.marketplacePath,
  })
  const plugins = await request("plugin/list", { cwds: [materialized.root] }) as { marketplaces?: Array<{ plugins?: Array<{ name?: string; installed?: boolean; skills?: Array<{ name?: string }> }> }> }
  const productManagement = plugins.marketplaces?.flatMap((marketplace) => marketplace.plugins ?? []).find((candidate) => candidate.name === "product-management")
  if (!productManagement?.installed) throw new Error("PRODUCT_MANAGEMENT_PLUGIN_NOT_INSTALLED")
  const refreshedSkills = await request("skills/list", { cwds: [materialized.root], forceReload: true }) as { data?: Array<{ skills?: Array<{ name?: string; enabled?: boolean }> }> }
  const writeSpec = refreshedSkills.data?.flatMap((entry) => entry.skills ?? []).find((skill) => skill.name === "product-management:write-spec")
  if (!writeSpec?.enabled) throw new Error("PRODUCT_MANAGEMENT_WRITE_SPEC_NOT_ROUTABLE")
  const pluginDetail = await request("plugin/read", { pluginName: plugin.name, marketplacePath: plugin.marketplacePath }) as { plugin?: { skills?: Array<{ name?: string }> } }
  if (!pluginDetail.plugin?.skills?.some((skill) => skill.name === "product-management:write-spec")) throw new Error("PRODUCT_MANAGEMENT_WRITE_SPEC_NOT_VISIBLE")
  console.log(JSON.stringify({
    event: "ce_demo.native_package_verified",
    codex_version: process.env.GENIO_BOT_CODEX_BIN?.trim() || "codex",
    skills: ["archify", "write-spec"],
    plugin: "product-management",
  }))
} finally {
  for (const call of pending.values()) call.reject(new Error("app-server stopped"))
  child.kill("SIGTERM")
  rmSync(root, { recursive: true, force: true })
  if (stderr.trim()) process.stderr.write(stderr)
}
