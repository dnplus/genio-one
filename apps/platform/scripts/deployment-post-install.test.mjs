import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  configureProductionIdentityBootstrap,
  configureManagementAgentClient,
  configureManagementConsoleClient,
  configureBotClient,
  configureLoginBranding,
  configureSelfServiceClient,
  gatewayRuntimeBootstrapTargets,
  keycloakRealmUpdateProfile,
  provisionGatewayRuntimeBootstraps,
  reconcileKeycloakUsers,
  reconcileCodexOfflineAccess,
  runVersionedSteps,
} from "./deployment-post-install.mjs";

test("Gateway replica bootstrap assigns one durable Runtime identity per Pod", () => {
  assert.deepEqual(
    gatewayRuntimeBootstrapTargets({
      GENIO_ONE_GATEWAY_RUNTIME_IDS: "gateway-runtime-0,gateway-runtime-1",
      GENIO_ONE_GATEWAY_BOOTSTRAP_FILE: "/var/lib/genio-one/gateway-bootstrap.json",
    }),
    [
      {
        runtimeId: "gateway-runtime-0",
        bootstrapFile: "/var/lib/genio-one/gateway-bootstrap.json.0.json",
      },
      {
        runtimeId: "gateway-runtime-1",
        bootstrapFile: "/var/lib/genio-one/gateway-bootstrap.json.1.json",
      },
    ],
  );
  assert.throws(
    () => gatewayRuntimeBootstrapTargets({
      GENIO_ONE_GATEWAY_RUNTIME_ID: "gateway-local",
      GENIO_ONE_GATEWAY_BOOTSTRAP_FILE: "/var/lib/genio-one/gateway-bootstrap.json",
    }),
    /no longer supported/,
  );
  assert.deepEqual(
    gatewayRuntimeBootstrapTargets({
      GENIO_ONE_GATEWAY_RUNTIME_IDS: "gateway-runtime-0",
      GENIO_ONE_GATEWAY_BOOTSTRAP_FILE: "/var/lib/genio-one/gateway-bootstrap.json",
    }),
    [{
      runtimeId: "gateway-runtime-0",
      bootstrapFile: "/var/lib/genio-one/gateway-bootstrap.json.0.json",
    }],
  );
});

