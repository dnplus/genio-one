import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  bootstrapPathFromArguments,
  forwardRuntimeSignal,
  localGatewayRuntimeEnvironment,
  localGatewayStartConfiguration,
} from "./start-local-gateway.mjs"

function bootstrap(runtimeId = "gateway-taipei-1") {
  return {
    schema_version: "genio.one.gateway-bootstrap.v1",
    registration: {
      tenant_id: "tenant-local", runtime_id: runtimeId, display_name: "Taipei Gateway", gateway_id: "genio-ai-mcp-gateway",
      site_id: "taipei", region: "ap-east", labels: {}, identity_client_id: runtimeId, state: "ACTIVE",
      registered_by: "person-platform-admin", registered_at: 1, activated_at: 1, retired_at: null, row_revision: 1,
    },
    platform_origin: "http://127.0.0.1:58082", tenant_id: "tenant-local", runtime_id: runtimeId, gateway_id: "genio-ai-mcp-gateway",
    oidc: {
      issuer: "http://127.0.0.1:58080/realms/genio-one",
      token_endpoint: "http://127.0.0.1:58080/realms/genio-one/protocol/openid-connect/token",
      audience: "genio-one-product-api", scope: "genioone-gateway-runtime", client_id: runtimeId, client_secret: "one-time-client-secret",
    },
    report_signing: { key_id: `${runtimeId}-report`, private_key_pem: "private-key" },
    runtime_command_verification_keys: { schema_version: 1, keys: [{ key_id: "command", public_key_pem: "public-key" }] },
    policy_release_root_keys: { schema_version: 1, keys: [{ key_id: "release", public_key_pem: "public-key" }] },
    credential_delivery: "ONE_TIME",
  }
}

async function fixture() {
  const appRoot = await mkdtemp(join(tmpdir(), "genio-one-start-local-gateway-"))
  const bootstrapDirectory = join(appRoot, ".local/gateway-bootstrap")
  const bootstrapPath = join(bootstrapDirectory, "taipei.json")
  const aigwPath = join(appRoot, ".local/aigw/current/aigw")
  await mkdir(bootstrapDirectory, { recursive: true })
  await mkdir(join(appRoot, ".local/aigw/current"), { recursive: true })
  await writeFile(bootstrapPath, JSON.stringify(bootstrap()))
  await chmod(bootstrapPath, 0o600)
  await writeFile(aigwPath, "binary")
  await chmod(aigwPath, 0o755)
  return {
    appRoot,
    bootstrapPath,
    environment: { GENIO_ONE_VALKEY_URL: "redis://127.0.0.1:56379" },
  }
}

test("local Gateway launcher derives absolute private state from the OIDC bootstrap", async () => {
  const { appRoot, bootstrapPath, environment } = await fixture()
  try {
    const configuration = await localGatewayStartConfiguration({ appRoot, environment, argumentsList: ["--bootstrap", bootstrapPath] })
    assert.equal(configuration.bootstrapPath, bootstrapPath)
    assert.equal(configuration.runtimeId, "gateway-taipei-1")
    assert.equal(configuration.stateRoot, join(appRoot, ".local/gateway-runtime/gateway-taipei-1"))
    assert.equal(configuration.aigwBinary, join(appRoot, ".local/aigw/current/aigw"))
    const runtimeEnvironment = localGatewayRuntimeEnvironment(configuration, { GENIO_ONE_LOCAL_CREDENTIALS_JSON: "{}" })
    assert.equal(runtimeEnvironment.GENIO_ONE_GATEWAY_APPLY_MODE, "LOCAL_AIGW")
    assert.equal(runtimeEnvironment.GENIO_ONE_VALKEY_ORIGIN, "redis://127.0.0.1:56379")
    assert.match(runtimeEnvironment.GENIO_ONE_TOKEN_VAULT_KEY, /^[A-Za-z0-9+/]{43}=$/)
  } finally {
    await rm(appRoot, { recursive: true, force: true })
  }
})

test("local Gateway launcher resolves its bootstrap from the invoking repository directory", async () => {
  const { appRoot, bootstrapPath, environment } = await fixture()
  try {
    const configuration = await localGatewayStartConfiguration({
      appRoot,
      environment,
      cwd: appRoot,
      argumentsList: ["--bootstrap", ".local/gateway-bootstrap/taipei.json"],
    })
    assert.equal(configuration.bootstrapPath, bootstrapPath)
  } finally {
    await rm(appRoot, { recursive: true, force: true })
  }
})

