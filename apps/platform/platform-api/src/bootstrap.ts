import { createPublicationDnsVerifier } from "./publication-dns-verifier"
import { installedConnectorsFromEnvironment } from "./capabilities/connections/installed-connectors"
import { seedInstalledServices } from "./capabilities/installed-services/seed"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { createClient } from "redis"

import { createManagementApi } from "./app"
import type { GatewayProjectionRendererOptions } from "./capabilities/gateway-projection/contract"
import { createDurableEd25519Signer } from "./capabilities/gateway-projection/signer"
import type { BootstrapSubjectInput } from "./capabilities/identity/contract"
import { createInMemoryPlatformModules } from "./capabilities/platform-modules"
import { createPlatformModuleGraph } from "./capabilities/platform-modules-live"
import { typeSafeModelRoutingFromEnvironment } from "./capabilities/model-routing/typesafe-decision-provider"
import {
  createEnvironmentPrincipalAuthenticator,
  oidcSubjectAliasesFromEnvironment,
} from "./capabilities/tenancy-auth/memory"
import { createCanonicalPrincipalAuthenticator } from "./capabilities/tenancy-auth/canonical"
import { runMigrations } from "./persistence/migration-runner"
import { createPostgresSqlAdapter } from "./persistence/sql-adapter"
import {
  createHttpConnectionVerifier,
  createLocalSliceConnectionVerifier,
  createLocalSliceDnsVerifier,
} from "./local-slice-verifiers"
import { createKeycloakGatewayIdentityProvisioner } from "./capabilities/gateway-registration/keycloak"
import { createKeycloakIdentityProviderRegistry } from "./capabilities/identity-providers/keycloak"
import { createKeycloakSubjectSessionControl } from "./capabilities/identity/keycloak"
import type { SubjectSessionControl } from "./capabilities/identity/keycloak"
import type { IdentityProviderRegistry } from "./capabilities/identity-providers/module"
import { createKeycloakApplicationOAuthClientProvisioner } from "./capabilities/applications/keycloak"
import { createOidcWorkloadAssertionVerifier } from "./capabilities/federation/verifier"
import type { DemoMcpGatewayIdentity, DemoMcpPublicationTarget } from "./capabilities/demo-project/provisioning"
import { loadProcessorAdapterRegistryFromEnvironment } from "../../../../runtimes/gateway/services/shared/processor-adapters"

export type PlatformApiMode = "postgres" | "memory-dev"

function mode(environment: NodeJS.ProcessEnv): PlatformApiMode {
  const value = environment.GENIO_ONE_PLATFORM_API_MODE ?? "postgres"
  if (value === "postgres" || value === "memory-dev") return value
  throw new Error("GENIO_ONE_PLATFORM_API_MODE must be postgres or memory-dev")
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} is required in postgres mode`)
  return value
}

function integerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name]
  if (raw === undefined) return fallback
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be a valid TCP port`)
  }
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`)
  }
  return value
}

function positiveIntegerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name]
  if (raw === undefined) return fallback
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a positive integer`)
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function runtimeReportAttestationOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv,
): { runtimeReportKeyId?: string; runtimeReportPublicKeyPem?: string } {
  const keyId = environment.GENIO_ONE_RUNTIME_REPORT_KEY_ID?.trim() ?? ""
  const publicKeyPem = environment.GENIO_ONE_RUNTIME_REPORT_PUBLIC_KEY_PEM?.trim() ?? ""
  if (!keyId && !publicKeyPem) return {}
  if (!keyId || !publicKeyPem) {
    throw new Error("GENIO_ONE_RUNTIME_REPORT_KEY_ID and GENIO_ONE_RUNTIME_REPORT_PUBLIC_KEY_PEM must be configured together")
  }
  return { runtimeReportKeyId: keyId, runtimeReportPublicKeyPem: publicKeyPem }
}

function browserIdentityFromEnvironment(environment: NodeJS.ProcessEnv) {
  const raw = environment.GENIO_ONE_BROWSER_IDENTITY_JSON
  let value: Record<string, unknown>
  if (!raw) {
    if (environment.NODE_ENV === "production") return undefined
    const port = environment.GENIO_ONE_KEYCLOAK_PORT ?? "58080"
    const keycloakIssuer = (environment.GENIO_ONE_KEYCLOAK_ISSUER_ORIGIN ?? `http://127.0.0.1:${port}`).replace(/\/$/, "") + "/realms/genio-one"
    value = {
      tenant_id: environment.GENIO_ONE_TYPESCRIPT_PILOT_TENANT_ID ?? "tenant-keycloak-local",
      issuer: keycloakIssuer,
      authorization_endpoint: `${keycloakIssuer}/protocol/openid-connect/auth`,
      token_endpoint: `${keycloakIssuer}/protocol/openid-connect/token`,
      client_id: "genio-one-self-service",
      scopes: ["genioone-invocation"],
      management_client_id: "genio-one-management-console",
      management_scopes: ["genioone-management"],
    }
  } else {
    value = JSON.parse(raw) as Record<string, unknown>
  }
  const strings = [
    "tenant_id",
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "client_id",
    "management_client_id",
  ] as const
  for (const field of strings) {
    if (typeof value[field] !== "string" || !(value[field] as string).trim()) {
      throw new Error(`GENIO_ONE_BROWSER_IDENTITY_JSON.${field} is required`)
    }
  }
  if (!Array.isArray(value.scopes) || !value.scopes.every((scope) => typeof scope === "string")) {
    throw new Error("GENIO_ONE_BROWSER_IDENTITY_JSON.scopes must be an array")
  }
  if (
    !Array.isArray(value.management_scopes) ||
    !value.management_scopes.every((scope) => typeof scope === "string")
  ) {
    throw new Error("GENIO_ONE_BROWSER_IDENTITY_JSON.management_scopes must be an array")
  }
  return value as unknown as NonNullable<Parameters<typeof createManagementApi>[0]["browserIdentity"]>
}

