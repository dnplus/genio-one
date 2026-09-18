import { test, expect } from "bun:test"
import { createPersonalCredentials, createMemoryPasswordCredentialStore } from "../src/capabilities/personal-credentials/module"
import { createMcpOAuthSecretCodec } from "../src/capabilities/mcp-oauth/crypto"
import type { ResourceConnectionRegistry } from "../src/capabilities/connections/module"

test("Mail2000 password binding is encrypted, owner-bound and revoked as one service", async () => {
  const store = createMemoryPasswordCredentialStore()
  let lifecycle = "ENABLED"
  const service = createPersonalCredentials({ identity: { async canonicalSubjectId(input) { return input.subjectId === "external-alice" ? "alice" : input.subjectId } }, store, codec: createMcpOAuthSecretCodec(Buffer.alloc(32, 4)), connections: {
    async get() { return { connection_kind: "MCP", downstream_identity: { mode: "USER_PASSWORD" }, lifecycle } },
    async list() { return [{ connection_id: "mail", connection_kind: "MCP", downstream_identity: { mode: "USER_PASSWORD" }, lifecycle, status: "READY" }] },
  } as unknown as ResourceConnectionRegistry })
  const owner = { tenantId: "tenant", resourceId: "mail2000", connectionId: "mail", subjectId: "alice" }
  expect((await service.save(owner, { username: "alice", password: "test-password" })).status).toBe("SAVED")
  expect(await store.get(owner)).not.toContain("test-password")
  expect(JSON.stringify(await service.status(owner))).not.toContain("alice")
  expect(await service.resolve(owner)).toEqual({ username: "alice", password: "test-password" })
  const headers = await service.resolveRequestHeaders({ ...owner, subjectId: "external-alice" })
  expect(headers).toHaveLength(1)
  expect(headers[0]!.name).toStartWith("x-genio-mcp-oauth-")
  expect(headers[0]!.value).toBe(`Basic ${Buffer.from("alice:test-password").toString("base64")}`)
  await expect(service.resolve({ ...owner, subjectId: "bob" })).rejects.toThrow("PASSWORD_CONNECTION_REQUIRED")
  await expect(service.resolve({ ...owner, tenantId: "other" })).rejects.toThrow("PASSWORD_CONNECTION_REQUIRED")
  await store.put({ ...owner, subjectId: "bob" }, (await store.get(owner))!)
  await expect(service.resolve({ ...owner, subjectId: "bob" })).rejects.toThrow("PASSWORD_CREDENTIAL_BINDING_INVALID")
  lifecycle = "REVOKED"
  await expect(service.resolve(owner)).rejects.toThrow("PASSWORD_CONNECTION_NOT_ENABLED")
  lifecycle = "ENABLED"
  await service.remove(owner)
  expect((await service.status(owner)).status).toBe("NEEDS_CONNECTION")
  await expect(service.resolve(owner)).rejects.toThrow("PASSWORD_CONNECTION_REQUIRED")
  await expect(service.resolveRequestHeaders({ ...owner, subjectId: "external-alice" })).rejects.toThrow("PASSWORD_CONNECTION_REQUIRED")
  expect(await service.resolveRequestHeaders({ ...owner, subjectId: "external-alice", credentialsOptional: true })).toEqual([])
})

test("changing a connector site requires fresh personal credentials", async () => {
  let endpoint = "https://connector.test/mcp/site-a"
  const service = createPersonalCredentials({ store: createMemoryPasswordCredentialStore(), codec: createMcpOAuthSecretCodec(Buffer.alloc(32, 5)), identity: { async canonicalSubjectId(input) { return input.subjectId } }, connections: {
    async get() { return { endpoint, connector_configuration: { kind: "mail2000" }, connection_kind: "MCP", downstream_identity: { mode: "USER_PASSWORD" }, lifecycle: "ENABLED" } },
  } as unknown as ResourceConnectionRegistry })
  const owner = { tenantId: "tenant", resourceId: "resource", connectionId: "connection", subjectId: "person" }
  await service.save(owner, { username: "user", password: "original-password" })
  expect((await service.resolve(owner)).username).toBe("user")
  endpoint = "https://connector.test/mcp/site-b"
  await expect(service.resolve(owner)).rejects.toThrow("PASSWORD_CONNECTION_REQUIRED")
  expect((await service.status(owner)).status).toBe("NEEDS_CONNECTION")
  await service.save(owner, { username: "new-user", password: "new-password" })
  expect((await service.resolve(owner)).username).toBe("new-user")
})
