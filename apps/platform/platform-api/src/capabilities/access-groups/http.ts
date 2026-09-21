import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"

import {
  AccessGroupSchema,
  ReplaceAccessGroupMembersSchema,
  SaveAccessGroupSchema,
} from "./contract"
import type { AccessGroupDirectory } from "./module"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const TenantPathSchema = Type.Object({ tenant_id: Identifier })
const AccessGroupPathSchema = Type.Object({ tenant_id: Identifier, access_group_id: Identifier })

export const accessGroupHttp: FastifyPluginAsync<{ directory: AccessGroupDirectory }> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get("/v1/tenants/:tenant_id/access-groups", {
    schema: { operationId: "listAccessGroups", tags: ["Identity"], params: TenantPathSchema, response: { 200: Type.Array(AccessGroupSchema) } },
  }, (request) => options.directory.list(request.principal!))
  routes.get("/v1/tenants/:tenant_id/access-groups/:access_group_id", {
    schema: { operationId: "getAccessGroup", tags: ["Identity"], params: AccessGroupPathSchema, response: { 200: AccessGroupSchema } },
  }, (request) => options.directory.get(request.principal!, request.params.access_group_id))
  routes.put("/v1/tenants/:tenant_id/access-groups/:access_group_id", {
    schema: { operationId: "saveAccessGroup", tags: ["Identity"], params: AccessGroupPathSchema, body: SaveAccessGroupSchema, response: { 200: AccessGroupSchema } },
  }, (request) => options.directory.save(request.principal!, request.params.access_group_id, request.body, { correlationId: request.id }))
  routes.put("/v1/tenants/:tenant_id/access-groups/:access_group_id/members", {
    schema: { operationId: "replaceAccessGroupMembers", tags: ["Identity"], params: AccessGroupPathSchema, body: ReplaceAccessGroupMembersSchema, response: { 200: AccessGroupSchema } },
  }, (request) => options.directory.replaceMembers(request.principal!, request.params.access_group_id, request.body, { correlationId: request.id }))
  routes.get("/v1/tenants/:tenant_id/access-groups/:access_group_id/revisions", {
    schema: { operationId: "listAccessGroupRevisions", tags: ["Identity"], params: AccessGroupPathSchema, response: { 200: Type.Array(AccessGroupSchema) } },
  }, (request) => options.directory.history(request.principal!, request.params.access_group_id))
}
