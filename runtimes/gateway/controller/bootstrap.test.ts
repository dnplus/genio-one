import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { materializeGatewayBootstrap } from "./bootstrap"

function publicKey(): string {
  return generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
}

function privateKey(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString()
}

test("Gateway Runtime materializes a one-time bootstrap into private runtime files", async () => {
  const root = await mkdtemp(join(tmpdir(), "genio-one-gateway-bootstrap-"))
  try {
    const path = join(root, "bootstrap.json")
    await writeFile(path, JSON.stringify({
      schema_version: "genio.one.gateway-bootstrap.v1",
      registration: {
        tenant_id: "tenant-1",
        runtime_id: "gateway-1",
        display_name: "Gateway 1",
        gateway_id: "ai-gateway",
        site_id: "taipei",
        region: "ap-east",
        labels: { environment: "test" },
        identity_client_id: "gateway-1",
        state: "ACTIVE",
        registered_by: "person-admin",
        registered_at: 1,
        activated_at: 1,
        retired_at: null,
        row_revision: 2,
      },
      platform_origin: "http://127.0.0.1:58082",
      tenant_id: "tenant-1",
      runtime_id: "gateway-1",
      gateway_id: "ai-gateway",
      oidc: {
        issuer: "http://127.0.0.1:58080/realms/genio-one",
        token_endpoint: "http://127.0.0.1:58080/realms/genio-one/protocol/openid-connect/token",
        audience: "genio-one-product-api",
        scope: "genioone-gateway-runtime",
        client_id: "gateway-1",
        client_secret: "runtime-secret",
      },
      report_signing: {
        key_id: "gateway-1-report",
        private_key_pem: privateKey(),
      },
      runtime_command_verification_keys: {
        schema_version: 1,
        keys: [{ key_id: "command-1", public_key_pem: publicKey() }],
      },
      policy_release_root_keys: {
        schema_version: 1,
        keys: [{ key_id: "release-1", public_key_pem: publicKey() }],
      },
      credential_delivery: "ONE_TIME",
    }))

    const result = await materializeGatewayBootstrap({ path, stateRoot: join(root, "state") })

    assert.equal(result.bootstrap.runtime_id, "gateway-1")
    assert.equal((await readFile(result.clientIdFile, "utf8")).trim(), "gateway-1")
    assert.equal((await readFile(result.clientSecretFile, "utf8")).trim(), "runtime-secret")
    assert.equal((await stat(result.clientSecretFile)).mode & 0o777, 0o600)
    assert.equal((await stat(result.reportPrivateKeyPath)).mode & 0o777, 0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Gateway Runtime rejects inconsistent bootstrap identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "genio-one-gateway-bootstrap-invalid-"))
  try {
    const path = join(root, "bootstrap.json")
    await writeFile(path, JSON.stringify({
      schema_version: "genio.one.gateway-bootstrap.v1",
      registration: {
        tenant_id: "tenant-1",
        runtime_id: "different-runtime",
        display_name: "Gateway 1",
        gateway_id: "ai-gateway",
        site_id: "taipei",
        region: "ap-east",
        labels: {},
        identity_client_id: "gateway-1",
        state: "ACTIVE",
        registered_by: "person-admin",
        registered_at: 1,
        activated_at: 1,
        retired_at: null,
        row_revision: 2,
      },
      platform_origin: "http://127.0.0.1:58082",
      tenant_id: "tenant-1",
      runtime_id: "gateway-1",
      gateway_id: "ai-gateway",
      oidc: {
        issuer: "http://127.0.0.1:58080/realms/genio-one",
        token_endpoint: "http://127.0.0.1:58080/realms/genio-one/protocol/openid-connect/token",
        audience: "genio-one-product-api",
        scope: "genioone-gateway-runtime",
        client_id: "gateway-1",
        client_secret: "runtime-secret",
      },
      report_signing: {
        key_id: "gateway-1-report",
        private_key_pem: privateKey(),
      },
      runtime_command_verification_keys: {
        schema_version: 1,
        keys: [{ key_id: "command-1", public_key_pem: publicKey() }],
      },
      policy_release_root_keys: {
        schema_version: 1,
        keys: [{ key_id: "release-1", public_key_pem: publicKey() }],
      },
      credential_delivery: "ONE_TIME",
    }))

    await assert.rejects(
      materializeGatewayBootstrap({ path, stateRoot: join(root, "state") }),
      /identity is inconsistent/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
