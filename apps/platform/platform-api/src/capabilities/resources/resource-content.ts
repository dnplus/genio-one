import { createHash } from "node:crypto"

import type { ResourceRegistration } from "./contract"
import { canonicalJson } from "@genioone/protocol/canonical"

export function governedResourceContent(resource: ResourceRegistration): Record<string, unknown> {
  return {
    tenant_id: resource.tenant_id,
    resource_id: resource.resource_id,
    display_name: resource.display_name,
    kind: resource.kind,
    owner_organization_id: resource.owner_organization_id,
    authentication_strategy: resource.authentication_strategy,
    environment_id: resource.environment_id,
    version: resource.version,
    capabilities: resource.capabilities,
    api: resource.api ?? null,
    extension_metadata: resource.extension_metadata ?? null,
    enforcement_point_id: resource.enforcement_point_id,
  }
}

export function resourceContentDigest(resource: ResourceRegistration): string {
  return createHash("sha256")
    .update(canonicalJson(governedResourceContent(resource)))
    .digest("hex")
}
