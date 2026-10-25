import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

function files(directory: string, prefix = ""): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name)
    return entry.isDirectory() ? files(directory, path) : [path]
  }).sort()
}

const temporary = mkdtempSync(join(tmpdir(), "genio-codex-protocol-"))
try {
  const binary = resolve(import.meta.dir, "../node_modules/.bin/codex")
  const generated = resolve(import.meta.dir, "../server/generated")
  const result = spawnSync(binary, ["app-server", "generate-ts", "--experimental", "--out", temporary], { encoding: "utf8", timeout: 120_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`protocol generation failed: ${result.stderr}`)
  const expected = files(generated)
  const actual = files(temporary)
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Codex protocol filenames drifted; regenerate the complete tree")
  const changed = actual.filter((path) => !readFileSync(join(temporary, path)).equals(readFileSync(join(generated, path))))
  if (changed.length) throw new Error(`Codex protocol bytes drifted: ${changed.join(", ")}`)
  console.info(`Codex protocol matches package generator (${actual.length} files)`)
} finally { rmSync(temporary, { recursive: true, force: true }) }
