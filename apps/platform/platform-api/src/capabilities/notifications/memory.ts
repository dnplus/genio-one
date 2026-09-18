import { PlatformApiError } from "../errors"
import type { NotificationSubscription } from "./contract"
import type { NotificationSubscriptionStore } from "./module"

export function createInMemoryNotificationSubscriptionStore(options: {
  now?: () => number
  idFactory?: () => string
} = {}): NotificationSubscriptionStore {
  const values = new Map<string, NotificationSubscription>()
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  const idFactory = options.idFactory ?? (() => crypto.randomUUID())
  return {
    async list({ tenantId, subjectId }) {
      return [...values.values()]
        .filter((value) => value.tenant_id === tenantId && value.subject_id === subjectId)
        .sort((left, right) => right.updated_at - left.updated_at)
        .map((value) => structuredClone(value))
    },
    async upsert({ tenantId, subjectId, value }) {
      const existing = [...values.values()].find((candidate) =>
        candidate.tenant_id === tenantId &&
        candidate.subject_id === subjectId &&
        candidate.notification_type === value.notification_type &&
        candidate.channel === value.channel)
      const subscription: NotificationSubscription = {
        subscription_id: existing?.subscription_id ?? `notification-subscription-${idFactory()}`,
        tenant_id: tenantId,
        subject_id: subjectId,
        notification_type: value.notification_type,
        channel: value.channel,
        enabled: value.enabled,
        created_by: existing?.created_by ?? { subject_id: subjectId, evidence_level: "VERIFIED" },
        updated_at: now(),
      }
      values.set(`${tenantId}:${subscription.subscription_id}`, subscription)
      return structuredClone(subscription)
    },
    async disable({ tenantId, subjectId, subscriptionId }) {
      const key = `${tenantId}:${subscriptionId}`
      const existing = values.get(key)
      if (!existing || existing.subject_id !== subjectId) {
        throw new PlatformApiError("NOTIFICATION_SUBSCRIPTION_NOT_FOUND", 404)
      }
      const disabled = { ...existing, enabled: false, updated_at: now() }
      values.set(key, disabled)
      return structuredClone(disabled)
    },
  }
}