/**
 * Identity providers whose first-time sign-in may register a Person. Empty by
 * default: a deployment opts in per provider, so enabling a login method never
 * silently starts admitting unknown people.
 */
function justInTimeProviderIdsFromEnvironment(environment: NodeJS.ProcessEnv): string[] {
  return (environment.GENIO_ONE_IDENTITY_JIT_PROVIDER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

/**
 * Mirrors Subject suspension into Keycloak. Shares the Admin credential with
 * login-method management, so a deployment without one keeps suspension local
 * rather than failing every suspend call.
 */
function subjectSessionControlFromEnvironment(
  environment: NodeJS.ProcessEnv,
): SubjectSessionControl | undefined {
  const origin = environment.GENIO_ONE_KEYCLOAK_ORIGIN?.trim()
  const realm = environment.GENIO_ONE_KEYCLOAK_REALM?.trim()
  const adminUsername = environment.GENIO_ONE_KEYCLOAK_ADMIN?.trim()
  const adminPassword = environment.GENIO_ONE_KEYCLOAK_ADMIN_PASSWORD
  if (!origin || !realm || !adminUsername || !adminPassword) return undefined
  return createKeycloakSubjectSessionControl({ origin, realm, adminUsername, adminPassword })
}

/**
 * Login-method management needs a Keycloak Admin credential. A deployment that
 * does not provide one keeps the routes unregistered rather than surfacing a
 * console surface that fails on first use.
 */
function identityProviderRegistryFromEnvironment(
  environment: NodeJS.ProcessEnv,
): IdentityProviderRegistry | undefined {
  const origin = environment.GENIO_ONE_KEYCLOAK_ORIGIN?.trim()
  const realm = environment.GENIO_ONE_KEYCLOAK_REALM?.trim()
  const adminUsername = environment.GENIO_ONE_KEYCLOAK_ADMIN?.trim()
  const adminPassword = environment.GENIO_ONE_KEYCLOAK_ADMIN_PASSWORD
  if (!origin || !realm || !adminUsername || !adminPassword) return undefined
  return createKeycloakIdentityProviderRegistry({
    origin,
    realm,
    adminUsername,
    adminPassword,
    issuerOrigin: environment.GENIO_ONE_KEYCLOAK_ISSUER_ORIGIN,
  })
}

export function gatewayProjectionRendererOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv,
): GatewayProjectionRendererOptions {
  const telemetryHost = environment.GENIO_ONE_GATEWAY_OTEL_HOST?.trim()
  const jwtRemoteJwksUri = environment.GENIO_ONE_GATEWAY_JWT_REMOTE_JWKS_URI?.trim()
  return {
    namespace: environment.GENIO_ONE_GATEWAY_NAMESPACE ?? "default",
    aigwRootPrefix: environment.GENIO_ONE_AIGW_ROOT_PREFIX ?? "/",
    extAuth: {
      name: environment.GENIO_ONE_GATEWAY_EXT_AUTH_BACKEND_NAME ?? "genio-one-authorizer",
      port: integerEnvironment(
        environment,
        "GENIO_ONE_GATEWAY_EXT_AUTH_BACKEND_PORT",
        8081,
      ),
      ...(environment.GENIO_ONE_GATEWAY_EXT_AUTH_BACKEND_HOST?.trim()
        ? { host: environment.GENIO_ONE_GATEWAY_EXT_AUTH_BACKEND_HOST.trim() }
        : {}),
    },
    processor: {
      name: environment.GENIO_ONE_GATEWAY_PROCESSOR_BACKEND_NAME ?? "genio-one-processor-http",
      port: integerEnvironment(
        environment,
        "GENIO_ONE_GATEWAY_PROCESSOR_BACKEND_PORT",
        8182,
      ),
      ...(environment.GENIO_ONE_GATEWAY_PROCESSOR_BACKEND_HOST?.trim()
        ? { host: environment.GENIO_ONE_GATEWAY_PROCESSOR_BACKEND_HOST.trim() }
        : {}),
    },
    processorGrpc: {
      name: environment.GENIO_ONE_GATEWAY_PROCESSOR_GRPC_BACKEND_NAME ?? "genio-one-processor",
      port: integerEnvironment(
        environment,
        "GENIO_ONE_GATEWAY_PROCESSOR_GRPC_BACKEND_PORT",
        8082,
      ),
      ...(environment.GENIO_ONE_GATEWAY_PROCESSOR_GRPC_BACKEND_HOST?.trim()
        ? { host: environment.GENIO_ONE_GATEWAY_PROCESSOR_GRPC_BACKEND_HOST.trim() }
        : {}),
    },
    ...(jwtRemoteJwksUri ? { jwtRemoteJwksUri } : {}),
    ...(telemetryHost
      ? {
          telemetry: {
            name: environment.GENIO_ONE_GATEWAY_OTEL_BACKEND_NAME ?? "genio-one-otel-collector",
            host: telemetryHost,
            port: integerEnvironment(environment, "GENIO_ONE_GATEWAY_OTEL_PORT", 4317),
            httpPort: integerEnvironment(environment, "GENIO_ONE_GATEWAY_OTEL_HTTP_PORT", 4318),
          },
        }
      : {}),
  }
}

function localCredentialValues(environment: NodeJS.ProcessEnv): Record<string, string> {
  const raw = environment.GENIO_ONE_LOCAL_CREDENTIALS_JSON?.trim()
  if (!raw) return {}
  const value = JSON.parse(raw) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GENIO_ONE_LOCAL_CREDENTIALS_JSON must be an object")
  }
  const result: Record<string, string> = {}
  for (const [name, secret] of Object.entries(value)) {
    if (!name || typeof secret !== "string" || !secret) {
      throw new Error("GENIO_ONE_LOCAL_CREDENTIALS_JSON values must be non-empty strings")
    }
    result[name] = secret
  }
  return result
}

