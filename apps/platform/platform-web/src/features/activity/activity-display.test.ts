import assert from "node:assert/strict"
import test from "node:test"

import type { OverviewSnapshot } from "@/domain/contracts"
import { createActivityDisplayDirectory } from "./activity-display"

test("Activity display resolves external identities and governed entities", () => {
  const directory = createActivityDisplayDirectory({
    resources: [{
      resource_id: "resource-1",
      display_name: "Notion Hosted MCP",
      capabilities: [{ capability_id: "mcp.invoke", display_name: "Invoke MCP" }],
    }] as unknown as OverviewSnapshot["resources"],
    connections: [{
      connection_id: "connection-1",
      display_name: "Notion OAuth MCP",
    }] as unknown as OverviewSnapshot["connections"],
    applications: [],
    identity: {
      tenant_id: "tenant-1",
      subjects: [{
        subject_id: "person-platform-admin",
        kind: "PERSON",
        profile: { display_name: "Platform Administrator", email: "admin@example.com", department: null },
        suspended: false,
        suspended_at: null,
        suspended_by: null,
        suspension_reason: null,
      }],
      external_identity_bindings: [{
        provider_id: "keycloak-local",
        external_subject_id: "8e1bfeb6-2590-4748-91bc-11d991aca358",
        subject_id: "person-platform-admin",
      }],
      tenant_administrators: ["person-platform-admin"],
    },
  })

  assert.equal(directory.subject(null).kind, "Subject")
  assert.deepEqual(directory.subject("8e1bfeb6-2590-4748-91bc-11d991aca358"), {
    label: "Platform Administrator",
    kind: "Person",
    supporting: "admin@example.com",
    resolved: true,
  })
  assert.equal(directory.resource("resource-1").label, "Notion Hosted MCP")
  assert.equal(directory.connection("connection-1").label, "Notion OAuth MCP")
  assert.equal(directory.capability("resource-1", "mcp.invoke").label, "Invoke MCP")
  assert.deepEqual(directory.application("genio-one-product-api"), {
    label: "GenioOne Management Console",
    kind: "Application",
    resolved: true,
  })
})
