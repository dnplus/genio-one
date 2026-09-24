import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { secureWorkspaceFileScript } from "./e2b-hands"

test("E2B workspace file adapter rejects parent and leaf symlinks that leave the owned root", () => {
  const base = mkdtempSync(join(tmpdir(), "genio-e2b-files-"))
  const workspace = join(base, "workspace")
  const outside = join(base, "outside")
  mkdirSync(workspace)
  mkdirSync(outside)
  writeFileSync(join(outside, "secret.txt"), "outside")
  writeFileSync(join(workspace, "inside.txt"), "inside")
  symlinkSync(outside, join(workspace, "parent-link"))
  symlinkSync(join(outside, "secret.txt"), join(workspace, "leaf-link"))
  const run = (path: string, mode: "read" | "write", temporary: string) => execFileSync("python3", ["-c", secureWorkspaceFileScript, workspace, path, mode, temporary], { stdio: "pipe" })
  try {
    expect(() => run("parent-link/secret.txt", "read", join(base, "parent-output"))).toThrow()
    expect(() => run("leaf-link", "read", join(base, "leaf-output"))).toThrow()
    writeFileSync(join(base, "input"), "changed")
    expect(() => run("parent-link/secret.txt", "write", join(base, "input"))).toThrow()
    expect(() => run("leaf-link", "write", join(base, "input"))).toThrow()
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside")
    run("inside.txt", "read", join(base, "valid-output"))
    expect(readFileSync(join(base, "valid-output"), "utf8")).toBe("inside")
  } finally { rmSync(base, { recursive: true, force: true }) }
})