function connectionVerifierCredentials(environment: NodeJS.ProcessEnv): Record<string, string> {
  const credentials = localCredentialValues(environment)
  const archifyCredentialRef = environment.GENIO_DEMO_ARCHIFY_CREDENTIAL_REF?.trim()
  const archifyVerifierToken = environment.GENIO_DEMO_ARCHIFY_VERIFIER_TOKEN?.trim()
  if (archifyCredentialRef && archifyVerifierToken) {
    credentials[archifyCredentialRef] = archifyVerifierToken
  }
  const geminiCredentialRef = environment.GENIO_DEMO_GEMINI_CREDENTIAL_REF?.trim()
  const geminiVerifierToken = environment.GENIO_DEMO_GEMINI_VERIFIER_TOKEN?.trim()
  if (geminiCredentialRef && geminiVerifierToken) {
    credentials[geminiCredentialRef] = geminiVerifierToken
  }
  return credentials
}

function demoMcpGatewayIdentityFromEnvironment(environment: NodeJS.ProcessEnv): DemoMcpGatewayIdentity {
  const issuerOrigin = (environment.GENIO_ONE_KEYCLOAK_ISSUER_ORIGIN ?? "http://127.0.0.1:58080").replace(/\/$/, "")
  const realm = environment.GENIO_ONE_KEYCLOAK_REALM ?? "genio-one"
  const issuer = `${issuerOrigin}/realms/${realm}`
  return {
    issuer,
    audience: environment.GENIO_ONE_KEYCLOAK_AUDIENCE ?? "genio-one-product-api",
    jwksUri: environment.GENIO_ONE_GATEWAY_JWT_REMOTE_JWKS_URI ?? `${issuer}/protocol/openid-connect/certs`,
  }
}

function demoMcpPublicationTargetFromEnvironment(
  environment: NodeJS.ProcessEnv,
): DemoMcpPublicationTarget | undefined {
  const origin = environment.GENIO_ONE_MCP_PUBLIC_ORIGIN?.trim()
  if (!origin) return undefined
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error("GENIO_ONE_MCP_PUBLIC_ORIGIN must be an absolute HTTP(S) URL")
  }
  if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("GENIO_ONE_MCP_PUBLIC_ORIGIN must be an absolute HTTP(S) origin without credentials")
  }
  const dnsManagement = environment.GENIO_ONE_MCP_PUBLIC_DNS_MANAGEMENT ?? "EXTERNAL"
  if (dnsManagement !== "EXTERNAL" && dnsManagement !== "PLATFORM_MANAGED") {
    throw new Error("GENIO_ONE_MCP_PUBLIC_DNS_MANAGEMENT must be EXTERNAL or PLATFORM_MANAGED")
  }
  const basePath = (environment.GENIO_ONE_AIGW_ROOT_PREFIX ?? "/").trim()
  if (!basePath.startsWith("/") || /[?#\s]/.test(basePath)) {
    throw new Error("GENIO_ONE_AIGW_ROOT_PREFIX must be an absolute path without query or fragment")
  }
  return {
    gatewayId: environment.GENIO_ONE_DEFAULT_GATEWAY_ID ?? "genio-ai-mcp-gateway",
    origin: parsed.origin,
    basePath: basePath === "/" ? basePath : basePath.replace(/\/+$/, "") || "/",
    dnsManagement,
    dnsTarget: environment.GENIO_ONE_MCP_PUBLIC_DNS_TARGET?.trim() || (parsed.hostname === "localhost" ? "127.0.0.1" : null),
  }
}

