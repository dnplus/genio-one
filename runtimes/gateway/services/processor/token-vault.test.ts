import assert from "node:assert/strict"
import test from "node:test"

import type { RedisClientType } from "redis"

import type { ProcessingContext } from "./contract"
import { EncryptedValkeyTokenVault } from "./token-vault"

const context: ProcessingContext = {
  tenantId: "tenant-1",
  subjectId: "person-1",
  clientId: "client-1",
  resourceId: "resource-1",
  capabilityId: "model.invoke",
  sessionId: "session-1",
  correlationId: "correlation-1",
}

function fixture() {
  const values = new Map<string, string>()
  const client = {
    isOpen: true,
    async connect() {},
    async get(key: string) {
      return values.get(key) ?? null
    },
    async set(key: string, value: string) {
      values.set(key, value)
      return "OK"
    },
    async quit() {},
  } as unknown as RedisClientType
  return {
    values,
    vault: new EncryptedValkeyTokenVault("redis://unused", Buffer.alloc(32, 7), client),
  }
}

test("token vault validates and decrypts its strict ciphertext envelope", async () => {
  const { vault } = fixture()
  await vault.store(context, "<EMAIL:ABC123>", "user@example.com", 600)
  assert.equal(
    await vault.resolve(context, "<EMAIL:ABC123>"),
    "user@example.com",
  )
})

test("token vault rejects malformed, extended, and invalid-sized envelopes", async () => {
  for (const encoded of [
    "not-json",
    JSON.stringify({ iv: "AA", tag: "AA", ciphertext: "AA" }),
    JSON.stringify({
      iv: Buffer.alloc(12).toString("base64url"),
      tag: Buffer.alloc(16).toString("base64url"),
      ciphertext: "AA",
      secret: "unexpected",
    }),
  ]) {
    const { vault, values } = fixture()
    await vault.store(context, "<EMAIL:ABC123>", "user@example.com", 600)
    const key = values.keys().next().value
    assert.equal(typeof key, "string")
    values.set(key!, encoded)
    await assert.rejects(
      vault.resolve(context, "<EMAIL:ABC123>"),
      /token vault entry is invalid/,
    )
  }
})

test("token vault rejects invalid tokens, oversized values, and unsafe TTLs before Valkey", async () => {
  const { vault, values } = fixture()
  await assert.rejects(
    vault.store(context, "../../other-key", "value", 600),
    /token vault token is invalid/,
  )
  await assert.rejects(
    vault.store(context, "<EMAIL:ABC123>", "x".repeat(1_048_577), 600),
    /token vault value is too large/,
  )
  await assert.rejects(
    vault.store(context, "<EMAIL:ABC123>", "value", 59),
    /token vault TTL is invalid/,
  )
  assert.equal(values.size, 0)
})