test("local Gateway launcher requires the ignored 0600 bootstrap path", async () => {
  const { appRoot, bootstrapPath, environment } = await fixture()
  try {
    await chmod(bootstrapPath, 0o644)
    await assert.rejects(localGatewayStartConfiguration({ appRoot, environment, argumentsList: ["--bootstrap", bootstrapPath] }), /mode 0600/)
    await assert.rejects(localGatewayStartConfiguration({ appRoot, environment, argumentsList: ["--bootstrap", join(appRoot, "outside.json")] }), /must be saved below/)
  } finally {
    await rm(appRoot, { recursive: true, force: true })
  }
})

test("local Gateway maps Valkey URL and persists a non-symlink token vault key", async () => {
  const { appRoot, bootstrapPath, environment } = await fixture()
  try {
    const first = await localGatewayStartConfiguration({ appRoot, environment, argumentsList: ["--bootstrap", bootstrapPath] })
    const second = await localGatewayStartConfiguration({ appRoot, environment, argumentsList: ["--bootstrap", bootstrapPath] })
    assert.equal(first.valkeyOrigin, environment.GENIO_ONE_VALKEY_URL)
    assert.equal(first.tokenVaultKey, second.tokenVaultKey)
    const keyPath = join(appRoot, ".local/gateway-runtime/keys/token-vault.key")
    await rm(keyPath)
    const target = join(appRoot, "outside-token-vault.key")
    await writeFile(target, first.tokenVaultKey)
    await chmod(target, 0o600)
    await symlink(target, keyPath)
    await assert.rejects(
      localGatewayStartConfiguration({ appRoot, environment, argumentsList: ["--bootstrap", bootstrapPath] }),
      /must be a regular file/,
    )
  } finally {
    await rm(appRoot, { recursive: true, force: true })
  }
})

test("local Gateway rejects a symlinked runtime state ancestor without writing its target", async () => {
  const { appRoot, bootstrapPath, environment } = await fixture()
  try {
    const target = join(appRoot, "outside-runtime-state")
    await mkdir(target)
    await symlink(target, join(appRoot, ".local/gateway-runtime"))
    await assert.rejects(
      localGatewayStartConfiguration({ appRoot, environment, argumentsList: ["--bootstrap", bootstrapPath] }),
      /managed state directory must be a regular directory/,
    )
    assert.deepEqual(await readdir(target), [])
  } finally {
    await rm(appRoot, { recursive: true, force: true })
  }
})

test("local Gateway validates explicit Valkey and token vault overrides", async () => {
  const { appRoot, bootstrapPath, environment } = await fixture()
  try {
    const tokenVaultKey = Buffer.alloc(32, 7).toString("base64")
    const configuration = await localGatewayStartConfiguration({
      appRoot,
      environment: {
        ...environment,
        GENIO_ONE_VALKEY_ORIGIN: "rediss://127.0.0.1:56380/0",
        GENIO_ONE_TOKEN_VAULT_KEY: tokenVaultKey,
      },
      argumentsList: ["--bootstrap", bootstrapPath],
    })
    assert.equal(configuration.valkeyOrigin, "rediss://127.0.0.1:56380/0")
    assert.equal(configuration.tokenVaultKey, tokenVaultKey)
    await assert.rejects(
      localGatewayStartConfiguration({ appRoot, environment: { GENIO_ONE_VALKEY_URL: "http://127.0.0.1:56379" }, argumentsList: ["--bootstrap", bootstrapPath] }),
      /must be a Redis URL/,
    )
    await assert.rejects(
      localGatewayStartConfiguration({ appRoot, environment: { ...environment, GENIO_ONE_TOKEN_VAULT_KEY: "not-a-key" }, argumentsList: ["--bootstrap", bootstrapPath] }),
      /base64-encoded 32-byte key/,
    )
  } finally {
    await rm(appRoot, { recursive: true, force: true })
  }
})

test("local Gateway launcher rejects static runtime tokens and ambiguous arguments", () => {
  assert.throws(() => bootstrapPathFromArguments([]), /requires --bootstrap/)
  assert.throws(() => bootstrapPathFromArguments(["--bootstrap", "first.json", "--bootstrap", "second.json"]), /exactly one/)
  assert.equal(bootstrapPathFromArguments(["--", "--bootstrap", "gateway.json"]), "gateway.json")
  assert.throws(() => localGatewayRuntimeEnvironment({ bootstrapPath: "/bootstrap", aigwBinary: "/aigw", stateRoot: "/state" }, { GENIO_ONE_RUNTIME_TOKEN: "static-token" }), /not accepted/)
})

test("local Gateway launcher forwards termination only while its child is running", () => {
  const signals = []
  const child = { exitCode: null, kill(signal) { signals.push(signal) } }
  forwardRuntimeSignal(child, "SIGTERM")
  child.exitCode = 0
  forwardRuntimeSignal(child, "SIGINT")
  assert.deepEqual(signals, ["SIGTERM"])
})