test("Helm Gateway uses per-replica one-time bootstrap files", async () => {
  const [runtimeTemplate, secretTemplate, postInstallTemplate, platformTemplate, values] =
    await Promise.all([
      readFile(resolve(import.meta.dirname, "../../../deploy/helm/genio-one/templates/gateway-runtime.yaml"), "utf8"),
      readFile(resolve(import.meta.dirname, "../../../deploy/helm/genio-one/templates/secrets.yaml"), "utf8"),
      readFile(resolve(import.meta.dirname, "../../../deploy/helm/genio-one/templates/post-install.yaml"), "utf8"),
      readFile(resolve(import.meta.dirname, "../../../deploy/helm/genio-one/templates/platform.yaml"), "utf8"),
      readFile(resolve(import.meta.dirname, "../../../deploy/helm/genio-one/values.yaml"), "utf8"),
    ]);
  assert.match(runtimeTemplate, /kind: StatefulSet/);
  assert.match(runtimeTemplate, /clusterIP: None/);
  assert.match(runtimeTemplate, /command: \["bun", "server\.js"\]/);
  assert.match(runtimeTemplate, /GENIO_ONE_GATEWAY_BOOTSTRAP_FILE/);
  assert.match(runtimeTemplate, /wait-for-gateway-bootstrap/);
  assert.match(runtimeTemplate, /gateway-bootstrap\/\$\(POD_NAME\)\.json/);
  assert.doesNotMatch(runtimeTemplate, /subPathExpr:/);
  assert.match(runtimeTemplate, /name: gateway-bootstrap/);
  assert.match(runtimeTemplate, /GENIO_ONE_GATEWAY_APPLY_MODE, value: KUBERNETES/);
  assert.doesNotMatch(runtimeTemplate, /GENIO_ONE_RUNTIME_OIDC_CLIENT_ID_FILE/);
  assert.doesNotMatch(runtimeTemplate, /GENIO_ONE_RUNTIME_OIDC_CLIENT_SECRET_FILE/);
  assert.doesNotMatch(runtimeTemplate, /GENIO_ONE_RUNTIME_REPORT_PRIVATE_KEY/);
  assert.match(runtimeTemplate, /name: genio-one-authorizer/);
  assert.match(runtimeTemplate, /name: genio-one-processor/);
  assert.match(runtimeTemplate, /containerPort: 8081/);
  assert.match(runtimeTemplate, /containerPort: 8082/);
  assert.match(runtimeTemplate, /exec bun authorizer\.js/);
  assert.match(runtimeTemplate, /exec bun processor\.js/);
  assert.match(runtimeTemplate, /GENIO_ONE_POLICY_ROOT/);
  assert.match(runtimeTemplate, /GENIO_ONE_TOKEN_VAULT_KEY/);
  assert.match(runtimeTemplate, /tcpSocket/);
  assert.doesNotMatch(runtimeTemplate, /ai-mcp-processor/);
  assert.doesNotMatch(runtimeTemplate, /startupProbe: \{ httpGet/);
  assert.doesNotMatch(runtimeTemplate, /--gateway-client-id\n/);
  assert.doesNotMatch(secretTemplate, /gatewayClientCredentials/);
  assert.doesNotMatch(secretTemplate, /gateway-client-id-/);
  assert.doesNotMatch(secretTemplate, /gateway-client-secret-/);
  assert.doesNotMatch(secretTemplate, /gateway-report-private-key-/);
  assert.match(secretTemplate, /runtime-command-verification-keys\.json/);
  assert.match(secretTemplate, /policy-release-root-keys\.json/);
  assert.doesNotMatch(secretTemplate, /gateway-client-secret:/);
  assert.match(postInstallTemplate, /GENIO_ONE_GATEWAY_RUNTIME_IDS/);
  assert.match(postInstallTemplate, /GENIO_ONE_KUBERNETES_GATEWAY_BOOTSTRAP_SECRET/);
  assert.match(postInstallTemplate, /resourceNames:/);
  assert.match(postInstallTemplate, /verbs: \[get, patch, update\]/);
  assert.match(postInstallTemplate, /post-install-\{\{ \.Release\.Revision \}\}/);
  assert.doesNotMatch(postInstallTemplate, /helm\.sh\/hook/);
  assert.doesNotMatch(postInstallTemplate, /GENIO_ONE_GATEWAY_CREDENTIALS_DIR/);
  assert.match(postInstallTemplate, /GENIO_ONE_SKIP_SCHEMA_MIGRATION, value: "1"/);
  assert.doesNotMatch(postInstallTemplate, /GENIO_ONE_GATEWAY_RUNTIME_ID, value/);
  assert.doesNotMatch(postInstallTemplate, /GENIO_ONE_GATEWAY_CLIENT_ID, value/);
  assert.doesNotMatch(postInstallTemplate, /key: gateway-client-secret \}/);
  assert.match(platformTemplate, /GENIO_ONE_GATEWAY_RUNTIME_IDS/);
  assert.doesNotMatch(platformTemplate, /GENIO_ONE_GATEWAY_RUNTIME_ID, value/);
  assert.doesNotMatch(values, /gatewayClientCredentials:/);
  assert.match(values, /gatewayServices:/);
  assert.match(values, /tokenVaultKey:/);
  assert.doesNotMatch(values, /gatewayClientSecret:/);
  assert.doesNotMatch(values, /runtimeId:/);
  assert.doesNotMatch(values, /^  clientId:/m);
});

