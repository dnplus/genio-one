import assert from "node:assert/strict"
import test from "node:test"

import {
  DISTILLATION_EXTRACTOR_VERSION,
  LEGACY_DISTILLATION_EXTRACTOR_VERSION,
} from "@genioone/protocol/distillation-triage"
import * as Value from "typebox/value"

import Fastify from "fastify"

import { distillationHttp } from "../src/capabilities/distillation/http"
import { DistillationMarkerSchema } from "../src/capabilities/distillation/contract"
import type { AccessGroupDirectory } from "../src/capabilities/access-groups/module"
import { createInMemoryDistillationStore } from "../src/capabilities/distillation/memory"
import type { OrganizationDirectory } from "../src/capabilities/organizations/module"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"

const digest = "a".repeat(64)

const principal: Principal = {
  tenant_id: "tenant-http",
  subject_id: "owner-http",
  client_id: "bot-http",
  role: "USER",
  organization_ids: [],
}

function markerBody(threadId: string, workspaceId?: string | null): Record<string, unknown> {
  return {
    bot_id: "bot-http",
    thread_id: threadId,
    turn_ids: ["turn-http"],
    source_revision: digest,
    content_digest: digest,
    scope_hint: "process",
    sensitivity: "standard",
    knowledge_type: "PROCEDURE",
    representation: "BOTH",
    classifier_version: "jev-distillation-1",
    extractor_version: DISTILLATION_EXTRACTOR_VERSION,
    evidence: [],
    excerpt_truncated: false,
    ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
  }
}

async function appFor(input: { groupIds: readonly string[]; workspace: boolean }) {
  let nextId = 0
  const store = createInMemoryDistillationStore({ now: () => 0, idFactory: () => String(++nextId) })
  const workspace = input.workspace
    ? await store.createWorkspace({
      tenantId: principal.tenant_id,
      createdBy: principal.subject_id,
      value: {
        organization_id: "organization-http",
        display_name: "Workspace HTTP",
        reader_access_group_id: "readers-http",
        contributor_access_group_id: "contributors-http",
        maintainer_access_group_id: "maintainers-http",
      },
    })
    : null
  const listWorkspaces = store.listWorkspaces.bind(store)
  let groupCalls = 0
  let workspaceCalls = 0
  store.listWorkspaces = async (tenantId) => {
    workspaceCalls += 1
    return listWorkspaces(tenantId)
  }
  const accessGroups = {
    async groupsForSubject() {
      groupCalls += 1
      return input.groupIds.map((access_group_id) => ({ access_group_id, enabled: true }))
    },
  } as unknown as AccessGroupDirectory
  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (request) => {
    request.principal = principal
  })
  await app.register(distillationHttp, {
    store,
    accessGroups,
    organizations: {} as OrganizationDirectory,
  })
  return {
    app,
    workspace,
    calls: () => ({ groupCalls, workspaceCalls }),
  }
}

test("unbound marker creation skips workspace ACL lookup", async () => {
  const fixture = await appFor({ groupIds: [], workspace: false })
  try {
    const omitted = await fixture.app.inject({
      method: "POST",
      url: "/v1/tenants/tenant-http/distillation-markers",
      payload: markerBody("thread-omitted"),
    })
    const explicitNull = await fixture.app.inject({
      method: "POST",
      url: "/v1/tenants/tenant-http/distillation-markers",
      payload: markerBody("thread-null", null),
    })
    assert.equal(omitted.statusCode, 200, omitted.body)
    assert.equal(explicitNull.statusCode, 200, explicitNull.body)
    assert.deepEqual(fixture.calls(), { groupCalls: 0, workspaceCalls: 0 })
  } finally {
    await fixture.app.close()
  }
})

test("bound marker creation still requires contributor workspace access", async () => {
  const fixture = await appFor({ groupIds: [], workspace: true })
  try {
    assert.ok(fixture.workspace)
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/tenants/tenant-http/distillation-markers",
      payload: markerBody("thread-bound", fixture.workspace.workspace_id),
    })
    assert.equal(response.statusCode, 403, response.body)
    assert.deepEqual(fixture.calls(), { groupCalls: 1, workspaceCalls: 1 })
  } finally {
    await fixture.app.close()
  }
})

test("marker submission and stored responses accept both extractor versions during a rolling upgrade", async () => {
  const fixture = await appFor({ groupIds: [], workspace: false })
  try {
    const created = await fixture.app.inject({
      method: "POST",
      url: "/v1/tenants/tenant-http/distillation-markers",
      payload: markerBody("thread-current"),
    })
    assert.equal(created.statusCode, 200, created.body)
    assert.equal(Value.Check(DistillationMarkerSchema, {
      ...(created.json() as Record<string, unknown>),
      extractor_version: LEGACY_DISTILLATION_EXTRACTOR_VERSION,
    }), true)

    const legacyCreate = await fixture.app.inject({
      method: "POST",
      url: "/v1/tenants/tenant-http/distillation-markers",
      payload: { ...markerBody("thread-legacy"), extractor_version: LEGACY_DISTILLATION_EXTRACTOR_VERSION },
    })
    assert.equal(legacyCreate.statusCode, 200, legacyCreate.body)
  } finally {
    await fixture.app.close()
  }
})
