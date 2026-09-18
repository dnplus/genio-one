import type { SqlAdapter } from "../../persistence/sql-adapter"
import type { GatewayPublicationReleaseCoordinator } from "./publication-commit"

interface DueGatewayRow extends Record<string, unknown> {
  tenant_id: string
  gateway_id: string
}

export interface GatewayPolicyReleaseRenewal {
  renewDue(): Promise<number>
}

export interface GatewayPolicyReleaseRenewalOptions {
  sql: SqlAdapter
  coordinator: GatewayPublicationReleaseCoordinator
  now?: () => number
  releaseTtlSeconds: number
  renewBeforeSeconds?: number
  maxPerRun?: number
}

/**
 * Rotates immutable Gateway policy releases before their signed artifacts
 * expire. Each selected head is locked and reconciled in the same transaction,
 * so multiple Platform API replicas cannot renew the same head concurrently.
 */
export function createGatewayPolicyReleaseRenewal(
  options: GatewayPolicyReleaseRenewalOptions,
): GatewayPolicyReleaseRenewal {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  const renewBeforeSeconds = options.renewBeforeSeconds ?? Math.max(
    60,
    Math.min(600, Math.floor(options.releaseTtlSeconds / 3)),
  )
  const maxPerRun = options.maxPerRun ?? 100
  if (!Number.isSafeInteger(options.releaseTtlSeconds) || options.releaseTtlSeconds < 1) {
    throw new Error("releaseTtlSeconds must be a positive integer")
  }
  if (!Number.isSafeInteger(renewBeforeSeconds) || renewBeforeSeconds < 1) {
    throw new Error("renewBeforeSeconds must be a positive integer")
  }
  if (renewBeforeSeconds >= options.releaseTtlSeconds) {
    throw new Error("renewBeforeSeconds must be less than releaseTtlSeconds")
  }
  if (!Number.isSafeInteger(maxPerRun) || maxPerRun < 1) {
    throw new Error("maxPerRun must be a positive integer")
  }

  async function renewOne(): Promise<boolean> {
    return options.sql.transaction(async (transaction) => {
      const issuedAt = now()
      const dueAt = issuedAt + renewBeforeSeconds
      const due = await transaction.query<DueGatewayRow>(
        `select head.tenant_id, head.gateway_id
           from genio_one_gateway_policy_release_heads head
           join genio_one_gateway_policy_releases release
             on release.tenant_id = head.tenant_id
            and release.gateway_id = head.gateway_id
            and release.release_id = head.release_id
          where release.expires_at <= to_timestamp($1)
            and exists (
              select 1
                from genio_one_platform_runtime_registrations runtime_registration
                join genio_one_platform_runtime_capabilities runtime_capability
                  on runtime_capability.tenant_id = runtime_registration.tenant_id
                 and runtime_capability.runtime_kind = runtime_registration.runtime_kind
                 and runtime_capability.runtime_id = runtime_registration.runtime_id
               where runtime_registration.tenant_id = head.tenant_id
                 and runtime_registration.runtime_kind = 'GATEWAY'
                 and runtime_registration.target_id = head.gateway_id
                 and runtime_registration.status = 'ACTIVE'
                 and runtime_capability.protocol_versions @> '["genio.one.runtime.v1"]'::jsonb
                 and runtime_capability.preferred_protocol_version = 'genio.one.runtime.v1'
                 and runtime_capability.delivery_mode = 'AGGREGATE_RELEASE'
            )
          order by release.expires_at, head.tenant_id, head.gateway_id
          for update of head skip locked
          limit 1`,
        [dueAt],
      )
      const target = due.rows[0]
      if (!target) return false
      await options.coordinator.reconcileInTransaction({
        transaction,
        tenantId: target.tenant_id,
        gatewayId: target.gateway_id,
        issuedAt,
      })
      return true
    })
  }

  return {
    async renewDue() {
      let renewed = 0
      while (renewed < maxPerRun && await renewOne()) renewed += 1
      return renewed
    },
  }
}
