import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const requiredBunVersion = "1.4.2"
const requiredTypeScriptVersion = "7.0.2"
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const appsRoot = resolve(appRoot, "..")

assert.ok(globalThis.Bun, "GenioOne tooling must run with Bun")
assert.equal(Bun.version, requiredBunVersion, `Bun ${requiredBunVersion} is required`)

for (const entry of await readdir(appsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue

  const manifestPath = join(appsRoot, entry.name, "package.json")
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") continue
    throw error
  }

  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  }
  if (dependencies.typescript !== undefined) {
    assert.equal(
      dependencies.typescript,
      requiredTypeScriptVersion,
      `${entry.name} must use TypeScript ${requiredTypeScriptVersion}`,
    )
  }
  assert.equal(
    dependencies["@typescript/typescript6"],
    undefined,
    `${entry.name} must not retain the TypeScript 6 compiler alias`,
  )
}

console.log(`Toolchain verified: Bun ${Bun.version}, TypeScript ${requiredTypeScriptVersion}.`)
