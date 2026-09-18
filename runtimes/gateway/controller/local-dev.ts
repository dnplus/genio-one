import { spawn, type ChildProcess } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { networkInterfaces } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"

const appRoot = resolve(import.meta.dirname, "..")
const localRoot = join(appRoot, ".local", "gateway-runtime")
const keyRoot = join(localRoot, "keys")
const platformOrigin = process.env.GENIO_ONE_PLATFORM_ORIGIN ?? "http://127.0.0.1:58082"
const tenantId = process.env.GENIO_ONE_TENANT_ID ?? "tenant-keycloak-local"
const runtimeId = process.env.GENIO_ONE_RUNTIME_ID ?? "gateway-runtime-local"
const gatewayId = process.env.GENIO_ONE_GATEWAY_ID ?? "genio-ai-mcp-gateway"
const apiRuntimeId = process.env.GENIO_ONE_API_RUNTIME_ID ?? "api-gateway-runtime-local"
const apiGatewayId = process.env.GENIO_ONE_API_GATEWAY_ID ?? "genio-api-gateway"
const mcpFixtureOrigin = process.env.GENIO_ONE_LOCAL_MCP_ORIGIN ?? "http://127.0.0.1:19003"
const siemFixtureOrigin = process.env.GENIO_ONE_LOCAL_SIEM_ORIGIN ?? "http://127.0.0.1:19004"
const apiFixtureOrigin = process.env.GENIO_ONE_LOCAL_API_ORIGIN ?? "http://127.0.0.1:19005"
const localIpv4 = Object.values(networkInterfaces()).flat().find((address) =>
  address?.family === "IPv4" && !address.internal
)?.address
const apiPublicHost = process.env.GENIO_ONE_LOCAL_API_PUBLIC_HOST ?? localIpv4 ?? "127.0.0.1"
const adminToken = "genio-one-local-admin"
const runtimeToken = "genio-one-local-runtime"
const apiRuntimeToken = "genio-one-local-api-runtime"
const endpointRuntimeToken = "genio-one-local-endpoint-runtime"
const mcpServiceCredentialRef = "mcp-service-api-key-local"
const mcpServiceApiKey = "genio-one-local-mcp-service-key"
function geminiCredentialValues(): Record<string, string> {
  const raw = process.env.GENIO_ONE_GEMINI_API_KEYS_JSON?.trim()
  if (!raw) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("GENIO_ONE_GEMINI_API_KEYS_JSON must be valid JSON")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GENIO_ONE_GEMINI_API_KEYS_JSON must be an object")
  }
  const result: Record<string, string> = {}
  for (const [slot, secret] of Object.entries(value)) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(slot)) {
      throw new Error("GENIO_ONE_GEMINI_API_KEYS_JSON slots must be lowercase identifiers")
    }
    if (typeof secret !== "string" || !secret.trim()) {
      throw new Error("GENIO_ONE_GEMINI_API_KEYS_JSON values must be non-empty strings")
    }
    result[`gemini-api-key-${slot}`] = secret
  }
  return result
}

const localCredentialValues = {
  [mcpServiceCredentialRef]: mcpServiceApiKey,
  ...geminiCredentialValues(),
}
const localCredentialsJson = JSON.stringify(localCredentialValues)

interface LocalKey {
  privateKeyPath: string
  publicKeyPem: string
}

interface LocalRuntimeGroup {
  runtimeId: string
  gatewayId: string
  token: string
  stateRoot: string
  adminPort: number
  listenerPort: number
  observationPort: number
}

async function localKey(name: string): Promise<LocalKey> {
  await mkdir(keyRoot, { recursive: true })
  const privateKeyPath = join(keyRoot, `${name}.pem`)
  const publicKeyPath = join(keyRoot, `${name}.pub.pem`)
  try {
    return {
      privateKeyPath,
      publicKeyPem: await readFile(publicKeyPath, "utf8"),
    }
  } catch {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519")
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString()
    await Promise.all([
      writeFile(privateKeyPath, privateKeyPem, { mode: 0o600 }),
      writeFile(publicKeyPath, publicKeyPem, { mode: 0o600 }),
    ])
    return { privateKeyPath, publicKeyPem }
  }
}

