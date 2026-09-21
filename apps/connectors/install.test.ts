import { expect, test } from "bun:test"

import { ensureResourceCapabilityPolicy, type Api } from "./install"

test("resource capability policy replaces a stale draft, publishes the reviewed revision, and reuses it", async () => {
  const base = "/v1/tenants/tenant"
  const steps = [{ step_id: "authenticate" }]
  const writes: Array<{ path: string; body: Record<string, unknown> }> = []
  let draft: any = {
    version: 3,
    base_revision: 0,
    content_digest: "stale-draft",
    lifecycle: "DRAFT",
    content: { kind: "RESOURCE_CAPABILITY", definition: { one_policy_revision: 1, steps: [{ step_id: "stale" }] } },
  }
  let chain: any
  const api: Api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path.endsWith("/enforcement-chain")) {
      if (!chain) throw new Error(`STANDARD_INSTALL_HTTP_404:${path}`)
      return chain as T
    }
    if (path.endsWith("/policy-draft")) {
      if (!init) return draft as T
      writes.push({ path, body })
      draft = {
        version: draft.version + 1,
        base_revision: body.base_revision,
        content_digest: "replacement-draft",
        lifecycle: "DRAFT",
        content: body.content,
      }
      return draft as T
    }
    if (path.endsWith("/policy-draft/validate")) {
      writes.push({ path, body })
      draft = { ...draft, lifecycle: "VALIDATED" }
      return draft as T
    }
    if (path.endsWith("/policy-draft/review")) {
      writes.push({ path, body })
      draft = { ...draft, lifecycle: "REVIEWED" }
      return draft as T
    }
    if (path.endsWith("/policy-draft/publish")) {
      writes.push({ path, body })
      chain = {
        one_policy_revision: draft.content.definition.one_policy_revision,
        chain: { eligible_connection_ids: ["connection"], steps: draft.content.definition.steps },
      }
      draft = null
      return chain as T
    }
    throw new Error(`Unexpected path ${path}`)
  }

  const first = await ensureResourceCapabilityPolicy(api, {
    base,
    resourceId: "resource",
    capabilityId: "mcp.invoke",
    steps,
  })
  expect(first.one_policy_revision).toBe(1)
  expect(writes.map((write) => write.path.split("/").at(-1))).toEqual(["policy-draft", "validate", "review", "publish"])
  expect(writes[0]?.body).toMatchObject({ expected_version: 3, base_revision: 0 })
  expect(writes.slice(1).every((write) => write.body.expected_content_digest === "replacement-draft")).toBe(true)
  const writeCount = writes.length
  const repeated = await ensureResourceCapabilityPolicy(api, {
    base,
    resourceId: "resource",
    capabilityId: "mcp.invoke",
    steps,
  })
  expect(repeated.one_policy_revision).toBe(1)
  expect(writes).toHaveLength(writeCount)
})