test("Gateway post-install registers through Platform API and publishes only bootstrap files", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "genio-one-platform-bootstrap-"));
  const bootstrapBase = resolve(directory, "gateway-bootstrap.json");
  const requests = [];
  const commands = [];
  const environment = {
    GENIO_ONE_PLATFORM_ORIGIN: "https://one.acme.test",
    GENIO_ONE_KEYCLOAK_ORIGIN: "https://identity.acme.test",
    GENIO_ONE_KEYCLOAK_REALM: "acme",
    GENIO_ONE_KEYCLOAK_CLIENT_ID: "genio-one-product-api",
    GENIO_ONE_KEYCLOAK_CLIENT_SECRET: "product-secret",
    GENIO_ONE_BOOTSTRAP_ADMIN_USERNAME: "platform-admin",
    GENIO_ONE_BOOTSTRAP_ADMIN_PASSWORD: "admin-secret",
    GENIO_ONE_GATEWAY_TENANT_ID: "tenant-acme",
    GENIO_ONE_GATEWAY_RUNTIME_IDS: "gateway-runtime-0",
    GENIO_ONE_GATEWAY_BOOTSTRAP_FILE: bootstrapBase,
    GENIO_ONE_GATEWAY_DISPLAY_NAME: "Acme Gateway",
    GENIO_ONE_GATEWAY_ID: "genio-ai-mcp-gateway",
    GENIO_ONE_GATEWAY_SITE_ID: "taipei",
    GENIO_ONE_GATEWAY_REGION: "tw-north",
    GENIO_ONE_KUBERNETES_NAMESPACE: "genio-one",
    GENIO_ONE_KUBERNETES_GATEWAY_BOOTSTRAP_SECRET: "genio-one-gateway-bootstrap",
  };
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/protocol/openid-connect/token")) {
      return new Response(JSON.stringify({ access_token: "management-token" }), { status: 200 });
    }
    if (options.method !== "POST") return new Response("[]", { status: 200 });
    const input = JSON.parse(options.body);
    const bootstrap = {
      schema_version: "genio.one.gateway-bootstrap.v1",
      registration: { runtime_id: input.runtime_id, state: "ACTIVE" },
      platform_origin: "https://one.acme.test",
      tenant_id: "tenant-acme",
      runtime_id: input.runtime_id,
      gateway_id: input.gateway_id,
      oidc: { client_id: input.runtime_id, client_secret: "runtime-secret" },
      credential_delivery: "ONE_TIME",
    };
    return new Response(JSON.stringify(bootstrap), { status: 201 });
  };
  const exec = async (command, args, options) => {
    commands.push({ command, args, options });
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    const evidence = await provisionGatewayRuntimeBootstraps({ environment, fetchImpl, exec });
    assert.deepEqual(evidence.runtime_ids, ["gateway-runtime-0"]);
    assert.equal(evidence.kubernetes_secret, "genio-one-gateway-bootstrap");
    assert.equal((await stat(`${bootstrapBase}.0.json`)).mode & 0o777, 0o600);
    assert.equal(requests[2].options.headers.authorization, "Bearer management-token");
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command, "kubectl");
    const secret = JSON.parse(commands[0].options.input);
    assert.equal(secret.metadata.name, "genio-one-gateway-bootstrap");
    const persisted = JSON.parse(Buffer.from(secret.data["gateway-runtime-0.json"], "base64").toString("utf8"));
    assert.equal(persisted.oidc.client_secret, "runtime-secret");
    assert.equal(JSON.stringify(evidence).includes("runtime-secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Self-service OIDC client uses the deployment origin and enforces PKCE", async () => {
  const desired = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../config/keycloak/genio-one-realm.json"), "utf8"),
  );
  const client = configureSelfServiceClient(desired, {
    GENIO_ONE_SELF_SERVICE_ORIGIN: "https://one.acme.com",
  });
  assert.deepEqual(client.redirectUris, [
    "https://one.acme.com/self-service",
    "https://one.acme.com/self-service/",
    "https://one.acme.com/self-service.html",
    "https://one.acme.com/*",
  ]);
  assert.deepEqual(client.webOrigins, ["https://one.acme.com", "+"]);
  assert.equal(client.publicClient, true);
  assert.equal(client.attributes["pkce.code.challenge.method"], "S256");
  assert.throws(
    () => configureSelfServiceClient(desired, { GENIO_ONE_SELF_SERVICE_ORIGIN: "https://one.acme.com/path" }),
    /must be an HTTP\(S\) origin/,
  );
});

