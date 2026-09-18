export const AUTHORITY_FLOOR_SCHEMA_VERSION = "genio.one.authority-floor.v1" as const

export interface AuthorityFloor {
  schema_version: typeof AUTHORITY_FLOOR_SCHEMA_VERSION
  tenant_id: string
  generation: number
  revoked_entitlement_ids: string[]
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

export function parseAuthorityFloor(value: unknown): AuthorityFloor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("authority floor is invalid")
  const floor = value as Record<string, unknown>
  const revokedEntitlementIds = floor.revoked_entitlement_ids
  if (
    Object.keys(floor).length !== 4 ||
    floor.schema_version !== AUTHORITY_FLOOR_SCHEMA_VERSION ||
    !identifier(floor.tenant_id) ||
    !Number.isSafeInteger(floor.generation) ||
    Number(floor.generation) < 0 ||
    !Array.isArray(revokedEntitlementIds) ||
    !revokedEntitlementIds.every(identifier) ||
    new Set(revokedEntitlementIds).size !== revokedEntitlementIds.length
  ) {
    throw new Error("authority floor is invalid")
  }
  const canonicalRevokedEntitlementIds = [...revokedEntitlementIds].sort(compareUtf8)
  if (canonicalRevokedEntitlementIds.some((value, index) => value !== revokedEntitlementIds[index])) {
    throw new Error("authority floor is not canonical")
  }
  return {
    schema_version: AUTHORITY_FLOOR_SCHEMA_VERSION,
    tenant_id: floor.tenant_id,
    generation: Number(floor.generation),
    revoked_entitlement_ids: canonicalRevokedEntitlementIds,
  }
}

export function advanceAuthorityFloor(input: {
  current: AuthorityFloor | null
  tenantId: string
  generation: number
  revokedEntitlementIds: readonly string[]
}): AuthorityFloor {
  if (!identifier(input.tenantId) || !Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error("authority floor advance is invalid")
  }
  if (input.current && input.current.tenant_id !== input.tenantId) throw new Error("authority floor tenant mismatch")
  if (input.current && input.generation < input.current.generation) throw new Error("authority floor generation cannot regress")
  if (!input.revokedEntitlementIds.every(identifier)) throw new Error("revoked entitlement id is invalid")
  const revoked = new Set(input.current?.revoked_entitlement_ids ?? [])
  for (const entitlementId of input.revokedEntitlementIds) revoked.add(entitlementId)
  return {
    schema_version: AUTHORITY_FLOOR_SCHEMA_VERSION,
    tenant_id: input.tenantId,
    generation: Math.max(input.current?.generation ?? 0, input.generation),
    revoked_entitlement_ids: [...revoked].sort(compareUtf8),
  }
}

export function applyAuthorityFloor<T extends { rule_id: string }>(
  rules: readonly T[],
  floor: AuthorityFloor,
): T[] {
  const revoked = new Set(floor.revoked_entitlement_ids)
  return rules.filter((rule) => !revoked.has(rule.rule_id))
}
