import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import botPackage from "../package.json"
import upstream from "../codex-upstream.json"
import { CODEX_VERSION } from "../shared/codex-version"
import { DEFAULT_CODEX_VERSION } from "./e2b-self-host"

test("package runtime defaults, upstream provenance and release-age exceptions select the same exact Codex release", () => {
  const version = botPackage.devDependencies["@openai/codex"]
  expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  expect(CODEX_VERSION).toBe(version)
  expect(DEFAULT_CODEX_VERSION).toBe(version)
  expect(upstream.cliVersion).toBe(version)
  expect(upstream.tag).toBe(`rust-v${version}`)
  expect(upstream.commit).toMatch(/^[0-9a-f]{40}$/)
  const root = resolve(import.meta.dir, "../../..")
  const variants = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]
  const exception = `@openai/codex@${[...variants.map((platform) => `${version}-${platform}`), version].join(" || ")}`
  for (const path of ["pnpm-workspace.yaml", "tooling/oss-export.mjs"]) expect(readFileSync(resolve(root, path), "utf8")).toContain(exception)
  const lock = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8")
  for (const suffix of [version, ...variants.map((platform) => `${version}-${platform}`)]) expect(lock).toContain(`'@openai/codex@${suffix}':`)
})
