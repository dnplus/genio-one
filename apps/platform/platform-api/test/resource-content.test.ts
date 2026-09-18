import assert from "node:assert/strict"
import test from "node:test"

import type { ResourceRegistration } from "../src/capabilities/resources/contract"
import { governedResourceContent, resourceContentDigest } from "../src/capabilities/resources/resource-content"

function resource(overrides: Partial<ResourceRegistration> = {}): ResourceRegistration {
  return {
    tenant_id: "tenant-acme",
    resource_id: "resource-ai",
    display_name: "Corporate AI",
    kind: "LLM",
    owner_organization_id: "organization-ai",
    authentication_strategy: "OAUTH",
    environment_id: "production",
    version: "1.0.0",
    lifecycle: "DRAFT",
    operational_state: "UNKNOWN",
    capabilities: [{ capability_id: "chat", display_name: "Chat" }],
    api: null,
    enforcement_point_id: "ai-gateway",
    publication_endpoint: null,
    publication_request: null,
    created_at: 1_700_000_000,
    ...overrides,
  }
}

test("Resource content digest has one lifecycle-independent canonical authority", () => {
  const draft = resource()
  const published = resource({
    lifecycle: "PUBLISHED",
    operational_state: "HEALTHY",
    created_at: 1_800_000_000,
  })

  assert.deepEqual(governedResourceContent(draft), governedResourceContent(published))
  assert.equal(governedResourceContent(draft).api, null)
  assert.equal(resourceContentDigest(draft), resourceContentDigest(published))
  assert.notEqual(resourceContentDigest(draft), resourceContentDigest(resource({ version: "1.0.1" })))
  assert.equal(
    resourceContentDigest(draft),
    resourceContentDigest(resource({ capabilities: [{ display_name: "Chat", capability_id: "chat" }] })),
  )
  assert.notEqual(
    resourceContentDigest(draft),
    resourceContentDigest(resource({ extension_metadata: {
      package_type: "BOT",
      profile: { title: "Bot", description: "Bot", avatar: null },
      skills: [],
      plugins: [],
      resource_bindings: [],
      default_runtime_tier: "none",
      manifest_digest: "manifest",
      artifact_digest: "different",
    } })),
  )
})