function encryptionKeyEnvironment(environment: NodeJS.ProcessEnv, key: string): Uint8Array {
  const value = Buffer.from(requiredEnvironment(environment, key), "base64")
  if (value.byteLength !== 32) throw new Error(`${key} must decode to 32 bytes`)
  return value
}

function bootstrapSubjectScalarEnvironment(
  environment: NodeJS.ProcessEnv,
): Map<string, BootstrapSubjectInput[]> {
  const configured = [
    "GENIO_ONE_BOOTSTRAP_ADMIN_SUBJECT_ID",
    "GENIO_ONE_BOOTSTRAP_ADMIN_EXTERNAL_SUBJECT_ID",
  ].some((name) => Boolean(environment[name]?.trim()))
  const grouped = new Map<string, BootstrapSubjectInput[]>()
  if (!configured) return grouped

  const tenantId = requiredEnvironment(environment, "GENIO_ONE_BOOTSTRAP_TENANT_ID")
  const subjectId = requiredEnvironment(environment, "GENIO_ONE_BOOTSTRAP_ADMIN_SUBJECT_ID")
  const externalSubjectId = requiredEnvironment(
    environment,
    "GENIO_ONE_BOOTSTRAP_ADMIN_EXTERNAL_SUBJECT_ID",
  )
  grouped.set(tenantId, [{
    subject_id: subjectId,
    kind: "PERSON",
    ...(environment.GENIO_ONE_BOOTSTRAP_ADMIN_DISPLAY_NAME?.trim()
      ? { display_name: environment.GENIO_ONE_BOOTSTRAP_ADMIN_DISPLAY_NAME.trim() }
      : {}),
    ...(environment.GENIO_ONE_BOOTSTRAP_ADMIN_EMAIL?.trim()
      ? { email: environment.GENIO_ONE_BOOTSTRAP_ADMIN_EMAIL.trim() }
      : {}),
    role: "TENANT_ADMINISTRATOR",
    external_identities: [{
      provider_id: environment.GENIO_ONE_KEYCLOAK_IDENTITY_PROVIDER_ID?.trim() ?? "keycloak-local",
      external_subject_id: externalSubjectId,
    }],
  }])
  return grouped
}

export function bootstrapSubjectsFromEnvironment(environment: NodeJS.ProcessEnv): Map<string, BootstrapSubjectInput[]> {
  const raw = environment.GENIO_ONE_BOOTSTRAP_SUBJECTS_JSON?.trim()
  if (!raw) return bootstrapSubjectScalarEnvironment(environment)
  const grouped = new Map<string, BootstrapSubjectInput[]>()
  const value = JSON.parse(raw) as unknown
  if (!Array.isArray(value)) throw new Error("GENIO_ONE_BOOTSTRAP_SUBJECTS_JSON must be an array")
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("GENIO_ONE_BOOTSTRAP_SUBJECTS_JSON entries must be objects")
    }
    const input = item as Record<string, unknown>
    const tenantId = typeof input.tenant_id === "string" ? input.tenant_id.trim() : ""
    const subjectId = typeof input.subject_id === "string" ? input.subject_id.trim() : ""
    const kind = input.kind
    if (!tenantId || !subjectId || (kind !== "PERSON" && kind !== "APPLICATION" && kind !== "AGENT")) {
      throw new Error("GENIO_ONE_BOOTSTRAP_SUBJECTS_JSON requires tenant_id, subject_id, and a valid kind")
    }
    const role = input.role
    if (role !== undefined && role !== "USER" && role !== "TENANT_ADMINISTRATOR") {
      throw new Error("GENIO_ONE_BOOTSTRAP_SUBJECTS_JSON contains an invalid role")
    }
    const external = input.external_identities
    if (external !== undefined && !Array.isArray(external)) {
      throw new Error("GENIO_ONE_BOOTSTRAP_SUBJECTS_JSON external_identities must be an array")
    }
    const subject: BootstrapSubjectInput = {
      subject_id: subjectId,
      kind,
      ...(typeof input.display_name === "string" || input.display_name === null ? { display_name: input.display_name } : {}),
      ...(typeof input.email === "string" || input.email === null ? { email: input.email } : {}),
      ...(typeof input.department === "string" || input.department === null ? { department: input.department } : {}),
      ...(role ? { role } : {}),
      ...(external ? {
        external_identities: external.map((binding) => {
          if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
            throw new Error("GENIO_ONE_BOOTSTRAP_SUBJECTS_JSON external identity must be an object")
          }
          const record = binding as Record<string, unknown>
          if (typeof record.provider_id !== "string" || typeof record.external_subject_id !== "string") {
            throw new Error("GENIO_ONE_BOOTSTRAP_SUBJECTS_JSON external identity is invalid")
          }
          return { provider_id: record.provider_id, external_subject_id: record.external_subject_id }
        }),
      } : {}),
    }
    grouped.set(tenantId, [...(grouped.get(tenantId) ?? []), subject])
  }
  return grouped
}