test("Management Console OIDC client uses the deployment origin and management scope", async () => {
  const desired = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../config/keycloak/genio-one-realm.json"), "utf8"),
  );
  const client = configureManagementConsoleClient(desired, {
    GENIO_ONE_MANAGEMENT_CONSOLE_ORIGIN: "https://one.acme.com",
  });
  assert.equal(client.clientId, "genio-one-management-console");
  assert.deepEqual(client.redirectUris, [
    "https://one.acme.com/management",
    "https://one.acme.com/management/",
    "https://one.acme.com/management.html",
    "https://one.acme.com/*",
  ]);
  assert.deepEqual(client.webOrigins, ["https://one.acme.com", "+"]);
  assert.deepEqual(client.defaultClientScopes, [
    "basic",
    "genioone-management",
    "application.create",
    "audit.export",
  ]);
  assert.equal(client.publicClient, true);
  assert.equal(client.standardFlowEnabled, true);
  assert.equal(client.directAccessGrantsEnabled, false);
  assert.equal(client.attributes["pkce.code.challenge.method"], "S256");
  assert.throws(
    () => configureManagementConsoleClient(desired, {
      GENIO_ONE_MANAGEMENT_CONSOLE_ORIGIN: "https://one.acme.com/path",
    }),
    /must be an HTTP\(S\) origin/,
  );
});

test("management Agent OIDC client uses a deployment-owned PKCE callback", async () => {
  const desired = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../config/keycloak/genio-one-realm.json"), "utf8"),
  );
  const client = configureManagementAgentClient(desired, {
    GENIO_ONE_MANAGEMENT_AGENT_REDIRECT_URI: "https://agent.acme.com/oauth/callback",
  });
  assert.deepEqual(client.redirectUris, ["https://agent.acme.com/oauth/callback"]);
  assert.equal(client.publicClient, true);
  assert.equal(client.standardFlowEnabled, true);
  assert.equal(client.directAccessGrantsEnabled, false);
  assert.equal(client.attributes["pkce.code.challenge.method"], "S256");
  assert.throws(
    () => configureManagementAgentClient(desired, {
      GENIO_ONE_MANAGEMENT_AGENT_REDIRECT_URI: "file:///tmp/callback",
    }),
    /must be an absolute HTTP\(S\) URL/,
  );
});

test("Bot OIDC client uses the deployment bot origin and enforces PKCE", async () => {
  const desired = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../config/keycloak/genio-one-realm.json"), "utf8"),
  );
  const client = configureBotClient(desired, {
    GENIO_ONE_BOT_ORIGIN: "https://bot.acme.com",
  });
  assert.equal(client.clientId, "genio-one-bot");
  assert.deepEqual(client.redirectUris, [
    "https://bot.acme.com",
    "https://bot.acme.com/",
    "https://bot.acme.com/*",
    "http://127.0.0.1:5180",
    "http://127.0.0.1:5180/",
    "http://127.0.0.1:5180/*",
    "http://127.0.0.1:5181",
    "http://127.0.0.1:5181/",
    "http://127.0.0.1:5181/*",
  ]);
  assert.deepEqual(client.webOrigins, ["https://bot.acme.com", "+"]);
  assert.deepEqual(client.defaultClientScopes, [
    "basic",
    "genioone-invocation",
    "genioone-management",
  ]);
  assert.equal(client.publicClient, true);
  assert.equal(client.attributes["pkce.code.challenge.method"], "S256");
});

test("native MCP clients use Authorization Code with S256 and Keycloak dynamic loopback callbacks", async () => {
  const desired = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../config/keycloak/genio-one-realm.json"), "utf8"),
  );
  for (const clientId of ["codex-mcp", "grok-mcp"]) {
    const client = desired.clients.find((candidate) => candidate.clientId === clientId);
    assert.ok(client, `missing ${clientId}`);
    assert.equal(client.publicClient, true);
    assert.equal(client.standardFlowEnabled, true);
    assert.equal(client.directAccessGrantsEnabled, false);
    assert.equal(client.serviceAccountsEnabled, false);
    assert.equal(client.attributes["pkce.code.challenge.method"], "S256");
    assert.deepEqual(client.redirectUris, clientId === "codex-mcp"
      ? [
          "http://127.0.0.1:*",
          "http://genio-bot.localhost:5181/api/mcp/oauth/callback/*",
        ]
      : ["http://127.0.0.1:*"]);
    assert.deepEqual(client.defaultClientScopes, ["basic", "genioone-invocation"]);
  }
});

