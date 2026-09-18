import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import type { PublicModelCatalog } from "../src/capabilities/models/module"
import type { PublicModel } from "../src/capabilities/models/contract"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

const model = (overrides: Partial<PublicModel>): PublicModel => ({
  tenant_id: "tenant-acme",
  model_id: "model-default",
  model_name: "default-model",
  display_name: "Default model",
  resource_id: "resource-vertex",
  visibility: "PUBLIC",
  lifecycle: "PUBLISHED",
  capabilities: ["CHAT"],
  created_at: 1,
  ...overrides,
})

test("invocation model inventory resolves trusted subject and client entitlements", async () => {
  const base = createInMemoryPlatformModules()
  const resolved: Array<{ tenantId: string; subjectId: string; clientId: string }> = []
  const catalog: PublicModelCatalog = {
    ...base.models,
    async list(input) {
      assert.deepEqual(input, { tenantId: "tenant-acme", visibility: "PUBLIC" })
      return [
        model({ model_id: "model-allowed", model_name: "allowed", display_name: "Allowed" }),
        model({ model_id: "model-private", visibility: "PRIVATE", model_name: "private", display_name: "Private" }),
        model({ model_id: "model-deprecated", lifecycle: "DEPRECATED", model_name: "deprecated", display_name: "Deprecated" }),
      ]
    },
  }
  const entitlementResolver = {
    async resolve(input: { tenantId: string; subjectId: string; clientId: string }) {
      resolved.push(input)
      return ["model-allowed", "model-private", "model-deprecated", "model-attacker"]
    },
  }
  const modules = { ...base, models: catalog }
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      invocation: {
        tenant_id: "tenant-acme",
        subject_id: "person-anrita",
        role: "USER",
        organization_ids: [],
        client_id: "genio-one-bot",
        scopes: ["genioone-invocation"],
      },
    }),
    entitlementResolver,
  })

  const response = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/me/models?subject_id=attacker&client_id=attacker",
    headers: { authorization: "Bearer invocation" },
  })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json().map((item: PublicModel) => item.model_id), ["model-allowed"])
  assert.deepEqual(resolved, [{ tenantId: "tenant-acme", subjectId: "person-anrita", clientId: "genio-one-bot" }])
  await app.close()
})
