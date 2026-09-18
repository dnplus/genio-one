import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { envoyAigwVersion, installLocalAigw } from "./install-local-aigw.mjs"

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}

async function fixtureApp() {
  const root = await mkdtemp(join(tmpdir(), "genio-one-local-aigw-"))
  const versionsPath = join(root, "config/ai-mcp-gateway/provider-versions.env")
  await mkdir(join(root, "config/ai-mcp-gateway"), { recursive: true })
  await writeFile(versionsPath, "ENVOY_AI_GATEWAY_VERSION=v1.1.0\n")
  return { root, versionsPath }
}

test("local AIGW installer verifies the pinned release digest and updates the current pointer", async () => {
  const { root, versionsPath } = await fixtureApp()
  const binary = Buffer.from("official-aigw-binary")
  const expectedDigest = digest(binary)
  const requests = []
  try {
    const installed = await installLocalAigw({
      appRoot: root,
      versionsPath,
      platform: "linux",
      arch: "x64",
      async fetchImplementation(url) {
        requests.push(String(url))
        if (String(url).startsWith("https://api.github.com/")) {
          return new Response(JSON.stringify({ assets: [{
            name: "aigw-linux-amd64",
            browser_download_url: "https://downloads.example/aigw-linux-amd64",
            digest: `sha256:${expectedDigest}`,
          }] }))
        }
        return new Response(binary)
      },
    })

    assert.equal(installed.version, "v1.1.0")
    assert.equal(await readFile(installed.binaryPath, "utf8"), "official-aigw-binary")
    assert.equal((await lstat(join(root, ".local/aigw/current"))).isSymbolicLink(), true)
    assert.equal(requests.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("local AIGW installer removes an unverified download and fails closed", async () => {
  const { root, versionsPath } = await fixtureApp()
  try {
    await assert.rejects(
      installLocalAigw({
        appRoot: root,
        versionsPath,
        platform: "linux",
        arch: "x64",
        async fetchImplementation(url) {
          if (String(url).startsWith("https://api.github.com/")) {
            return new Response(JSON.stringify({ assets: [{
              name: "aigw-linux-amd64",
              browser_download_url: "https://downloads.example/aigw-linux-amd64",
              digest: `sha256:${digest("expected")}`,
            }] }))
          }
          return new Response("tampered")
        },
      }),
      /Digest mismatch/,
    )
    await assert.rejects(readFile(join(root, ".local/aigw/v1.1.0/aigw.download")), { code: "ENOENT" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("provider versions require an exact Envoy AI Gateway release", () => {
  assert.equal(envoyAigwVersion("ENVOY_AI_GATEWAY_VERSION=v1.1.0\n"), "v1.1.0")
  assert.throws(() => envoyAigwVersion("ENVOY_GATEWAY_VERSION=v1.8.4\n"), /ENVOY_AI_GATEWAY_VERSION/)
})
