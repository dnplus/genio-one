import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })

const NotificationTypeSchema = Type.Union([
  Type.Literal("ACCESS_REQUEST"),
  Type.Literal("ENTITLEMENT_EXPIRING"),
  Type.Literal("RUNAWAY_INVOCATION_SUSPENDED"),
  Type.Literal("API_VERSION_LIFECYCLE"),
  Type.Literal("ALL"),
])

const NotificationChannelSchema = Type.Literal("IN_APP")

export const NotificationSubscriptionSchema = Type.Object({
  subscription_id: Identifier,
  tenant_id: Identifier,
  subject_id: Identifier,
  notification_type: NotificationTypeSchema,
  channel: NotificationChannelSchema,
  enabled: Type.Boolean(),
  created_by: Type.Object({
    subject_id: Identifier,
    evidence_level: Type.Literal("VERIFIED"),
  }, { additionalProperties: false }),
  updated_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const NotificationSubscriptionListSchema = Type.Array(NotificationSubscriptionSchema)
export const NotificationTenantPathSchema = Type.Object({ tenant_id: Identifier }, { additionalProperties: false })
export const NotificationSubscriptionPathSchema = Type.Object({
  tenant_id: Identifier,
  subscription_id: Identifier,
}, { additionalProperties: false })

export const UpsertNotificationSubscriptionSchema = Type.Object({
  correlation_id: Identifier,
  notification_type: NotificationTypeSchema,
  channel: NotificationChannelSchema,
  enabled: Type.Boolean(),
}, { additionalProperties: false })

export const CancelNotificationSubscriptionSchema = Type.Object({
  correlation_id: Identifier,
}, { additionalProperties: false })

export type NotificationSubscription = Static<typeof NotificationSubscriptionSchema>
export type UpsertNotificationSubscriptionInput = Static<typeof UpsertNotificationSubscriptionSchema>
