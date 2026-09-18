import { afterEach, expect, test } from "bun:test"
import { BotRegistry, type BotPackageManifest } from "../bot-registry"
import type { BotServerContext } from "../context"
import { packageCatalogForRequest } from "./catalog"

const originalFetch = globalThis.fetch
const registry = new BotRegistry(":memory:")
const context = { botRegistry: registry } as BotServerContext
const principal = { tenant_id: "test", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
const manifest: BotPackageManifest = { packageType: "BOT", resourceId: "package", version: "1.0.0", profile: { title: "Package", description: "Test package", avatar: {} }, skills: [], plugins: [], resourceBindings: [{ resourceId: "resource", capabilityId: "invoke" }], defaultRuntimeTier: "none", manifestDigest: "manifest", artifactDigest: "artifact", source: { kind: "UPLOAD", ref: "test" } }
registry.registerPackage(manifest)
afterEach(() => { globalThis.fetch = originalFetch })

test("catalog failure and malformed response never grant local packages", async () => {
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch
  await expect(packageCatalogForRequest(context, "token", principal)).rejects.toThrow("BOT_CATALOG_UNAVAILABLE")
  globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch
  await expect(packageCatalogForRequest(context, "token", principal)).rejects.toThrow("BOT_CATALOG_INVALID_RESPONSE")
})

test("package and every exact resource-capability binding must be authorized", async () => {
  const own = { resource_id: "package", resource_kind: "EXTENSION", capability_id: "install", access: "ENTITLED", connection_status: "READY" }
  const dependency = { resource_id: "resource", capability_id: "invoke", access: "ENTITLED", connection_status: "READY" }
  for (const [capabilities, access, connection] of [
    [[], "DENIED", "NEEDS_CONNECTION"],
    [[dependency], "DENIED", "NEEDS_CONNECTION"],
    [[own, { ...dependency, resource_id: "other" }], "DENIED", "NEEDS_CONNECTION"],
    [[own, { ...dependency, access: undefined }], "DENIED", "CONNECTED"],
    [[own, { ...dependency, connection_status: "NEEDS_CONNECTION" }], "ENTITLED", "NEEDS_CONNECTION"],
    [[own, { ...dependency, access: "REQUEST" }], "REQUEST", "CONNECTED"],
    [[own, dependency], "ENTITLED", "CONNECTED"],
  ] as const) {
    globalThis.fetch = (async () => Response.json({ capabilities })) as unknown as typeof fetch
    const result = await packageCatalogForRequest(context, "token", principal)
    expect(result.find((candidate) => candidate.resourceId === "package")).toMatchObject({ accessStatus: access, connectionStatus: connection })
  }
})

test("fixture packages cannot be registered", () => {
  expect(() => registry.registerPackage({ ...manifest, source: { kind: "FIXTURE", ref: "demo" } })).toThrow("BOT_PACKAGE_SOURCE_UNSUPPORTED")
})
