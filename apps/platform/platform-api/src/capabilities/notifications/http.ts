import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  CancelNotificationSubscriptionSchema,
  NotificationSubscriptionListSchema,
  NotificationSubscriptionPathSchema,
  NotificationSubscriptionSchema,
  NotificationTenantPathSchema,
  UpsertNotificationSubscriptionSchema,
} from "./contract"
import type { NotificationSubscriptionStore } from "./module"

export const notificationHttp: FastifyPluginAsync<{
  store: NotificationSubscriptionStore
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get("/v1/tenants/:tenant_id/notification-subscriptions", {
    schema: {
      operationId: "listNotificationSubscriptions",
      tags: ["Notifications"],
      params: NotificationTenantPathSchema,
      response: { 200: NotificationSubscriptionListSchema },
    },
  }, async (request) => options.store.list({
    tenantId: request.params.tenant_id,
    subjectId: request.principal!.subject_id,
  }))
  routes.post("/v1/tenants/:tenant_id/notification-subscriptions", {
    schema: {
      operationId: "upsertNotificationSubscription",
      tags: ["Notifications"],
      params: NotificationTenantPathSchema,
      body: UpsertNotificationSubscriptionSchema,
      response: { 200: NotificationSubscriptionSchema },
    },
  }, async (request) => options.store.upsert({
    tenantId: request.params.tenant_id,
    subjectId: request.principal!.subject_id,
    value: request.body,
  }))
  routes.delete("/v1/tenants/:tenant_id/notification-subscriptions/:subscription_id", {
    schema: {
      operationId: "disableNotificationSubscription",
      tags: ["Notifications"],
      params: NotificationSubscriptionPathSchema,
      body: CancelNotificationSubscriptionSchema,
      response: { 200: NotificationSubscriptionSchema },
    },
  }, async (request) => options.store.disable({
    tenantId: request.params.tenant_id,
    subjectId: request.principal!.subject_id,
    subscriptionId: request.params.subscription_id,
  }))
}