async function webHtmlFromEnvironment(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const path = environment.GENIO_ONE_WEB_HTML_FILE?.trim()
  return path ? readFile(path, "utf8") : undefined
}

async function createMemoryDevApi(environment: NodeJS.ProcessEnv, logger: boolean) {
  if (environment.NODE_ENV === "production") {
    throw new Error("memory-dev mode is forbidden when NODE_ENV=production")
  }
  const semanticRouting = typeSafeModelRoutingFromEnvironment(environment)
  const modules = createInMemoryPlatformModules({
    ...runtimeReportAttestationOptionsFromEnvironment(environment),
    ...(semanticRouting ? {
      modelRoutingDecisionProvider: semanticRouting.provider,
      modelRoutingDecisionMinimumConfidence: semanticRouting.minimumConfidence,
    } : {}),
    processorAdapterRegistry: loadProcessorAdapterRegistryFromEnvironment(environment),
  })
  return createManagementApi({
    logger,
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createEnvironmentPrincipalAuthenticator(environment),
    entitlementResolver: modules.entitlements,
    swaggerUiStaticDir: environment.GENIO_ONE_SWAGGER_UI_STATIC_DIR,
    webHtml: await webHtmlFromEnvironment(environment),
    browserIdentity: browserIdentityFromEnvironment(environment),
    identityProviders: identityProviderRegistryFromEnvironment(environment),
    subjectSessionControl: subjectSessionControlFromEnvironment(environment),
    connectorDeployment: installedConnectorsFromEnvironment(environment),
    botServiceEndpoint: environment.GENIO_BOT_SERVICE_ENDPOINT,
    demoProjectArchifyEndpoint: environment.GENIO_DEMO_ARCHIFY_ENDPOINT,
    demoProjectArchifyCredentialRef: environment.GENIO_DEMO_ARCHIFY_CREDENTIAL_REF,
    demoProjectGeminiCredentialRef: environment.GENIO_DEMO_GEMINI_CREDENTIAL_REF,
    demoProjectBotUrl: environment.GENIO_ONE_BOT_ORIGIN ?? null,
    demoProjectGatewayId: environment.GENIO_ONE_DEFAULT_GATEWAY_ID ?? "genio-ai-mcp-gateway",
    demoProjectGatewayIdentity: demoMcpGatewayIdentityFromEnvironment(environment),
    demoProjectMcpPublicationTarget: demoMcpPublicationTargetFromEnvironment(environment),
  })
}

export interface ConfiguredManagementApiOptions {
  environment?: NodeJS.ProcessEnv
  logger?: boolean
}

/**
 * Build exactly one Management API capability graph.
 *
 * The default is the durable PostgreSQL/Valkey graph. The only memory path is
 * an explicit non-production developer mode; there is no implicit fallback
 * when a database, signer or lease store is missing.
 */
