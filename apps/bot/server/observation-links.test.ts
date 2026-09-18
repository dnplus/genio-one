import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ObservationLinks } from "./observation-links"

test("runtime observation links survive restart without crossing tenant identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observation-links-"))
  const path = join(directory, "links.json")
  const context = { tenantId: "tenant-a", traceId: "a".repeat(32), spanId: "b".repeat(16), correlationId: "correlation" }
  try {
    const links = new ObservationLinks(path, "tenant-a")
    links.put("turn:one", context)
    await links.flush()
    const restored = new ObservationLinks(path, "tenant-a")
    await restored.ready()
    expect(restored.get("turn:one")).toEqual(context)
    const otherTenant = new ObservationLinks(path, "tenant-b")
    await otherTenant.ready()
    expect(otherTenant.get("turn:one")).toBeUndefined()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
