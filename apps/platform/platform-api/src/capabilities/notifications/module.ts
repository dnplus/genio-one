import type { NotificationSubscription, UpsertNotificationSubscriptionInput } from "./contract"

export interface NotificationSubscriptionStore {
  list(input: { tenantId: string; subjectId: string }): Promise<NotificationSubscription[]>
  upsert(input: {
    tenantId: string
    subjectId: string
    value: UpsertNotificationSubscriptionInput
  }): Promise<NotificationSubscription>
  disable(input: {
    tenantId: string
    subjectId: string
    subscriptionId: string
  }): Promise<NotificationSubscription>
}
