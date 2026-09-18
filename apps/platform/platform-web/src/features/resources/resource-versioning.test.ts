import { describe, expect, test } from "bun:test"

import {
  bumpResourceVersion,
  nextVersionInLineage,
  publicationBasePathForVersion,
} from "./resource-versioning"
import type { ResourceRegistration } from "@/domain/contracts"

function resource(partial: Partial<ResourceRegistration> & Pick<ResourceRegistration, "resource_id" | "version">): ResourceRegistration {
  return {
    tenant_id: "tenant",
    display_name: "Incident API",
    kind: "API",
    owner_organization_id: "org",
    authentication_strategy: "OAUTH",
    environment_id: "production",
    lifecycle: "PUBLISHED",
    operational_state: "UNKNOWN",
    capabilities: [],
    enforcement_point_id: "gw",
    created_at: 0,
    ...partial,
  }
}

describe("resource versioning", () => {
  test("fork takes the next unused vN in the same lineage", () => {
    const v1 = resource({ resource_id: "r1", version: "v1" })
    const v2 = resource({ resource_id: "r2", version: "v2", lifecycle: "DRAFT" })
    expect(nextVersionInLineage([v1, v2], v1)).toBe("v3")
    expect(bumpResourceVersion("v1")).toBe("v2")
    expect(nextVersionInLineage([resource({ resource_id: "legacy", version: "1.0" })], resource({ resource_id: "legacy", version: "1.0" }))).toBe("v2")
  })

  test("publish coexist appends the resource version to the path", () => {
    const api = resource({ resource_id: "r1", version: "v2", api: {
      api_product_id: "p",
      openapi_version: "3.0.3",
      document_title: "Incident API",
      document_version: "v2",
      public_path: "/incidents",
      inbound_security: { type: "KEYLESS" },
      request_schema_validation: true,
      operations: [],
    } })
    expect(publicationBasePathForVersion(api, "REPLACE", "/incidents")).toBe("/incidents")
    expect(publicationBasePathForVersion(api, "COEXIST", "/incidents")).toBe("/incidents/v2")
  })
})
