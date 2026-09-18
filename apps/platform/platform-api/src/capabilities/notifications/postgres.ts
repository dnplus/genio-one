import type { SqlAdapter } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type { NotificationSubscription } from "./contract"
import type { NotificationSubscriptionStore } from "./module"

type Row = Record<string, unknown>

function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === "string" ? value : String(value ?? "")
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1_000)
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : Number(value)
}

function subscription(row: Row): NotificationSubscription {
  return {
    subscription_id: text(row, "subscription_id"),
    tenant_id: text(row, "tenant_id"),
    subject_id: text(row, "subject_id"),
    notification_type: text(row, "notification_type") as NotificationSubscription["notification_type"],
    channel: "IN_APP",
    enabled: row.enabled === true || row.enabled === "true",
    created_by: {
      subject_id: text(row, "created_by_subject_id"),
      evidence_level: "VERIFIED",
    },
    updated_at: timestamp(row.updated_at),
  }
}

const COLUMNS = `tenant_id, subscription_id, subject_id, notification_type,
  channel, enabled, created_by_subject_id, updated_at`

export function createPostgresNotificationSubscriptionStore(options: {
  sql: SqlAdapter
  idFactory?: () => string
}): NotificationSubscriptionStore {
  const idFactory = options.idFactory ?? (() => crypto.randomUUID())
  return {
    async list({ tenantId, subjectId }) {
      const result = await options.sql.query<Row>(
        `select ${COLUMNS} from genio_one_notification_subscriptions
          where tenant_id = $1 and subject_id = $2
          order by updated_at desc, subscription_id asc`,
        [tenantId, subjectId],
      )
      return result.rows.map(subscription)
    },
    async upsert({ tenantId, subjectId, value }) {
      try {
        const result = await options.sql.query<Row>(
          `insert into genio_one_notification_subscriptions
             (tenant_id, subscription_id, subject_id, notification_type,
              channel, enabled, created_by_subject_id, updated_at)
           values ($1, $2, $3, $4, $5, $6, $3, now())
           on conflict (tenant_id, subject_id, notification_type, channel)
           do update set enabled = excluded.enabled, updated_at = now()
           returning ${COLUMNS}`,
          [
            tenantId,
            `notification-subscription-${idFactory()}`,
            subjectId,
            value.notification_type,
            value.channel,
            value.enabled,
          ],
        )
        return subscription(result.rows[0]!)
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23503") {
          throw new PlatformApiError("NOTIFICATION_SUBJECT_NOT_FOUND", 422)
        }
        throw error
      }
    },
    async disable({ tenantId, subjectId, subscriptionId }) {
      const result = await options.sql.query<Row>(
        `update genio_one_notification_subscriptions
            set enabled = false, updated_at = now()
          where tenant_id = $1 and subject_id = $2 and subscription_id = $3
          returning ${COLUMNS}`,
        [tenantId, subjectId, subscriptionId],
      )
      if (!result.rows[0]) throw new PlatformApiError("NOTIFICATION_SUBSCRIPTION_NOT_FOUND", 404)
      return subscription(result.rows[0])
    },
  }
}