async function waitFor(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastFailure = "no response"
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastFailure = `HTTP ${response.status}`
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error(`Timed out waiting for ${url}: ${lastFailure}`)
}

function start(entrypoint: string, environment: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [entrypoint], {
    cwd: appRoot,
    env: { ...process.env, ...environment },
    stdio: "inherit",
  })
}

async function registerRuntime(input: {
  runtimeId: string
  gatewayId: string
  token: string
  reportKeyId: string
  reportPublicKeyPem: string
}): Promise<void> {
  const response = await fetch(
    `${platformOrigin}/v1/tenants/${encodeURIComponent(tenantId)}/runtime-control/GATEWAY/${encodeURIComponent(input.runtimeId)}/registration`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        target_id: input.gatewayId,
        oidc_client_id: input.runtimeId,
        report_key_id: input.reportKeyId,
        report_public_key_pem: input.reportPublicKeyPem,
        status: "ACTIVE",
      }),
    },
  )
  if (!response.ok) {
    throw new Error(`Gateway Runtime registration failed (${response.status}): ${await response.text()}`)
  }
}

async function main(): Promise<void> {
  const [projection, runtimeCommand, policyArtifact, releaseRoot, runtimeReport] =
    await Promise.all([
      localKey("projection"),
      localKey("runtime-command"),
      localKey("policy-artifact"),
      localKey("release-root"),
      localKey("runtime-report"),
    ])
  const commandKeyRingPath = join(keyRoot, "runtime-command-keyring.json")
  const releaseRootKeyRingPath = join(keyRoot, "release-root-keyring.json")
  await writeFile(commandKeyRingPath, `${JSON.stringify({
    schema_version: 1,
    keys: [{
      key_id: "runtime-command-local",
      public_key_pem: runtimeCommand.publicKeyPem,
    }],
  }, null, 2)}\n`, { mode: 0o600 })
  await writeFile(releaseRootKeyRingPath, `${JSON.stringify({
    schema_version: 1,
    keys: [{
      key_id: "release-root-local",
      public_key_pem: releaseRoot.publicKeyPem,
    }],
  }, null, 2)}\n`, { mode: 0o600 })

  const principals = JSON.stringify({
    [adminToken]: {
      tenant_id: tenantId,
      subject_id: "person-platform-admin",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: ["organization-local"],
      client_id: "platform-console",
    },
    [runtimeToken]: {
      tenant_id: tenantId,
      subject_id: runtimeId,
      role: "USER",
      organization_ids: [],
      client_id: runtimeId,
    },
    [apiRuntimeToken]: {
      tenant_id: tenantId,
      subject_id: apiRuntimeId,
      role: "USER",
      organization_ids: [],
      client_id: apiRuntimeId,
    },
    [endpointRuntimeToken]: {
      tenant_id: tenantId,
      subject_id: "person-platform-admin",
      role: "USER",
      organization_ids: [],
      client_id: "genio-one-endpoint-runtime",
      scopes: ["genioone-endpoint-runtime"],
    },
  })
  const issuer = "http://127.0.0.1:58080/realms/genio-one"
  const oidcTenants = JSON.stringify([{
    tenant_id: tenantId,
    identity_provider_id: "keycloak-local",
    issuer,
    audiences: ["genio-one-product-api"],
    jwks_uri: `${issuer}/protocol/openid-connect/certs`,
    algorithms: ["RS256"],
    claims: {
      subject: "sub",
      client: "azp",
      role: "realm_access.roles",
      organizations: "groups",
    },
    principal_mappings: [{
      external_subject_id: "8e1bfeb6-2590-4748-91bc-11d991aca358",
      subject_id: "person-platform-admin",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: [],
    }, {
      external_subject_id: "49601374-7901-4e9d-bc9e-ed1e2536f51e",
      subject_id: "person-platform-admin",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: [],
    }, {
      external_subject_id: "4e9666a6-a5bd-4211-bad9-bdb95ca00bab",
      subject_id: "person-organization-admin",
      role: "ORGANIZATION_ADMINISTRATOR",
      organization_ids: ["org-9e737aa2-fac5-45a8-8e04-81bf0ab87454"],
    }],
  }])
  const browserIdentity = JSON.stringify({
    tenant_id: tenantId,
    issuer,
    authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
    token_endpoint: `${issuer}/protocol/openid-connect/token`,
    client_id: "genio-one-self-service",
    scopes: ["openid", "genioone-invocation"],
    management_client_id: "genio-one-management-console",
    management_scopes: ["openid", "genioone-management"],
  })
  const bootstrapSubjects = JSON.stringify([
    {
      tenant_id: tenantId,
      subject_id: "person-platform-admin",
      kind: "PERSON",
      display_name: "Platform Administrator",
      email: "admin@example.com",
      department: "Platform",
      role: "TENANT_ADMINISTRATOR",
      external_identities: [{
        provider_id: "keycloak-local",
        external_subject_id: "8e1bfeb6-2590-4748-91bc-11d991aca358",
      }, {
        provider_id: "keycloak-local",
        external_subject_id: "49601374-7901-4e9d-bc9e-ed1e2536f51e",
      }],
    },
    {
      tenant_id: tenantId,
      subject_id: "person-organization-admin",
      kind: "PERSON",
      display_name: "Organization Administrator",
      email: "organization-admin@example.com",
      department: "Engineering",
      role: "USER",
      external_identities: [{
        provider_id: "keycloak-local",
        external_subject_id: "4e9666a6-a5bd-4211-bad9-bdb95ca00bab",
      }],
    },
  ])

  const mcpFixture = start("scripts/aigw-local-mcp-fixture.ts", {
    AIGW_LOCAL_MCP_PORT: new URL(mcpFixtureOrigin).port || "19003",
    AIGW_LOCAL_MCP_API_KEY: mcpServiceApiKey,
    AIGW_LOCAL_MCP_USER_TOKEN: "genio-one-local-mcp-user-token",
  })
  const siemFixture = start("scripts/siem-local-fixture.ts", {
    GENIO_ONE_LOCAL_SIEM_PORT: new URL(siemFixtureOrigin).port || "19004",
  })
  const apiFixture = start("scripts/api-upstream-local-fixture.ts", {
    GENIO_ONE_LOCAL_API_LISTEN: "0.0.0.0",
    GENIO_ONE_LOCAL_API_PORT: new URL(apiFixtureOrigin).port || "19005",
  })
  const platform = start("platform-api/src/server.ts", {
    NODE_ENV: "development",
    GENIO_ONE_MANAGEMENT_API_PORT: new URL(platformOrigin).port || "58082",
    GENIO_ONE_PLATFORM_ORIGIN: platformOrigin,
    GENIO_ONE_CONTROL_PLANE_PUBLIC_ORIGIN: platformOrigin,
    GENIO_ONE_KEYCLOAK_ORIGIN: process.env.GENIO_ONE_KEYCLOAK_ORIGIN ?? "http://127.0.0.1:58080",
    GENIO_ONE_KEYCLOAK_ISSUER_ORIGIN: process.env.GENIO_ONE_KEYCLOAK_ISSUER_ORIGIN ?? "http://127.0.0.1:58080",
    GENIO_ONE_KEYCLOAK_REALM: process.env.GENIO_ONE_KEYCLOAK_REALM ?? "genio-one",
    GENIO_ONE_KEYCLOAK_ADMIN: process.env.GENIO_ONE_KEYCLOAK_ADMIN ?? "admin",
    GENIO_ONE_KEYCLOAK_ADMIN_PASSWORD: process.env.GENIO_ONE_KEYCLOAK_ADMIN_PASSWORD ?? "genio-one-local",
    GENIO_ONE_KEYCLOAK_AUDIENCE: process.env.GENIO_ONE_KEYCLOAK_AUDIENCE ?? "genio-one-product-api",
    GENIO_ONE_KEYCLOAK_GATEWAY_RUNTIME_SCOPE: "genioone-gateway-runtime",
    GENIO_ONE_DEFAULT_GATEWAY_ID: gatewayId,
    GENIO_ONE_DATABASE_URL:
      process.env.GENIO_ONE_DATABASE_URL ??
      "postgresql://genio_one:genio-one-local@127.0.0.1:55432/genio_one?sslmode=disable",
    GENIO_ONE_VALKEY_URL: process.env.GENIO_ONE_VALKEY_URL ?? "redis://127.0.0.1:56379",
    GENIO_ONE_TYPESCRIPT_PILOT_TENANT_ID: tenantId,
    GENIO_ONE_LOCAL_GATEWAY_SLICE: "1",
    GENIO_ONE_MANAGEMENT_API_AUTH_MODE: "static-dev",
    GENIO_ONE_MANAGEMENT_API_PRINCIPALS_JSON: principals,
    GENIO_ONE_MANAGEMENT_API_OIDC_TENANTS_JSON: oidcTenants,
    GENIO_ONE_BROWSER_IDENTITY_JSON: browserIdentity,
    GENIO_ONE_BOOTSTRAP_SUBJECTS_JSON: bootstrapSubjects,
    GENIO_ONE_LOCAL_CREDENTIALS_JSON: localCredentialsJson,
    GENIO_ONE_CONNECTION_VERIFIER_ALLOWED_HOSTS: `${apiPublicHost},127.0.0.1,mcp.notion.com,www.googleapis.com,generativelanguage.googleapis.com`,
    GENIO_ONE_MCP_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
    GENIO_ONE_MCP_OAUTH_PUBLIC_ORIGIN: platformOrigin,
    GENIO_ONE_MANAGEMENT_UI_ORIGIN: "http://127.0.0.1:5173",
    GENIO_ONE_GATEWAY_SIGNING_PRIVATE_KEY_FILE: projection.privateKeyPath,
    GENIO_ONE_GATEWAY_SIGNING_KEY_ID: "projection-local",
    GENIO_ONE_RUNTIME_COMMAND_SIGNING_PRIVATE_KEY_FILE: runtimeCommand.privateKeyPath,
    GENIO_ONE_RUNTIME_COMMAND_SIGNING_KEY_ID: "runtime-command-local",
    GENIO_ONE_POLICY_ARTIFACT_SIGNING_PRIVATE_KEY_FILE: policyArtifact.privateKeyPath,
    GENIO_ONE_POLICY_ARTIFACT_SIGNING_KEY_ID: "policy-artifact-local",
    GENIO_ONE_RELEASE_ROOT_SIGNING_PRIVATE_KEY_FILE: releaseRoot.privateKeyPath,
    GENIO_ONE_RELEASE_ROOT_SIGNING_KEY_ID: "release-root-local",
    GENIO_ONE_GATEWAY_OTEL_HOST:
      process.env.GENIO_ONE_GATEWAY_OTEL_HOST ?? "host.docker.internal",
    GENIO_ONE_GATEWAY_OTEL_PORT:
      process.env.GENIO_ONE_GATEWAY_OTEL_PORT ?? "54319",
    GENIO_ONE_GATEWAY_JWT_REMOTE_JWKS_URI:
      "http://host.docker.internal:58080/realms/genio-one/protocol/openid-connect/certs",
    GENIO_ONE_GATEWAY_EXT_AUTH_BACKEND_HOST: "host.docker.internal",
    GENIO_ONE_GATEWAY_EXT_AUTH_BACKEND_PORT: "9181",
    GENIO_ONE_GATEWAY_PROCESSOR_BACKEND_HOST: "host.docker.internal",
    GENIO_ONE_GATEWAY_PROCESSOR_BACKEND_PORT: "9282",
    GENIO_ONE_GATEWAY_PROCESSOR_GRPC_BACKEND_HOST: "host.docker.internal",
    GENIO_ONE_GATEWAY_PROCESSOR_GRPC_BACKEND_PORT: "9182",
  })

  const localGatewayGroup = process.env.GENIO_ONE_LOCAL_GATEWAY_GROUP?.trim().toUpperCase() || "AI"
  if (localGatewayGroup !== "AI" && localGatewayGroup !== "API") {
    throw new Error("GENIO_ONE_LOCAL_GATEWAY_GROUP must be AI or API")
  }
  const runtimeGroup: LocalRuntimeGroup = localGatewayGroup === "API"
    ? {
        runtimeId: apiRuntimeId,
        gatewayId: apiGatewayId,
        token: apiRuntimeToken,
        stateRoot: join(localRoot, apiRuntimeId),
        adminPort: 1074,
        listenerPort: 1985,
        observationPort: 9091,
      }
    : {
      runtimeId,
      gatewayId,
      token: runtimeToken,
      stateRoot: localRoot,
      adminPort: 1064,
      listenerPort: 1975,
      observationPort: 9090,
    }
  let runtime: ChildProcess | undefined
  const stop = () => {
    runtime?.kill("SIGTERM")
    platform.kill("SIGTERM")
    mcpFixture.kill("SIGTERM")
    siemFixture.kill("SIGTERM")
    apiFixture.kill("SIGTERM")
  }
  const removeSignalListener = process.removeListener.bind(process) as unknown as (
    signal: NodeJS.Signals,
    listener: () => void,
  ) => void
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    await waitFor(`${mcpFixtureOrigin}/health`)
    await waitFor(`${siemFixtureOrigin}/events`)
    await waitFor(`${apiFixtureOrigin}/health`)
    await waitFor(`${platformOrigin}/healthz`)
    await registerRuntime({
      runtimeId: runtimeGroup.runtimeId,
      gatewayId: runtimeGroup.gatewayId,
      token: runtimeGroup.token,
      reportKeyId: "runtime-report-local",
      reportPublicKeyPem: runtimeReport.publicKeyPem,
    })
    runtime = start("../../runtimes/gateway/controller/server.ts", {
        GENIO_ONE_GATEWAY_BOOTSTRAP_FILE: "",
        GENIO_ONE_PLATFORM_ORIGIN: platformOrigin,
        GENIO_ONE_TENANT_ID: tenantId,
        GENIO_ONE_RUNTIME_ID: runtimeGroup.runtimeId,
        GENIO_ONE_GATEWAY_ID: runtimeGroup.gatewayId,
        GENIO_ONE_RUNTIME_TOKEN: runtimeGroup.token,
        GENIO_ONE_RUNTIME_COMMAND_KEYRING: commandKeyRingPath,
        GENIO_ONE_POLICY_RELEASE_ROOT_KEYRING: releaseRootKeyRingPath,
        GENIO_ONE_RUNTIME_REPORT_PRIVATE_KEY: runtimeReport.privateKeyPath,
        GENIO_ONE_RUNTIME_REPORT_KEY_ID: "runtime-report-local",
        GENIO_ONE_AIGW_BINARY: join(appRoot, ".local", "aigw", "current", "aigw"),
        GENIO_ONE_GATEWAY_RUNTIME_STATE: runtimeGroup.stateRoot,
        GENIO_ONE_AIGW_ADMIN_PORT: String(runtimeGroup.adminPort),
        GENIO_ONE_AIGW_LISTENER_PORT: String(runtimeGroup.listenerPort),
        GENIO_ONE_GATEWAY_OBSERVATION_PORT: String(runtimeGroup.observationPort),
        GENIO_ONE_VALKEY_ORIGIN:
          process.env.GENIO_ONE_VALKEY_URL ?? "redis://127.0.0.1:56379",
        GENIO_ONE_TOKEN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
        GENIO_ONE_LOCAL_CREDENTIALS_JSON: localCredentialsJson,
        GENIO_ONE_GATEWAY_OTEL_HOST: "127.0.0.1",
        GENIO_ONE_GATEWAY_OTEL_PORT:
          process.env.GENIO_ONE_GATEWAY_OTEL_PORT ?? "54319",
        GENIO_ONE_GATEWAY_OTEL_HTTP_PORT:
          process.env.GENIO_ONE_GATEWAY_OTEL_HTTP_PORT ?? "54320",
      })
    console.info(`Platform CP: ${platformOrigin}`)
    console.info(`Gateway Runtime: ${tenantId}/${runtimeGroup.runtimeId} → ${runtimeGroup.gatewayId} at http://127.0.0.1:${runtimeGroup.listenerPort}`)
    console.info(`Local MCP fixture: ${mcpFixtureOrigin}/mcp`)
    console.info(`Local SIEM fixture: ${siemFixtureOrigin}/events`)
    console.info(`Local API fixture: ${apiFixtureOrigin}`)
    await new Promise<void>((resolvePromise, reject) => {
      runtime?.once("exit", (code) => code === 0
        ? resolvePromise()
        : reject(new Error(`Gateway Runtime exited with code ${String(code)}`)))
      runtime?.once("error", reject)
    })
  } finally {
    stop()
    removeSignalListener("SIGINT", stop)
    removeSignalListener("SIGTERM", stop)
  }
}

await main()
