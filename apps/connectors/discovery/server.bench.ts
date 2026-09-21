import { handleDiscoveryMcp, type DiscoveryCatalog } from "./server"

function generateCatalog(numResources: number, toolsPerResource: number): DiscoveryCatalog {
  const capabilities = []
  for (let r = 0; r < numResources; r++) {
    const resourceId = `resource-${r}`
    const resourceName = `Resource Display Name ${r} 客服`
    for (let t = 0; t < toolsPerResource; t++) {
      capabilities.push({
        resource_id: resourceId,
        resource_display_name: resourceName,
        capability_id: `cap-${r}-${t}`,
        capability_display_name: `Capability Display Name ${r}-${t} 查詢`,
        connection_status: "READY",
        access: "AUTO_GRANT",
        hub_status: "AVAILABLE",
      })
    }
  }
  return {
    catalog_revision: "rev-1",
    capabilities,
  }
}

const smallCatalog = generateCatalog(10, 5)
const largeCatalog = generateCatalog(200, 10)

async function benchmark() {
  console.log("=== Discovery Benchmark Baseline ===")

  const optionsSmall = {
    catalog: async () => smallCatalog,
    completed: () => {},
  }

  const optionsLarge = {
    catalog: async () => largeCatalog,
    completed: () => {},
  }

  const searchRequestEmpty = (query = "") =>
    new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_resources", arguments: { query } },
      }),
    })

  const getResourceRequest = (resource_id: string) =>
    new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_resource", arguments: { resource_id } },
      }),
    })

  // Warmup
  for (let i = 0; i < 50; i++) {
    await handleDiscoveryMcp(searchRequestEmpty(), optionsSmall)
  }

  const ITERATIONS = 1000

  // 1. Large Catalog Empty Search
  let start = performance.now()
  for (let i = 0; i < ITERATIONS; i++) {
    await handleDiscoveryMcp(searchRequestEmpty(""), optionsLarge)
  }
  let durationEmpty = performance.now() - start
  console.log(`Large Catalog Empty Query (${ITERATIONS} ops): ${durationEmpty.toFixed(2)} ms (${(ITERATIONS / (durationEmpty / 1000)).toFixed(0)} ops/sec)`)

  // 2. Large Catalog Matching Search
  start = performance.now()
  for (let i = 0; i < ITERATIONS; i++) {
    await handleDiscoveryMcp(searchRequestEmpty("客服"), optionsLarge)
  }
  let durationMatch = performance.now() - start
  console.log(`Large Catalog Matching Query (${ITERATIONS} ops): ${durationMatch.toFixed(2)} ms (${(ITERATIONS / (durationMatch / 1000)).toFixed(0)} ops/sec)`)

  // 3. Large Catalog Get Resource
  start = performance.now()
  for (let i = 0; i < ITERATIONS; i++) {
    await handleDiscoveryMcp(getResourceRequest("resource-150"), optionsLarge)
  }
  let durationGet = performance.now() - start
  console.log(`Large Catalog Get Resource (${ITERATIONS} ops): ${durationGet.toFixed(2)} ms (${(ITERATIONS / (durationGet / 1000)).toFixed(0)} ops/sec)`)
}

benchmark().catch(console.error)
