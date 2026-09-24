import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import { BotRegistry } from "../bot-registry"
import { artifactRoutes } from "./artifacts"

test("artifact capture and import require filesystem capability before touching workspace bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "genio-artifact-policy-"))
  const originalFetch = globalThis.fetch
  const principal = { tenant_id: "tenant-a", subject_id: "owner-a", acting_client_id: "client-a", scopes: [] }
  const registry = new BotRegistry(":memory:", join(root, "artifacts"))
  const bot = registry.create(principal, { name: "Artifact", description: "Policy gate" })
  let reads = 0
  let writes = 0
  const bytes = Buffer.from("immutable bytes")
  const details = { kind: "e2b-self-hosted" as const, tier: "headless" as const, cwd: "/home/user/workspace", desktopUrl: null, sandboxId: "sandbox-a", environmentId: "environment-a", execServerUrl: "ws://executor", execReady: true, botId: bot.id, workspaceId: "workspace-a" }
  const lease = { details, async close() {}, async readFile() { reads += 1; return bytes }, async writeFile() { writes += 1 } }
  const session = { id: "runtime-a", principal, leases: { headless: lease } }
  const runtimeBroker = { findByPrincipal: () => session }
  const handsPlacement = {
    async run(_actor: unknown, _provider: unknown, task: () => unknown) { return task() },
    async runCapability(_actor: unknown, capabilityId: string, _action: string, task: () => unknown) {
      if (capabilityId === "filesystem.read") throw new Error("FILESYSTEM_READ_DENIED")
      return task()
    },
  }
  const app = Fastify()
  globalThis.fetch = (async () => Response.json(principal)) as unknown as typeof fetch
  try {
    await artifactRoutes(app, { botRegistry: registry, runtimeBroker, handsPlacement } as any)
    const capture = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/artifacts/from-runtime`, headers: { authorization: "Bearer actor" }, payload: { sourceTier: "headless", sourceEnvironmentId: details.environmentId, path: "/home/user/workspace/file.txt" } })
    expect(capture.statusCode).toBe(400)
    expect(capture.json().error).toBe("FILESYSTEM_READ_DENIED")
    expect(reads).toBe(0)

    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    const artifact = registry.registerArtifact(principal, { botId: bot.id, sourceTier: "headless", sourceEnvironmentId: details.environmentId, path: "/home/user/workspace/file.txt", digest, size: bytes.byteLength })
    registry.storeArtifactBytes(artifact.artifactId, bytes)
    handsPlacement.runCapability = async (_actor: unknown, capabilityId: string, _action: string, task: () => unknown) => {
      if (capabilityId === "filesystem.write") throw new Error("FILESYSTEM_WRITE_DENIED")
      return task()
    }
    const imported = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/artifacts/${artifact.artifactId}/import`, headers: { authorization: "Bearer actor" }, payload: { targetTier: "headless", targetEnvironmentId: details.environmentId } })
    expect(imported.statusCode).toBe(400)
    expect(imported.json().error).toBe("FILESYSTEM_WRITE_DENIED")
    expect(writes).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
    registry.close()
    rmSync(root, { recursive: true, force: true })
  }
})