test("Codex persisted login requires consent and optional offline access without expanding invocation defaults", async () => {
  const desired = JSON.parse(await readFile(resolve(import.meta.dirname, "../config/keycloak/genio-one-realm.json"), "utf8"));
  const codex = desired.clients.find((client) => client.clientId === "codex-mcp");
  const grok = desired.clients.find((client) => client.clientId === "grok-mcp");
  assert.equal(codex.consentRequired, true);
  assert.equal(codex.fullScopeAllowed, false);
  assert.deepEqual(codex.defaultClientScopes, ["basic", "genioone-invocation"]);
  assert.deepEqual(codex.optionalClientScopes, ["offline_access"]);
  assert.equal(grok.consentRequired, undefined);
  assert.equal(grok.optionalClientScopes, undefined);
});

test("Codex offline scope reconciliation adds, reruns, and retracts only the managed optional link", async () => {
  const unrelated = { id: "scope-extra", name: "customer-scope" };
  const offline = { id: "scope-offline", name: "offline_access" };
  let linked = [unrelated];
  const mutations = [];
  const fetchImpl = async (url, options = {}) => {
    if (!options.method) return new Response(JSON.stringify(linked), { status: 200, headers: { "content-type": "application/json" } });
    mutations.push({ method: options.method, url });
    if (options.method === "PUT") linked.push(offline);
    else if (options.method === "DELETE") linked = linked.filter((scope) => scope.id !== offline.id);
    return new Response(null, { status: 204 });
  };
  const options = { realmUrl: "http://identity/admin/realms/genio-one", clientId: "client-codex", scopes: [offline, unrelated], headers: {}, fetchImpl };
  await reconcileCodexOfflineAccess({ ...options, client: { clientId: "codex-mcp", optionalClientScopes: ["offline_access"] } });
  assert.deepEqual(linked, [unrelated, offline]);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].method, "PUT");
  await reconcileCodexOfflineAccess({ ...options, client: { clientId: "codex-mcp", optionalClientScopes: ["offline_access"] } });
  assert.equal(mutations.length, 1);
  await reconcileCodexOfflineAccess({ ...options, client: { clientId: "codex-mcp", optionalClientScopes: [] } });
  assert.deepEqual(linked, [unrelated]);
  assert.equal(mutations.length, 2);
  assert.equal(mutations[1].method, "DELETE");
  assert.equal(mutations[1].url, "http://identity/admin/realms/genio-one/clients/client-codex/optional-client-scopes/scope-offline");
  await reconcileCodexOfflineAccess({ ...options, client: { clientId: "grok-mcp", optionalClientScopes: ["offline_access"] } });
  assert.equal(mutations.length, 2);
});

