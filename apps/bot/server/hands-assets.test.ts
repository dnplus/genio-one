import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { collectHandsAssets } from "./hands-assets"

function pluginPackage(sourcePath = "./plugins/tool", marketplacePath = ".agents/plugins/marketplace.json") {
  const root = mkdtempSync(join(tmpdir(), "hands-assets-"))
  mkdirSync(resolve(root, marketplacePath, ".."), { recursive: true })
  writeFileSync(resolve(root, marketplacePath), JSON.stringify({ name: "m", plugins: [{ name: "tool", source: { source: "local", path: sourcePath } }] }))
  mkdirSync(join(root, "plugins/tool/hands/bin"), { recursive: true })
  mkdirSync(join(root, "plugins/tool/skills/use"), { recursive: true })
  writeFileSync(join(root, "plugins/tool/skills/use/SKILL.md"), "host-side skill")
  writeFileSync(join(root, "plugins/tool/hands/bin/tool.mjs"), "console.log(1)")
  return { root, materialized: { root, plugins: [{ name: "tool", marketplacePath: resolve(root, marketplacePath) }] } }
}

describe("plugin hands assets", () => {
  test("copies only the plugin's hands directory into the sandbox layout", () => {
    const { materialized } = pluginPackage()

    expect(collectHandsAssets(materialized).map((asset) => ({ ...asset, content: Buffer.from(asset.content).toString() }))).toEqual([{ path: "tool/bin/tool.mjs", content: "console.log(1)" }])
  })

  test("resolves a local source relative to a marketplace outside the default location", () => {
    const { root, materialized } = pluginPackage("./tool", "catalog/custom-marketplace.json")
    mkdirSync(join(root, "catalog/tool/hands/bin"), { recursive: true })
    writeFileSync(join(root, "catalog/tool/hands/bin/custom.mjs"), "console.log('custom')")

    expect(collectHandsAssets(materialized).map((asset) => asset.path)).toEqual(["tool/bin/custom.mjs"])
  })

  test("preserves binary hands asset bytes", () => {
    const { root, materialized } = pluginPackage()
    const bytes = Buffer.from([0, 255, 1, 254, 2])
    writeFileSync(join(root, "plugins/tool/hands/bin/tool.bin"), bytes)

    const asset = collectHandsAssets(materialized).find((candidate) => candidate.path === "tool/bin/tool.bin")
    expect(asset).toBeDefined()
    expect(Buffer.from(asset!.content)).toEqual(bytes)
  })

  test("refuses symlinks, which could pull host files such as credentials into the sandbox", () => {
    const { root, materialized } = pluginPackage()
    symlinkSync("/etc/hosts", join(root, "plugins/tool/hands/bin/hosts"))

    expect(() => collectHandsAssets(materialized)).toThrow("HANDS_ASSET_PATH_INVALID")
  })

  test("refuses a marketplace source outside the package root", () => {
    const { materialized } = pluginPackage("../../outside")

    expect(() => collectHandsAssets(materialized)).toThrow("HANDS_ASSET_PATH_INVALID")
  })

  test("bounds what a plugin can place in the sandbox", () => {
    const { root, materialized } = pluginPackage()
    writeFileSync(resolve(root, "plugins/tool/hands/bin/big.mjs"), "x".repeat(2 * 1024 * 1024 + 1))

    expect(() => collectHandsAssets(materialized)).toThrow("HANDS_ASSET_LIMIT_EXCEEDED")
  })

  test("ignores plugins without hands assets", () => {
    expect(collectHandsAssets({ root: "/tmp/package", plugins: [{ name: "remote-only" }] })).toEqual([])
  })
})
