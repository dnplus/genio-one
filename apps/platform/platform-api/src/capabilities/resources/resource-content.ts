import { createHash } from "node:crypto"

import type { ResourceRegistration } from "./contract"

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort(compareUtf8)
        .map((key) => [key, canonicalValue(record[key])]),
    )
  }
  return value
}

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
    .update(JSON.stringify(canonicalValue(governedResourceContent(resource))))
    .digest("hex")
}