test("production identity bootstrap removes local clients and derives the administrator from install values", async () => {
  const desired = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../config/keycloak/genio-one-realm.json"), "utf8"),
  );
  configureProductionIdentityBootstrap(desired, {
    GENIO_ONE_KEYCLOAK_PRODUCTION_BOOTSTRAP: "1",
    GENIO_ONE_KEYCLOAK_REALM: "customer-realm",
    GENIO_ONE_KEYCLOAK_CLIENT_SECRET: "product-api-secret",
    GENIO_ONE_BOOTSTRAP_TENANT_ID: "tenant-acme",
    GENIO_ONE_BOOTSTRAP_ADMIN_EXTERNAL_SUBJECT_ID: "provider-subject-1",
    GENIO_ONE_BOOTSTRAP_ADMIN_USERNAME: "alice",
    GENIO_ONE_BOOTSTRAP_ADMIN_PASSWORD: "temporary-password",
    GENIO_ONE_BOOTSTRAP_ADMIN_DISPLAY_NAME: "Alice Admin",
    GENIO_ONE_BOOTSTRAP_ADMIN_EMAIL: "alice@example.com",
  });
  assert.equal(desired.realm, "customer-realm");
  assert.deepEqual(
    desired.clients.map((client) => client.clientId),
    [
      "genio-one-product-api",
      "genio-one-self-service",
      "genio-one-bot",
      "genio-one-management-console",
      "genio-one-management-agent",
      "codex-mcp",
      "grok-mcp",
    ],
  );
  assert.equal(desired.clients[0].secret, "product-api-secret");
  assert.deepEqual(desired.users, [
    {
      id: "provider-subject-1",
      username: "alice",
      enabled: true,
      emailVerified: true,
      firstName: "Alice",
      lastName: "Admin",
      email: "alice@example.com",
      attributes: { genioone_tenant_id: ["tenant-acme"] },
      credentials: [
        { type: "password", value: "temporary-password", temporary: false },
      ],
    },
  ]);
});

test("Keycloak realm reconciliation carries declared security and session settings", () => {
  const profile = keycloakRealmUpdateProfile(
    {
      realm: "genio-one",
      enabled: true,
      passwordPolicy: "length(12) and notUsername",
      bruteForceProtected: true,
      accessTokenLifespan: 300,
      ssoSessionIdleTimeout: 1800,
      smtpServer: { host: "smtp.example.test", from: "no-reply@example.test" },
      resetPasswordAllowed: true,
    },
    {},
  );
  assert.equal(profile.passwordPolicy, "length(12) and notUsername");
  assert.equal(profile.bruteForceProtected, true);
  assert.equal(profile.accessTokenLifespan, 300);
  assert.equal(profile.ssoSessionIdleTimeout, 1800);
  assert.deepEqual(profile.smtpServer, { host: "smtp.example.test", from: "no-reply@example.test" });
  assert.equal(profile.resetPasswordAllowed, true);
});

test("Keycloak realm reconciliation leaves undeclared security settings to the realm default", () => {
  const profile = keycloakRealmUpdateProfile(
    { realm: "genio-one", enabled: true, displayName: "GenioOne" },
    {},
  );
  // Absent keys must not be sent, or the reconciler would reset a setting an
  // operator configured directly in Keycloak.
  for (const key of ["passwordPolicy", "otpPolicy", "smtpServer", "accessTokenLifespan"]) {
    assert.equal(Object.hasOwn(profile, key), false);
  }
});

test("Keycloak realm reconciliation publishes the branded login theme without dropping existing attributes", () => {
  const profile = keycloakRealmUpdateProfile(
    {
      realm: "genio-one",
      enabled: true,
      displayName: "GenioOne Local MVP",
      loginTheme: "genio-one",
      internationalizationEnabled: true,
      supportedLocales: ["zh-TW", "en"],
      defaultLocale: "zh-TW",
      attributes: {
        "genio.login.brandName": "GenioOne",
        "genio.login.logoUrl": "https://cdn.example.test/logo.svg",
      },
    },
    { attributes: { "customer.tenantId": "tenant-acme", "genio.login.brandName": "Old name" } },
  );
  assert.equal(profile.loginTheme, "genio-one");
  assert.equal(profile.defaultLocale, "zh-TW");
  assert.deepEqual(profile.attributes, {
    "customer.tenantId": "tenant-acme",
    "genio.login.brandName": "GenioOne",
    "genio.login.logoUrl": "https://cdn.example.test/logo.svg",
  });
});

