import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { saveVerificationReceipt, verifyLocalCeState } from "./ce-verify.mjs"

function temporaryDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test("writes a verification receipt atomically inside a real CE .local directory", async () => {
  const outDir = temporaryDirectory("genioone-ce-verify-")
  try {
    const receipt = { schema_version: 1, status: "RUNNING", steps: [] }
    const receiptPath = await saveVerificationReceipt(outDir, receipt)
    assert.equal(receiptPath, join(outDir, ".local", "ce-verification.json"))
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), receipt)

    const completed = { ...receipt, status: "PASS" }
    await saveVerificationReceipt(outDir, completed)
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), completed)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test("refuses a symlinked .local directory without writing outside CE", async () => {
  const outDir = temporaryDirectory("genioone-ce-verify-")
  const outside = temporaryDirectory("genioone-ce-outside-")
  try {
    symlinkSync(outside, join(outDir, ".local"))
    await assert.rejects(saveVerificationReceipt(outDir, { status: "RUNNING" }), /\.local directory must be a real directory/)
    assert.equal(existsSync(join(outside, "ce-verification.json")), false)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("refuses a symlinked receipt and leaves its external target untouched", async () => {
  const outDir = temporaryDirectory("genioone-ce-verify-")
  const outside = temporaryDirectory("genioone-ce-outside-")
  try {
    await mkdir(join(outDir, ".local"))
    const externalReceipt = join(outside, "external-receipt.json")
    writeFileSync(externalReceipt, "outside\n")
    symlinkSync(externalReceipt, join(outDir, ".local", "ce-verification.json"))
    await assert.rejects(saveVerificationReceipt(outDir, { status: "RUNNING" }), /receipt must be a regular file/)
    assert.equal(readFileSync(externalReceipt, "utf8"), "outside\n")
  } finally {
    rmSync(outDir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("verifies managed CE files against the exported sync state", async () => {
  const outDir = temporaryDirectory("genioone-ce-verify-")
  try {
    const path = join(outDir, "managed.txt")
    const content = "managed\n"
    writeFileSync(path, content)
    chmodSync(path, 0o644)
    writeFileSync(join(outDir, ".genioone-ce-sync-state.json"), JSON.stringify({
      schema: 2,
      files: {
        "managed.txt": {
          sha256: createHash("sha256").update(content).digest("hex"),
          mode: 0o644,
        },
      },
    }))
    await verifyLocalCeState(outDir)
    writeFileSync(path, "changed\n")
    await assert.rejects(verifyLocalCeState(outDir), /differs from sync state/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
