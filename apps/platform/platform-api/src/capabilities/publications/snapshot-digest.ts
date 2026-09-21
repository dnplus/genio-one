import { createHash } from "node:crypto"

import { canonicalJson } from "@genioone/protocol/canonical"

import type { GatewayProjectionSnapshot } from "../gateway-projection/contract"
import { governedResourceContent } from "../resources/resource-content"

type UnsignedGatewayProjectionSnapshot = Omit<GatewayProjectionSnapshot, "snapshot_digest">

function snapshotContent(snapshot: UnsignedGatewayProjectionSnapshot): unknown {
  return {
    tenant_id: snapshot.tenant_id,
    publication_id: snapshot.publication_id,
    request_id: snapshot.request_id,
    resource_id: snapshot.resource_id,
    capability_id: snapshot.capability_id,
    endpoint_revision: snapshot.endpoint_revision,
    resource_revision: snapshot.resource_revision,
    policy_revision: snapshot.policy_revision,
    resource_digest: snapshot.resource_digest,
    resource: governedResourceContent(snapshot.resource),
    publication_endpoint: snapshot.publication_endpoint,
    one_policy_chain: snapshot.one_policy_chain,
    connections: snapshot.connections,
    provider_credential_profiles: snapshot.provider_credential_profiles,
    models: snapshot.models,
    model_mappings: snapshot.model_mappings,
  }
}

export function snapshotDigest(snapshot: UnsignedGatewayProjectionSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshotContent(snapshot))).digest("hex")
}

function legacyStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyStable)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, legacyStable(entry)]),
    )
  }
  return value
}

function legacySnapshotDigest(snapshot: UnsignedGatewayProjectionSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(legacyStable(snapshotContent(snapshot))))
    .digest("hex")
}

export function snapshotDigestMatches(
  snapshot: UnsignedGatewayProjectionSnapshot,
  stored: string,
): boolean {
  return stored === snapshotDigest(snapshot) || stored === legacySnapshotDigest(snapshot)
}