test("login branding accepts enterprise overrides and rejects unsafe color and logo values", () => {
  const desired = { attributes: { "customer.tenantId": "tenant-acme" } };
  configureLoginBranding(desired, {
    GENIO_ONE_KEYCLOAK_LOGIN_BRAND_NAME: "Acme AI",
    GENIO_ONE_KEYCLOAK_LOGIN_TAGLINE: "Trusted access for every team",
    GENIO_ONE_KEYCLOAK_LOGIN_LOGO_URL: "https://cdn.example.test/acme.svg",
    GENIO_ONE_KEYCLOAK_LOGIN_PRIMARY_COLOR: "#114b5f",
    GENIO_ONE_KEYCLOAK_LOGIN_PAGE_COLOR: "#eef5f4",
    GENIO_ONE_KEYCLOAK_LOGIN_CUSTOM_CSS: ".genio-brand__tagline { max-width: 20rem; }",
    GENIO_ONE_KEYCLOAK_LOGIN_BRANDING_ENDPOINT: "https://one.acme.com/v1/identity/login-branding",
  });
  assert.equal(desired.attributes["genio.login.brandName"], "Acme AI");
  assert.equal(desired.attributes["genio.login.logoUrl"], "https://cdn.example.test/acme.svg");
  assert.equal(desired.attributes["genio.login.primaryColor"], "#114b5f");
  assert.equal(desired.attributes["genio.login.brandingEndpoint"], "https://one.acme.com/v1/identity/login-branding");
  assert.equal(desired.attributes["customer.tenantId"], "tenant-acme");
  assert.throws(
    () => configureLoginBranding({}, { GENIO_ONE_KEYCLOAK_LOGIN_PRIMARY_COLOR: "red" }),
    /six-digit hexadecimal color/,
  );
  assert.throws(
    () => configureLoginBranding({}, { GENIO_ONE_KEYCLOAK_LOGIN_LOGO_URL: "javascript:alert(1)" }),
    /HTTPS, a loopback URL, or a relative path/,
  );
  assert.throws(
    () => configureLoginBranding({}, { GENIO_ONE_KEYCLOAK_LOGIN_BRANDING_ENDPOINT: "javascript:alert(1)" }),
    /HTTP\(S\) URL or a relative path/,
  );
  assert.throws(
    () => configureLoginBranding({}, { GENIO_ONE_KEYCLOAK_LOGIN_LOGO_URL: "//cdn.example.test/logo.svg" }),
    /HTTPS, a loopback URL, or a relative path/,
  );
  assert.throws(
    () => configureLoginBranding({}, { GENIO_ONE_KEYCLOAK_LOGIN_CUSTOM_CSS: "</style>" }),
    /must not contain a closing style tag/,
  );
});

const keycloakRealmUrl = "https://identity.acme.test/admin/realms/genio-one";

function bootstrapUser() {
  return {
    id: "6f9bff7d-3d1b-4c39-9b15-2bc8f24d1a1f",
    username: "fiona",
    enabled: true,
    emailVerified: true,
    firstName: "Fiona",
    lastName: "UAT",
    email: "fiona@example.test",
    attributes: { genioone_tenant_id: ["tenant-acme"] },
    credentials: [{ type: "password", value: "fiona-password", temporary: false }],
  };
}

test("Keycloak bootstrap creates a missing user through partialImport with FAIL", async () => {
  const user = bootstrapUser();
  const requests = [];
  let lookupCount = 0;
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("/users?username=")) {
      lookupCount += 1;
      return new Response(lookupCount === 1 ? "[]" : JSON.stringify([{ id: user.id }]), { status: 200 });
    }
    if (String(url).endsWith("/partialImport")) {
      return new Response(JSON.stringify({ added: 1 }), { status: 200 });
    }
    if (String(url).endsWith("/reset-password")) return new Response(null, { status: 204 });
    throw new Error(`unexpected request ${url}`);
  };

  await reconcileKeycloakUsers({
    realmUrl: keycloakRealmUrl,
    users: [user],
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    fetchImpl,
  });

  const partialImport = requests.find((request) => request.url.endsWith("/partialImport"));
  assert.ok(partialImport);
  assert.equal(partialImport.options.method, "POST");
  assert.deepEqual(JSON.parse(partialImport.options.body), {
    ifResourceExists: "FAIL",
    users: [user],
  });
  assert.equal(requests.some((request) => request.url.endsWith("/users") && request.options.method === "POST"), false);
  assert.equal(requests.filter((request) => request.url.includes("/users?username=")).length, 2);
  assert.equal(requests.filter((request) => request.url.endsWith("/reset-password")).length, 1);
});