export async function createConfiguredManagementApi(
  options: ConfiguredManagementApiOptions = {},
) {
  const environment = options.environment ?? process.env
  const logger = options.logger ?? true
  if (mode(environment) === "memory-dev") {
    return createMemoryDevApi(environment, logger)
  }

  const databaseUrl = requiredEnvironment(environment, "GENIO_ONE_DATABASE_URL")
  const valkeyUrl = requiredEnvironment(environment, "GENIO_ONE_VALKEY_URL")
  if (
    environment.NODE_ENV === "production" &&
    environment.GENIO_ONE_MANAGEMENT_API_AUTH_MODE !== "oidc"
  ) {
    throw new Error(
      "GENIO_ONE_MANAGEMENT_API_AUTH_MODE=oidc is required in production",
    )
  }
  const projectionSigningKeyFile = requiredEnvironment(
    environment,
    "GENIO_ONE_GATEWAY_SIGNING_PRIVATE_KEY_FILE",
  )
  const runtimeCommandSigningKeyFile = requiredEnvironment(
    environment,
    "GENIO_ONE_RUNTIME_COMMAND_SIGNING_PRIVATE_KEY_FILE",
  )
  const policyArtifactSigningKeyFile = requiredEnvironment(
    environment,
    "GENIO_ONE_POLICY_ARTIFACT_SIGNING_PRIVATE_KEY_FILE",
  )
  const releaseRootSigningKeyFile = requiredEnvironment(
    environment,
    "GENIO_ONE_RELEASE_ROOT_SIGNING_PRIVATE_KEY_FILE",
  )
  const principalAuthenticator = createEnvironmentPrincipalAuthenticator(environment)
  const processorAdapterRegistry = loadProcessorAdapterRegistryFromEnvironment(environment)
  const migrationsDir =
    environment.GENIO_ONE_PLATFORM_MIGRATIONS_DIR ??
    fileURLToPath(new URL("../migrations", import.meta.url))
  const projectionSigner = createDurableEd25519Signer({
    privateKeyPem: await readFile(projectionSigningKeyFile),
    ...(environment.GENIO_ONE_GATEWAY_SIGNING_KEY_ID
      ? { keyId: environment.GENIO_ONE_GATEWAY_SIGNING_KEY_ID }
      : {}),
  })
  const runtimeCommandSigner = createDurableEd25519Signer({
    privateKeyPem: await readFile(runtimeCommandSigningKeyFile),
    ...(environment.GENIO_ONE_RUNTIME_COMMAND_SIGNING_KEY_ID
      ? { keyId: environment.GENIO_ONE_RUNTIME_COMMAND_SIGNING_KEY_ID }
      : {}),
  })
  const policyArtifactSigner = createDurableEd25519Signer({
    privateKeyPem: await readFile(policyArtifactSigningKeyFile),
    ...(environment.GENIO_ONE_POLICY_ARTIFACT_SIGNING_KEY_ID
      ? { keyId: environment.GENIO_ONE_POLICY_ARTIFACT_SIGNING_KEY_ID }
      : {}),
  })
  const releaseRootSigner = createDurableEd25519Signer({
    privateKeyPem: await readFile(releaseRootSigningKeyFile),
    ...(environment.GENIO_ONE_RELEASE_ROOT_SIGNING_KEY_ID
      ? { keyId: environment.GENIO_ONE_RELEASE_ROOT_SIGNING_KEY_ID }
      : {}),
  })

  const sql = createPostgresSqlAdapter({ url: databaseUrl })
  const valkey = createClient({ url: valkeyUrl })
  valkey.on("error", (error) => {
    // This is an operational connection fact; no URL or credential is logged.
    process.stderr.write(
      `${JSON.stringify({ component: "model-route-lease", event: "valkey-error", message: error instanceof Error ? error.message : "unknown" })}\n`,
    )
  })

  try {
    await runMigrations(sql, { migrationsDir })
    await valkey.connect()
    const applicationOAuth = createKeycloakApplicationOAuthClientProvisioner({
      origin: requiredEnvironment(environment, "GENIO_ONE_KEYCLOAK_ORIGIN"),
      issuerOrigin: requiredEnvironment(environment, "GENIO_ONE_KEYCLOAK_ISSUER_ORIGIN"),
      realm: requiredEnvironment(environment, "GENIO_ONE_KEYCLOAK_REALM"),
      adminUsername: requiredEnvironment(environment, "GENIO_ONE_KEYCLOAK_ADMIN"),
      adminPassword: requiredEnvironment(environment, "GENIO_ONE_KEYCLOAK_ADMIN_PASSWORD"),
      identityProviderId: environment.GENIO_ONE_KEYCLOAK_IDENTITY_PROVIDER_ID ?? "keycloak-local",
    })
    const semanticRouting = typeSafeModelRoutingFromEnvironment(environment)
    const modules = createPlatformModuleGraph({
      sql,
      valkey: {
        get: (key) => valkey.get(key),
        async set(key, value, setOptions) {
          const result = await valkey.set(key, value, setOptions)
          return result === "OK" ? "OK" : null
        },
        eval: (script, evalOptions) => valkey.eval(script, evalOptions),
      },
      clickhouse: {
        origin: environment.GENIO_ONE_CLICKHOUSE_HTTP_ORIGIN ??
          `http://127.0.0.1:${integerEnvironment(environment, "GENIO_ONE_CLICKHOUSE_HTTP_PORT", 58123)}`,
        database: requiredEnvironment(environment, "GENIO_ONE_CLICKHOUSE_DB"),
        username: requiredEnvironment(environment, "GENIO_ONE_CLICKHOUSE_USER"),
        password: requiredEnvironment(environment, "GENIO_ONE_CLICKHOUSE_PASSWORD"),
      },
      signingRoles: {
        projection: projectionSigner,
        runtimeCommand: runtimeCommandSigner,
        policyArtifact: policyArtifactSigner,
        releaseRoot: releaseRootSigner,
      },
      gatewayReleaseTtlSeconds: positiveIntegerEnvironment(
        environment,
        "GENIO_ONE_GATEWAY_RELEASE_TTL_SECONDS",
        3_600,
      ),
      ...(semanticRouting ? {
        modelRoutingDecisionProvider: semanticRouting.provider,
        modelRoutingDecisionMinimumConfidence: semanticRouting.minimumConfidence,
      } : {}),
      mcpOAuthEncryptionKey: encryptionKeyEnvironment(
        environment,
        "GENIO_ONE_MCP_OAUTH_ENCRYPTION_KEY",
      ),
      mcpOAuthPublicOrigin: requiredEnvironment(
        environment,
        "GENIO_ONE_MCP_OAUTH_PUBLIC_ORIGIN",
      ),
      managementUiOrigin: requiredEnvironment(
        environment,
        "GENIO_ONE_MANAGEMENT_UI_ORIGIN",
      ),
      platformOrigin: environment.GENIO_ONE_PLATFORM_ORIGIN ?? requiredEnvironment(
        environment,
        "GENIO_ONE_CONTROL_PLANE_PUBLIC_ORIGIN",
      ),
      defaultGatewayId: environment.GENIO_ONE_DEFAULT_GATEWAY_ID ?? "genio-ai-mcp-gateway",
      gatewayIdentityProvisioner: createKeycloakGatewayIdentityProvisioner({
        origin: requiredEnvironment(environment, "GENIO_ONE_KEYCLOAK_ORIGIN"),
        issuerOrigin: requiredEnvironment(environment, "GENIO_ONE_KEYCLOAK_ISSUER_ORIGIN"),
        realm: requiredEnvironment(environment, "GENIO_ONE_KEYCLOAK_REALM"),
        adminUsername: requiredEnvironment(environment, "GENIO_ONE_KEYCLOAK_ADMIN"),
        adminPassword: requiredEnvironment(environment, "GENIO_ONE_KEYCLOAK_ADMIN_PASSWORD"),
        audience: requiredEnvironment(environment, "GENIO_ONE_KEYCLOAK_AUDIENCE"),
        scope: environment.GENIO_ONE_KEYCLOAK_GATEWAY_RUNTIME_SCOPE,
      }),
      applicationOAuthProvisioner: applicationOAuth,
      applicationTokenBroker: applicationOAuth,
      workloadAssertionVerifier: createOidcWorkloadAssertionVerifier(),
      processorAdapterRegistry,
      subjectAliases: oidcSubjectAliasesFromEnvironment(environment),
      renderer: gatewayProjectionRendererOptionsFromEnvironment(environment),
      ...runtimeReportAttestationOptionsFromEnvironment(environment),
      connectionVerifier: createHttpConnectionVerifier({
        credentials: connectionVerifierCredentials(environment),
        allowHttp: environment.GENIO_ONE_CONNECTION_VERIFIER_ALLOW_HTTP === "1",
        allowedHosts: (environment.GENIO_ONE_CONNECTION_VERIFIER_ALLOWED_HOSTS ?? "")
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
      }),
      ...(environment.GENIO_ONE_PUBLICATION_DNS_ALLOW_LOCALHOST === "1"
        ? { publicationDnsVerifier: createLocalSliceDnsVerifier() }
        : { publicationDnsVerifier: createPublicationDnsVerifier(JSON.parse(environment.GENIO_ONE_PUBLICATION_DNS_TARGETS ?? "{}") as Record<string, string>) }),
      ...(environment.GENIO_ONE_LOCAL_GATEWAY_SLICE === "1"
        ? {
            connectionVerifier: createLocalSliceConnectionVerifier({
              credentials: connectionVerifierCredentials(environment),
              allowedHosts: (environment.GENIO_ONE_CONNECTION_VERIFIER_ALLOWED_HOSTS ?? "")
                .split(",")
                .map((host) => host.trim())
                .filter(Boolean),
            }),
            publicationDnsVerifier: createLocalSliceDnsVerifier(),
          }
        : {}),
    })
    const connectorDeployment = installedConnectorsFromEnvironment(environment)
    const bootstrapSubjects = bootstrapSubjectsFromEnvironment(environment)
    for (const [tenantId, subjects] of bootstrapSubjects) {
      await modules.identity.bootstrap({ tenantId, subjects })
    }
    const configuredBootstrapTenant = environment.GENIO_ONE_BOOTSTRAP_TENANT_ID?.trim()
    const seedTenants = new Set(bootstrapSubjects.keys())
    if (configuredBootstrapTenant) seedTenants.add(configuredBootstrapTenant)
    for (const tenantId of seedTenants) {
      await modules.botAccessPolicy.getFirstPartyBotSeed({ tenantId })
      const publicOrigin = environment.GENIO_ONE_MCP_OAUTH_PUBLIC_ORIGIN
      if (publicOrigin) await seedInstalledServices(sql, tenantId, {
        publicOrigin,
        connectorDeployment,
        genioBotEndpoint: environment.GENIO_BOT_SERVICE_ENDPOINT,
        enforcementPointId: environment.GENIO_ONE_DEFAULT_GATEWAY_ID,
      })
    }
    const app = await createManagementApi({
      logger,
      modules,
      resourceCatalog: modules.resources,
      principalAuthenticator: createCanonicalPrincipalAuthenticator({
        delegate: principalAuthenticator,
        identity: modules.identity,
        organizations: modules.organizations,
        justInTimeProviderIds: justInTimeProviderIdsFromEnvironment(environment),
      }),
      entitlementResolver: modules.entitlements,
      swaggerUiStaticDir: environment.GENIO_ONE_SWAGGER_UI_STATIC_DIR,
      webHtml: await webHtmlFromEnvironment(environment),
      browserIdentity: browserIdentityFromEnvironment(environment),
      identityProviders: identityProviderRegistryFromEnvironment(environment),
      subjectSessionControl: subjectSessionControlFromEnvironment(environment),
      connectorDeployment,
      botServiceEndpoint: environment.GENIO_BOT_SERVICE_ENDPOINT,
      demoProjectArchifyEndpoint: environment.GENIO_DEMO_ARCHIFY_ENDPOINT,
      demoProjectArchifyCredentialRef: environment.GENIO_DEMO_ARCHIFY_CREDENTIAL_REF,
      demoProjectGeminiCredentialRef: environment.GENIO_DEMO_GEMINI_CREDENTIAL_REF,
      demoProjectBotUrl: environment.GENIO_ONE_BOT_ORIGIN ?? null,
      demoProjectGatewayId: environment.GENIO_ONE_DEFAULT_GATEWAY_ID ?? "genio-ai-mcp-gateway",
      demoProjectGatewayIdentity: demoMcpGatewayIdentityFromEnvironment(environment),
      demoProjectMcpPublicationTarget: demoMcpPublicationTargetFromEnvironment(environment),
    })
    let renewalRunning = false
    const renewGatewayPolicyReleases = async () => {
      if (renewalRunning || !modules.gatewayPolicyReleaseRenewal) return
      renewalRunning = true
      try {
        const renewed = await modules.gatewayPolicyReleaseRenewal.renewDue()
        if (renewed > 0) {
          app.log.info({ renewed }, "Renewed expiring Gateway policy releases")
        }
      } catch (error) {
        app.log.error({ err: error }, "Gateway policy release renewal failed")
      } finally {
        renewalRunning = false
      }
    }
    await renewGatewayPolicyReleases()
    const renewalInterval = setInterval(
      () => void renewGatewayPolicyReleases(),
      positiveIntegerEnvironment(
        environment,
        "GENIO_ONE_GATEWAY_RELEASE_RENEWAL_INTERVAL_SECONDS",
        60,
      ) * 1_000,
    )
    renewalInterval.unref()
    let credentialRetirementRunning = false
    const retireExpiredApplicationCredentials = async () => {
      if (credentialRetirementRunning) return
      credentialRetirementRunning = true
      try {
        const retired = await modules.applications.retireExpiredCredentials()
        if (retired > 0) {
          app.log.info({ retired }, "Retired expired Application credentials")
        }
      } catch (error) {
        app.log.error({ err: error }, "Application credential retirement failed")
      } finally {
        credentialRetirementRunning = false
      }
    }
    void retireExpiredApplicationCredentials()
    const credentialRetirementInterval = setInterval(
      () => void retireExpiredApplicationCredentials(),
      positiveIntegerEnvironment(
        environment,
        "GENIO_ONE_APPLICATION_CREDENTIAL_RETIREMENT_INTERVAL_SECONDS",
        5,
      ) * 1_000,
    )
    credentialRetirementInterval.unref()
    let siemDeliveryRunning = false
    const deliverSiemEvents = async () => {
      if (siemDeliveryRunning) return
      siemDeliveryRunning = true
      try {
        await modules.siem.deliverDue()
      } catch (error) {
        app.log.error({ err: error }, "SIEM delivery failed")
      } finally {
        siemDeliveryRunning = false
      }
    }
    const siemDeliveryInterval = setInterval(
      () => void deliverSiemEvents(),
      positiveIntegerEnvironment(environment, "GENIO_ONE_SIEM_DELIVERY_INTERVAL_SECONDS", 2) * 1_000,
    )
    siemDeliveryInterval.unref()
    app.addHook("onClose", async () => {
      clearInterval(renewalInterval)
      clearInterval(credentialRetirementInterval)
      clearInterval(siemDeliveryInterval)
      if (valkey.isOpen) await valkey.quit()
      await sql.end({ timeout: 5 })
    })
    return app
  } catch (error) {
    if (valkey.isOpen) await valkey.quit().catch(() => undefined)
    await sql.end({ timeout: 5 }).catch(() => undefined)
    throw error
  }
}

export function managementApiListenOptions(
  environment: NodeJS.ProcessEnv = process.env,
): { host: string; port: number } {
  return {
    host: environment.GENIO_ONE_MANAGEMENT_API_HOST ?? "127.0.0.1",
    port: integerEnvironment(
      environment,
      "GENIO_ONE_MANAGEMENT_API_PORT",
      58_082,
    ),
  }
}
