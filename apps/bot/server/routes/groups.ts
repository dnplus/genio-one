import type { FastifyInstance } from "fastify"

import { requestPrincipal } from "../auth"
import type { BotServerContext } from "../context"
import { GroupMemberCountError } from "../bot-groups"

export async function groupRoutes(app: FastifyInstance, context: BotServerContext) {
  const { botRegistry } = context

  app.post("/api/bot-groups", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const body = (request.body ?? {}) as Record<string, unknown>
      const memberBotIds = Array.isArray(body.memberBotIds)
        ? body.memberBotIds.filter((value): value is string => typeof value === "string")
        : []
      const group = botRegistry.createGroup(principal, {
        name: typeof body.name === "string" ? body.name : "",
        memberBotIds,
      })
      console.info(JSON.stringify({
        event: "bot.group.created",
        group_id: group.groupId,
        members: group.memberBotIds.length,
        correlation_id: group.groupId,
      }))
      return reply.code(201).send(group)
    } catch (error) {
      if (error instanceof GroupMemberCountError) {
        return reply.code(400).send({ error: error.code, message: error.message })
      }
      const message = error instanceof Error ? error.message : "BOT_GROUP_CREATE_FAILED"
      const code = message === "BOT_NOT_FOUND" ? 404 : 400
      return reply.code(code).send({ error: message })
    }
  })

  app.get("/api/bot-groups", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      return reply.send(botRegistry.listGroups(principal))
    } catch (error) {
      return reply.code(401).send({ error: error instanceof Error ? error.message : "BOT_AUTH_REQUIRED" })
    }
  })

  app.patch("/api/bot-groups/:groupId", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const groupId = (request.params as { groupId: string }).groupId
      const body = (request.body ?? {}) as Record<string, unknown>
      const memberBotIds = Array.isArray(body.memberBotIds)
        ? body.memberBotIds.filter((value): value is string => typeof value === "string")
        : null
      if (!memberBotIds) return reply.code(400).send({ error: "GROUP_MEMBERS_REQUIRED" })
      const group = botRegistry.updateGroupMembers(principal, groupId, memberBotIds)
      return reply.send(group)
    } catch (error) {
      if (error instanceof GroupMemberCountError) {
        return reply.code(400).send({ error: error.code, message: error.message })
      }
      const message = error instanceof Error ? error.message : "BOT_GROUP_UPDATE_FAILED"
      const code = message === "GROUP_NOT_FOUND" || message === "BOT_NOT_FOUND" ? 404 : 400
      return reply.code(code).send({ error: message })
    }
  })

  app.get("/api/bot-groups/:groupId", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const group = botRegistry.getGroup(principal, (request.params as { groupId: string }).groupId)
      if (!group) return reply.code(404).send({ error: "GROUP_NOT_FOUND" })
      return reply.send(group)
    } catch (error) {
      return reply.code(401).send({ error: error instanceof Error ? error.message : "BOT_AUTH_REQUIRED" })
    }
  })

}
