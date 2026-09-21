import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { loadBotPackages, materializeBotPackage, validateBotPackageManifest } from "./bot-package-store"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function lexicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(lexicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${lexicalJson(value[key]!)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

describe("Bot package store", () => {
  test("loads the bundled catalog unless an explicit catalog overrides it", () => {
    expect(loadBotPackages({}).map((entry) => entry.manifest.resourceId)).toEqual(["genio.demo.bot", "genio.demo.gemini-bot"])
    expect(loadBotPackages({ NODE_ENV: "production" }).map((entry) => entry.manifest.resourceId)).toEqual(["genio.demo.bot", "genio.demo.gemini-bot"])
  })

  test("rejects path traversal in a package manifest", () => {
    expect(() => validateBotPackageManifest({
      packageType: "BOT",
      resourceId: "fixture",
      version: "1.0.0",
      profile: { title: "Fixture", description: "Fixture", avatar: {} },
      skills: [{ id: "unsafe", path: "../outside" }],
      plugins: [],
      resourceBindings: [],
      defaultRuntimeTier: "none",
      manifestDigest: "manifest",
      artifactDigest: "artifact",
    })).toThrow("BOT_PACKAGE_PATH_INVALID")
  })

  test("materializes the bundled package idempotently after verifying every digest", () => {
    const destination = mkdtempSync(join(tmpdir(), "genio-bot-package-store-"))
    try {
      const catalog = resolve(import.meta.dir, "../demo/catalog.json")
      const resolved = loadBotPackages({ GENIO_BOT_PACKAGE_CATALOG: catalog })[0]!
      const first = materializeBotPackage(resolved, "bot-package-test", destination)
      const second = materializeBotPackage(resolved, "bot-package-test", destination)
      expect(second).toEqual(first)
      expect(first.plugins[0]?.marketplacePath).toBe(join(first.root, ".agents/plugins/marketplace.json"))
    } finally {
      rmSync(destination, { recursive: true, force: true })
    }
  })

  test("rejects an artifact whose local contents no longer match its published digest", () => {
    const workspace = mkdtempSync(join(tmpdir(), "genio-bot-package-tampered-"))
    try {
      const source = resolve(import.meta.dir, "../demo")
      const copied = join(workspace, "demo")
      cpSync(source, copied, { recursive: true })
      writeFileSync(join(copied, "package/README.md"), "tampered")
      const resolved = loadBotPackages({ GENIO_BOT_PACKAGE_CATALOG: join(copied, "catalog.json") })[0]!
      expect(() => materializeBotPackage(resolved, "bot-package-tampered", join(workspace, "store"))).toThrow("BOT_PACKAGE_ARTIFACT_DIGEST_MISMATCH")
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  test("rejects catalog metadata whose canonical manifest digest no longer matches", () => {
    const workspace = mkdtempSync(join(tmpdir(), "genio-bot-package-manifest-"))
    try {
      const catalog = resolve(import.meta.dir, "../demo/catalog.json")
      const copied = join(workspace, "catalog.json")
      const manifests = JSON.parse(readFileSync(catalog, "utf8")) as Array<{ profile: { title: string } }>
      manifests[0]!.profile.title = "tampered"
      writeFileSync(copied, JSON.stringify(manifests))
      expect(() => loadBotPackages({ GENIO_BOT_PACKAGE_CATALOG: copied })).toThrow("BOT_PACKAGE_MANIFEST_DIGEST_MISMATCH")
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  test("accepts numeric extension fields signed by the existing lexical serializer", () => {
    const workspace = mkdtempSync(join(tmpdir(), "genio-bot-package-numeric-extension-"))
    try {
      const catalog = resolve(import.meta.dir, "../demo/catalog.json")
      const copied = join(workspace, "catalog.json")
      const manifests = JSON.parse(readFileSync(catalog, "utf8")) as Array<Record<string, JsonValue>>
      const manifest = manifests[0]!
      manifest.extensions = { 2: "two", 10: "ten" }
      const { manifest_digest: _manifestDigest, ...unsigned } = manifest
      manifest.manifest_digest = createHash("sha256").update(lexicalJson(unsigned)).digest("hex")
      writeFileSync(copied, JSON.stringify(manifests))
      expect(loadBotPackages({ GENIO_BOT_PACKAGE_CATALOG: copied }).map((entry) => entry.manifest.resourceId)).toEqual(["genio.demo.bot", "genio.demo.gemini-bot"])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
