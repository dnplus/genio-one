import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupInactiveOtelSpools } from "./otlp-spool-cleanup"

test("inactive destination cleanup preserves active queues and unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "otel-cleanup-"))
  const inactive = "a".repeat(16), active = "b".repeat(16), link = "c".repeat(16)
  const now = Date.now(), expired = `${now - 7300000}-aaaa.json`
  try {
    for (const directory of [inactive, active, "unrelated"]) { await mkdir(join(root, directory)); await writeFile(join(root, directory, expired), "evidence") }
    await symlink(join(root, "unrelated"), join(root, link))
    const result = await cleanupInactiveOtelSpools(root, new Set([active]), now)
    assert.equal(result.removed, 1)
    assert.equal(await readFile(join(root, active, expired), "utf8"), "evidence")
    assert.equal(await readFile(join(root, "unrelated", expired), "utf8"), "evidence")
  } finally { await rm(root, { recursive: true, force: true }) }
})
