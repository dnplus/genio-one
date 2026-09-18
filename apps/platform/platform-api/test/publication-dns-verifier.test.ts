import assert from "node:assert/strict"
import test from "node:test"
import { createPublicationDnsVerifier } from "../src/publication-dns-verifier"

const input = { tenantId: "tenant-a", resourceId: "resource-a", gatewayId: "gateway-a", hostname: "mcp.company.test", dnsTarget: "edge.company.test" }

test("publication DNS compares every resolved address against deployment-owned Gateway targets", async () => {
  const answers: Record<string, string[]> = { "edge.company.test": ["192.0.2.10"], "mcp.company.test": ["192.0.2.10"] }
  const verifier = createPublicationDnsVerifier({ "gateway-a": "edge.company.test" }, async (hostname) => answers[hostname] ?? [])
  assert.equal(verifier.targetForGateway!("gateway-a"), "edge.company.test")
  assert.equal(await verifier.verify(input), true)
  answers["mcp.company.test"] = ["192.0.2.10", "192.0.2.11"]
  assert.equal(await verifier.verify(input), false)
  answers["mcp.company.test"] = []
  assert.equal(await verifier.verify(input), false)
})

test("publication DNS refuses caller-selected targets and missing Gateway configuration", async () => {
  const verifier = createPublicationDnsVerifier({ "gateway-a": "edge.company.test" }, async () => ["192.0.2.10"])
  assert.equal(await verifier.verify({ ...input, dnsTarget: "attacker.test" }), false)
  await assert.rejects(Promise.resolve().then(() => verifier.verify({ ...input, gatewayId: "gateway-other" })), /Configure the Gateway DNS target/)
})

test("publication DNS lookup failure remains unverified", async () => {
  const verifier = createPublicationDnsVerifier({ "gateway-a": "edge.company.test" }, async () => { throw new Error("ENOTFOUND") })
  assert.equal(await verifier.verify(input), false)
})
