import assert from "node:assert/strict"
import test from "node:test"

import { createMcpOAuthSecretCodec } from "../src/capabilities/mcp-oauth/crypto"

test("MCP OAuth codec preserves the versioned AES-GCM envelope", () => {
  const codec = createMcpOAuthSecretCodec(Buffer.alloc(32, 5))
  const value = {
    state: "state-1",
    tokens: { access_token: "access-1", refresh_token: "refresh-1" },
  }
  const sealed = codec.seal(value)
  assert.equal(sealed.split(".").length, 4)
  assert.deepEqual(codec.open(sealed), value)
})

test("MCP OAuth codec rejects malformed, non-canonical, and oversized values", () => {
  const codec = createMcpOAuthSecretCodec(Buffer.alloc(32, 5))
  const sealed = codec.seal({ state: "state-1" })
  const parts = sealed.split(".")
  for (const value of [
    "invalid",
    `v2.${parts[1]}.${parts[2]}.${parts[3]}`,
    `v1.AA.${parts[2]}.${parts[3]}`,
    `v1.${parts[1]}.AA.${parts[3]}`,
    `${sealed}=`,
  ]) {
    assert.throws(() => codec.open(value), /MCP OAuth sealed value is invalid/)
  }
  assert.throws(
    () => codec.seal({ value: "x".repeat(1_048_577) }),
    /MCP OAuth sealed value is invalid/,
  )
})
