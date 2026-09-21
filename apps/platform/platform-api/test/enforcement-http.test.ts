import assert from "node:assert/strict"
import test from "node:test"

import Fastify from "fastify"

import { enforcementHttp } from "../src/capabilities/enforcement/http"
import type {
  CompileEnforcementChainInput,
  CompiledEnforcementChain,
} from "../src/capabilities/enforcement/contract"
import type {
  EnforcementChainCompiler,
  EnforcementChainRevision,
  EnforcementChainRevisionReader,
} from "../src/capabilities/enforcement/module"

const steps: CompileEnforcementChainInput["steps"] = [
  {
    step_id: "authenticate",
    kind: "AUTHENTICATE",
    phase: "REQUEST",
    implementation: "NATIVE",
    config: {
      schema_version: "genio.one.auth.jwt.v1",
      provider: "keycloak",
      issuer: "https://identity.example.test/realms/acme",
      audiences: ["genio-one"],
      remote_jwks_uri: "https://identity.example.test/realms/acme/protocol/openid-connect/certs",
      subject_claim: "sub",
      client_claim: "azp",
    },
  },
  {
    step_id: "authorize",
    kind: "AUTHORIZE",
    phase: "REQUEST",
    implementation: "EXT_AUTH",
    depends_on: ["authenticate"],
  },
  {
    step_id: "route",
    kind: "ROUTE",
    phase: "ROUTING",
    implementation: "AIGW_NATIVE",
    depends_on: ["authorize"],
  },
]

function compiled(value: CompileEnforcementChainInput): CompiledEnforcementChain {
  return {
    chain_id: "chain-http",
    tenant_id: "tenant-acme",
    resource_id: value.resource_id,
    capability_id: value.capability_id,
    eligible_connection_ids: value.eligible_connection_ids,
    one_policy_revision: value.one_policy_revision,
    steps: value.steps,
    request_filter_order: ["authorize"],
    response_filter_order: [],
  }
}

test("direct Enforcement Chain writes are retired", async () => {
  let compileInput: { tenantId: string; value: CompileEnforcementChainInput } | null = null
  const compiler: EnforcementChainCompiler = {
    async listEligibleConnectionIds() {
      return ["connection-openai", "connection-ollama"]
    },
    async compile(input) {
      compileInput = input
      return compiled(input.value)
    },
  }
  const chain = compiled({
    resource_id: "resource-ai",
    capability_id: "chat",
    eligible_connection_ids: ["connection-openai", "connection-ollama"],
    one_policy_revision: 7,
    steps,
  })
  const revision: EnforcementChainRevision = {
    tenant_id: "tenant-acme",
    resource_id: "resource-ai",
    capability_id: "chat",
    one_policy_revision: 7,
    chain,
    chain_digest: "a".repeat(64),
    published_by_subject_id: "system",
    reviewed_by_subject_id: null,
    rollback_source_one_policy_revision: null,
    created_at: 1,
    updated_at: 1,
  }
  const store: EnforcementChainRevisionReader = {
    async listInventory() {
      return []
    },
    async save(input) {
      if (input.chain.eligible_connection_ids.includes("connection-openai")) {
        assert.deepEqual(input.chain, chain)
      }
      return { ...revision, chain: input.chain }
    },
    async get() {
      return revision
    },
    async getLatest() {
      return revision
    },
    async publishDraft() {
      return revision
    },
  }

  const app = Fastify()
  await app.register(enforcementHttp, { compiler, revisionStore: store })
  const response = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/resources/resource-ai/capabilities/chat/enforcement-chain",
    payload: { one_policy_revision: 7, steps },
  })
  assert.equal(response.statusCode, 410, response.body)
  assert.equal(JSON.parse(response.body).code, "ENFORCEMENT_DIRECT_WRITE_RETIRED")
  assert.equal(compileInput, null)

  const latest = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/resources/resource-ai/capabilities/chat/enforcement-chain",
  })
  assert.equal(latest.statusCode, 200, latest.body)
  assert.equal(JSON.parse(latest.body).one_policy_revision, 7)

  const bodyInjection = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/resources/resource-ai/capabilities/chat/enforcement-chain",
    payload: {
      one_policy_revision: 7,
      steps,
      eligible_connection_ids: ["attacker-connection"],
    },
  })
  assert.equal(bodyInjection.statusCode, 410, bodyInjection.body)
  await app.close()
})