test("Keycloak bootstrap accepts the requested stable ID after partialImport", async () => {
  const user = bootstrapUser();
  const requests = [];
  let importedUser;
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("/users?username=")) {
      return new Response(importedUser ? JSON.stringify([importedUser]) : "[]", { status: 200 });
    }
    if (String(url).endsWith("/partialImport")) {
      importedUser = JSON.parse(options.body).users[0];
      return new Response("{\"added\":1}", { status: 200 });
    }
    if (String(url).endsWith(`/users/${user.id}`)) return new Response(null, { status: 204 });
    if (String(url).endsWith("/reset-password")) return new Response(null, { status: 204 });
    throw new Error(`unexpected request ${url}`);
  };

  await reconcileKeycloakUsers({ realmUrl: keycloakRealmUrl, users: [user], headers: {}, fetchImpl });
  await reconcileKeycloakUsers({ realmUrl: keycloakRealmUrl, users: [user], headers: {}, fetchImpl });

  const lookups = requests.filter((request) => request.url.includes("/users?username="));
  assert.equal(lookups.length, 3);
  assert.equal(lookups[1].url, `${keycloakRealmUrl}/users?username=fiona&exact=true`);
  assert.equal(requests.filter((request) => request.url.endsWith("/partialImport")).length, 1);
  assert.equal(requests.filter((request) => request.url.endsWith(`/users/${user.id}`)).length, 1);
  assert.equal(importedUser.id, user.id);
  assert.equal(requests.filter((request) => request.url.endsWith("/reset-password")).length, 2);
});

test("Keycloak bootstrap preserves strict drift and duplicate failures", async (t) => {
  await t.test("rejects an existing user with a different subject ID", async () => {
    const user = bootstrapUser();
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).includes("/users?username=")) {
        return new Response(JSON.stringify([{ id: "2717546a-1db5-45ea-9e61-1e27f3a9f7c1" }]), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    };

    await assert.rejects(
      reconcileKeycloakUsers({ realmUrl: keycloakRealmUrl, users: [user], headers: {}, fetchImpl }),
      /subject id drifted: expected 6f9bff7d-3d1b-4c39-9b15-2bc8f24d1a1f, observed 2717546a-1db5-45ea-9e61-1e27f3a9f7c1/,
    );
    assert.equal(requests.length, 1);
  });

  await t.test("rejects duplicate exact-username matches", async () => {
    const user = bootstrapUser();
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).includes("/users?username=")) {
        return new Response(JSON.stringify([{ id: "first" }, { id: "second" }]), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    };

    await assert.rejects(
      reconcileKeycloakUsers({ realmUrl: keycloakRealmUrl, users: [user], headers: {}, fetchImpl }),
      /Keycloak returned duplicate user fiona/,
    );
    assert.equal(requests.length, 1);
  });
});

test("versioned post-install is rerunnable and recovers after an injected failure", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "genio-one-post-install-"));
  const journalPath = resolve(directory, "journal.json");
  const calls = [];
  const steps = [
    { id: "schema", version: "1", run: async () => calls.push("schema") },
    { id: "provider", version: "2", run: async () => calls.push("provider") },
  ];
  try {
    await assert.rejects(
      runVersionedSteps({ journalPath, steps, failStep: "provider" }),
      /injected post-install failure/,
    );
    let journal = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(journal.status, "FAILED");
    assert.equal(journal.steps.schema.status, "COMPLETED");
    assert.equal(journal.steps.provider.status, "FAILED");

    await runVersionedSteps({ journalPath, steps });
    await runVersionedSteps({ journalPath, steps });
    journal = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(journal.status, "COMPLETED");
    assert.equal(journal.runs, 3);
    assert.equal(journal.steps.schema.attempts, 3);
    assert.equal(journal.steps.provider.attempts, 3);
    assert.deepEqual(calls, ["schema", "schema", "provider", "schema", "provider"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
