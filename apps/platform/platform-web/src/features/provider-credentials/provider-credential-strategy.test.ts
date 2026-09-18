import assert from "node:assert/strict"
import test from "node:test"

import {
  buildProviderCredentialStrategy,
  defaultLlmConnectionName,
  defaultLlmResourceName,
} from "./provider-credential-strategy"

test("LLM default names follow the selected Provider display name", () => {
  assert.equal(defaultLlmResourceName("OpenAI"), "OpenAI Model")
  assert.equal(defaultLlmConnectionName("OMLX (local)"), "OMLX (local) Connection")
})

test("static secret strategy stores only the opaque reference", () => {
  assert.deepEqual(
    buildProviderCredentialStrategy({
      kind: "STATIC_SECRET_REFERENCE",
      secretReference: " vault:openai ",
      projectName: "",
      region: "us-central1",
      issuer: "",
      clientId: "",
      audience: "",
      projectId: "",
      poolName: "",
      providerName: "",
      serviceAccountName: "",
    }),
    { kind: "STATIC_SECRET_REFERENCE", secret_ref: "vault:openai" },
  )
})
