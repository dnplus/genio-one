import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseEnvironment as parseDotEnv } from "./environment.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(appRoot, "../..");
export const POST_INSTALL_SCHEMA_VERSION = 1;
export const POST_INSTALL_RELEASE = "2026-08-30.1";

export const parseEnvironment = parseDotEnv;

async function loadEnvironment() {
  for (const filename of [".env.local", ".env.example"]) {
    try {
      return parseEnvironment(await readFile(resolve(appRoot, filename), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return {};
}

function required(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function gatewayRuntimeBootstrapTargets(environment) {
  if (environment.GENIO_ONE_GATEWAY_RUNTIME_ID) {
    throw new Error(
      "GENIO_ONE_GATEWAY_RUNTIME_ID is no longer supported; configure GENIO_ONE_GATEWAY_RUNTIME_IDS",
    );
  }
  const runtimeIds = required(environment, "GENIO_ONE_GATEWAY_RUNTIME_IDS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (runtimeIds.length === 0 || new Set(runtimeIds).size !== runtimeIds.length) {
    throw new Error("Gateway Runtime IDs must be a non-empty, unique comma-separated list");
  }
  const bootstrapFile = required(environment, "GENIO_ONE_GATEWAY_BOOTSTRAP_FILE");
  return runtimeIds.map((runtimeId, index) => ({
    runtimeId,
    bootstrapFile: `${bootstrapFile}.${index}.json`,
  }));
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? workspaceRoot,
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!options.quiet) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (!options.quiet) process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else if (code !== 0 && !options.allowFailure) {
        reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
      } else resolveRun({ code, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

async function readJournal(path) {
  try {
    const journal = JSON.parse(await readFile(path, "utf8"));
    if (journal.schema_version !== POST_INSTALL_SCHEMA_VERSION) {
      throw new Error(`unsupported post-install journal schema ${journal.schema_version}`);
    }
    return journal;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      schema_version: POST_INSTALL_SCHEMA_VERSION,
      release: POST_INSTALL_RELEASE,
      runs: 0,
      steps: {},
    };
  }
}

async function writeJournal(path, journal) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function runVersionedSteps({
  journalPath,
  steps,
  failStep,
  clock = () => new Date().toISOString(),
}) {
  const journal = await readJournal(journalPath);
  journal.release = POST_INSTALL_RELEASE;
  journal.runs += 1;
  journal.started_at = clock();
  journal.status = "RUNNING";
  await writeJournal(journalPath, journal);
  for (const step of steps) {
    const previous = journal.steps[step.id];
    const record = {
      version: step.version,
      attempts: (previous?.attempts ?? 0) + 1,
      status: "RUNNING",
      started_at: clock(),
    };
    journal.steps[step.id] = record;
    await writeJournal(journalPath, journal);
    try {
      if (failStep === step.id) {
        throw new Error(`injected post-install failure at ${step.id}`);
      }
      const evidence = await step.run();
      Object.assign(record, {
        status: "COMPLETED",
        completed_at: clock(),
        evidence: evidence ?? null,
      });
      await writeJournal(journalPath, journal);
    } catch (error) {
      Object.assign(record, {
        status: "FAILED",
        failed_at: clock(),
        error: String(error?.message ?? error),
      });
      journal.status = "FAILED";
      journal.failed_at = clock();
      await writeJournal(journalPath, journal);
      throw error;
    }
  }
  journal.status = "COMPLETED";
  journal.completed_at = clock();
  await writeJournal(journalPath, journal);
  return journal;
}

async function requestJson(fetchImpl, url, options = {}, accepted = [200]) {
  const response = await fetchImpl(url, options);
  const encoded = await response.text();
  if (!accepted.includes(response.status)) {
    throw new Error(
      `${options.method ?? "GET"} ${url} returned HTTP ${response.status}: ${encoded.slice(0, 512)}`,
    );
  }
  return encoded.trim() ? JSON.parse(encoded) : null;
}

async function tenantAdministratorAccessToken(environment, fetchImpl) {
  const origin = required(environment, "GENIO_ONE_KEYCLOAK_ORIGIN").replace(/\/$/, "");
  const realm = required(environment, "GENIO_ONE_KEYCLOAK_REALM");
  const token = await requestJson(fetchImpl, `${origin}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: required(environment, "GENIO_ONE_KEYCLOAK_CLIENT_ID"),
      client_secret: required(environment, "GENIO_ONE_KEYCLOAK_CLIENT_SECRET"),
      username: required(environment, "GENIO_ONE_BOOTSTRAP_ADMIN_USERNAME"),
      password: required(environment, "GENIO_ONE_BOOTSTRAP_ADMIN_PASSWORD"),
      scope: "genioone-management",
    }),
  });
  if (typeof token?.access_token !== "string" || !token.access_token) {
    throw new Error("Tenant Administrator token response is missing access_token");
  }
  return token.access_token;
}

async function readGatewayBootstrap(path) {
  try {
    const bytes = await readFile(path);
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function validateGatewayBootstrap(value, tenantId, runtimeId) {
  if (
    value?.schema_version !== "genio.one.gateway-bootstrap.v1" ||
    value?.tenant_id !== tenantId ||
    value?.runtime_id !== runtimeId ||
    value?.registration?.runtime_id !== runtimeId ||
    value?.registration?.state !== "ACTIVE" ||
    value?.credential_delivery !== "ONE_TIME"
  ) {
    throw new Error(`Gateway bootstrap for ${runtimeId} is inconsistent`);
  }
}

async function writePrivateGatewayBootstrap(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function publishGatewayBootstrapSecret(environment, bootstraps, exec) {
  const secretName = environment.GENIO_ONE_KUBERNETES_GATEWAY_BOOTSTRAP_SECRET?.trim();
  if (!secretName) return null;
  const namespace = required(environment, "GENIO_ONE_KUBERNETES_NAMESPACE");
  const data = {};
  for (const { runtimeId, bytes } of bootstraps) {
    if (!/^[A-Za-z0-9._-]+$/.test(runtimeId)) {
      throw new Error(`Gateway Runtime ID ${runtimeId} cannot be used as a Kubernetes Secret key`);
    }
    data[`${runtimeId}.json`] = bytes.toString("base64");
  }
  const manifest = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: secretName, namespace },
    type: "Opaque",
    data,
  };
  await exec(environment.GENIO_ONE_KUBECTL ?? "kubectl", [
    "apply",
    "--server-side",
    "--field-manager=genio-one-installer",
    "--namespace",
    namespace,
    "--filename",
    "-",
  ], {
    input: `${JSON.stringify(manifest)}\n`,
    quiet: true,
  });
  return secretName;
}

export async function provisionGatewayRuntimeBootstraps({
  environment,
  fetchImpl = fetch,
  exec = runCommand,
}) {
  const platformOrigin = required(environment, "GENIO_ONE_PLATFORM_ORIGIN").replace(/\/$/, "");
  const tenantId = required(environment, "GENIO_ONE_GATEWAY_TENANT_ID");
  const targets = gatewayRuntimeBootstrapTargets(environment);
  const accessToken = await tenantAdministratorAccessToken(environment, fetchImpl);
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  const registrationsUrl = `${platformOrigin}/v1/tenants/${encodeURIComponent(tenantId)}/gateways`;
  const registrations = await requestJson(fetchImpl, registrationsUrl, { headers });
  if (!Array.isArray(registrations)) throw new Error("Gateway registration inventory must be an array");
  const byRuntime = new Map(registrations.map((registration) => [registration.runtime_id, registration]));
  const bootstraps = [];
  for (const target of targets) {
    const existing = byRuntime.get(target.runtimeId);
    let bootstrap = await readGatewayBootstrap(target.bootstrapFile);
    if (existing?.state === "RETIRED") {
      throw new Error(`Gateway ${target.runtimeId} is retired and cannot be reprovisioned`);
    }
    if (existing?.state === "ACTIVE") {
      if (!bootstrap) {
        throw new Error(`Gateway ${target.runtimeId} is active but its one-time bootstrap file is unavailable`);
      }
    } else {
      const response = await requestJson(fetchImpl, existing?.state === "PROVISIONING"
        ? `${registrationsUrl}/${encodeURIComponent(target.runtimeId)}/provision`
        : registrationsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(existing?.state === "PROVISIONING"
          ? { correlation_id: `post-install-provision-${target.runtimeId}` }
          : {
              correlation_id: `post-install-register-${target.runtimeId}`,
              runtime_id: target.runtimeId,
              display_name: required(environment, "GENIO_ONE_GATEWAY_DISPLAY_NAME"),
              gateway_id: required(environment, "GENIO_ONE_GATEWAY_ID"),
              site_id: required(environment, "GENIO_ONE_GATEWAY_SITE_ID"),
              region: required(environment, "GENIO_ONE_GATEWAY_REGION"),
              labels: { "managed-by": "genio-one-installer" },
            }),
      }, existing?.state === "PROVISIONING" ? [200] : [201]);
      await writePrivateGatewayBootstrap(target.bootstrapFile, response);
      bootstrap = await readGatewayBootstrap(target.bootstrapFile);
    }
    validateGatewayBootstrap(bootstrap?.value, tenantId, target.runtimeId);
    bootstraps.push({ runtimeId: target.runtimeId, bytes: bootstrap.bytes });
  }
  const secretName = await publishGatewayBootstrapSecret(environment, bootstraps, exec);
  return {
    runtime_ids: bootstraps.map(({ runtimeId }) => runtimeId),
    bootstrap_digests: Object.fromEntries(bootstraps.map(({ runtimeId, bytes }) => [
      runtimeId,
      createHash("sha256").update(bytes).digest("hex"),
    ])),
    kubernetes_secret: secretName,
  };
}

async function waitForKeycloakAdminToken(environment, fetchImpl) {
  const origin = required(environment, "GENIO_ONE_KEYCLOAK_ORIGIN");
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${origin}/realms/master/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "admin-cli",
          username: required(environment, "GENIO_ONE_KEYCLOAK_ADMIN"),
          password: required(environment, "GENIO_ONE_KEYCLOAK_ADMIN_PASSWORD"),
        }),
      });
      if (response.ok) {
        const token = await response.json();
        return token.access_token;
      }
      lastError = new Error(`Keycloak token returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Keycloak Admin API did not become ready: ${lastError}`);
}

export function configureSelfServiceClient(desired, environment) {
  const selfServiceOrigin = (
    environment.GENIO_ONE_SELF_SERVICE_ORIGIN ?? "http://127.0.0.1:58081"
  ).replace(/\/$/, "");
  const selfServiceUrl = new URL(selfServiceOrigin);
  if (
    !["http:", "https:"].includes(selfServiceUrl.protocol) ||
    selfServiceUrl.pathname !== "/" ||
    selfServiceUrl.search ||
    selfServiceUrl.hash ||
    selfServiceUrl.username ||
    selfServiceUrl.password
  ) {
    throw new Error("GENIO_ONE_SELF_SERVICE_ORIGIN must be an HTTP(S) origin without a path");
  }
  const selfServiceClient = (desired.clients ?? []).find(
    (client) => client.clientId === "genio-one-self-service",
  );
  if (!selfServiceClient) throw new Error("Keycloak desired state is missing Self-service client");
  selfServiceClient.redirectUris = [
    `${selfServiceOrigin}/self-service`,
    `${selfServiceOrigin}/self-service/`,
    `${selfServiceOrigin}/self-service.html`,
    `${selfServiceOrigin}/*`,
  ];
  selfServiceClient.webOrigins = [selfServiceOrigin, "+"];
  return selfServiceClient;
}

export function configureManagementConsoleClient(desired, environment) {
  const managementOrigin = (
    environment.GENIO_ONE_MANAGEMENT_CONSOLE_ORIGIN
      ?? environment.GENIO_ONE_SELF_SERVICE_ORIGIN
      ?? "http://127.0.0.1:58081"
  ).replace(/\/$/, "");
  const managementUrl = new URL(managementOrigin);
  if (
    !["http:", "https:"].includes(managementUrl.protocol) ||
    managementUrl.pathname !== "/" ||
    managementUrl.search ||
    managementUrl.hash ||
    managementUrl.username ||
    managementUrl.password
  ) {
    throw new Error("GENIO_ONE_MANAGEMENT_CONSOLE_ORIGIN must be an HTTP(S) origin without a path");
  }
  const clientId = environment.GENIO_ONE_MANAGEMENT_OIDC_CLIENT_ID
    ?? "genio-one-management-console";
  const managementClient = (desired.clients ?? []).find(
    (client) => client.clientId === clientId,
  );
  if (!managementClient) {
    throw new Error(`Keycloak desired state is missing Management Console client ${clientId}`);
  }
  managementClient.redirectUris = [
    `${managementOrigin}/management`,
    `${managementOrigin}/management/`,
    `${managementOrigin}/management.html`,
    `${managementOrigin}/*`,
  ];
  managementClient.webOrigins = [managementOrigin, "+"];
  return managementClient;
}

export function configureManagementAgentClient(desired, environment) {
  const redirectUri = environment.GENIO_ONE_MANAGEMENT_AGENT_REDIRECT_URI
    ?? "http://127.0.0.1:8765/callback";
  const redirectUrl = new URL(redirectUri);
  if (
    !["http:", "https:"].includes(redirectUrl.protocol)
    || redirectUrl.username
    || redirectUrl.password
    || redirectUrl.hash
  ) {
    throw new Error("GENIO_ONE_MANAGEMENT_AGENT_REDIRECT_URI must be an absolute HTTP(S) URL without credentials or fragment");
  }
  const client = (desired.clients ?? []).find(
    (candidate) => candidate.clientId === "genio-one-management-agent",
  );
  if (!client) throw new Error("Keycloak desired state is missing management Agent client");
  client.redirectUris = [redirectUrl.toString()];
  return client;
}

export function configureBotClient(desired, environment) {
  const botOrigin = (
    environment.GENIO_ONE_BOT_ORIGIN
      || environment.GENIO_ONE_PUBLIC_ORIGIN
      || "http://127.0.0.1:5180"
  ).replace(/\/$/, "");
  const botClient = (desired.clients ?? []).find(
    (client) => client.clientId === "genio-one-bot",
  );
  if (!botClient) return null;
  botClient.redirectUris = [
    `${botOrigin}`,
    `${botOrigin}/`,
    `${botOrigin}/*`,
    "http://127.0.0.1:5180",
    "http://127.0.0.1:5180/",
    "http://127.0.0.1:5180/*",
    "http://127.0.0.1:5181",
    "http://127.0.0.1:5181/",
    "http://127.0.0.1:5181/*",
  ];
  botClient.webOrigins = [botOrigin, "+"];
  botClient.defaultClientScopes = [
    "basic",
    "genioone-invocation",
    "genioone-management",
  ];
  return botClient;
}

export function configureProductionIdentityBootstrap(desired, environment) {
  if (environment.GENIO_ONE_KEYCLOAK_PRODUCTION_BOOTSTRAP !== "1") return desired;
  desired.realm = required(environment, "GENIO_ONE_KEYCLOAK_REALM");
  const retainedClients = new Set([
    "genio-one-product-api",
    "genio-one-self-service",
    "genio-one-management-console",
    "genio-one-management-agent",
    "genio-one-bot",
    "codex-mcp",
    "grok-mcp",
  ]);
  desired.clients = (desired.clients ?? []).filter((client) =>
    retainedClients.has(client.clientId),
  );
  const productApi = desired.clients.find(
    (client) => client.clientId === "genio-one-product-api",
  );
  if (!productApi) throw new Error("Keycloak desired state is missing Product API client");
  productApi.secret = required(environment, "GENIO_ONE_KEYCLOAK_CLIENT_SECRET");

  const externalSubject = required(
    environment,
    "GENIO_ONE_BOOTSTRAP_ADMIN_EXTERNAL_SUBJECT_ID",
  );
  const username = required(environment, "GENIO_ONE_BOOTSTRAP_ADMIN_USERNAME");
  const password = required(environment, "GENIO_ONE_BOOTSTRAP_ADMIN_PASSWORD");
  const displayName =
    environment.GENIO_ONE_BOOTSTRAP_ADMIN_DISPLAY_NAME ?? "Platform Administrator";
  const words = displayName.trim().split(/\s+/);
  desired.users = [
    {
      id: externalSubject,
      username,
      enabled: true,
      emailVerified: true,
      firstName: words[0] ?? displayName,
      lastName: words.slice(1).join(" ") || "Administrator",
      email: environment.GENIO_ONE_BOOTSTRAP_ADMIN_EMAIL,
      attributes: {
        genioone_tenant_id: [required(environment, "GENIO_ONE_BOOTSTRAP_TENANT_ID")],
      },
      credentials: [{ type: "password", value: password, temporary: false }],
    },
  ];
  const people = JSON.parse(environment.GENIO_ONE_BOOTSTRAP_PEOPLE_JSON || "[]");
  if (!Array.isArray(people)) throw new Error("BOOTSTRAP_PEOPLE_INVALID");
  const passwords = people.length ? JSON.parse(required(environment, "GENIO_ONE_BOOTSTRAP_PEOPLE_PASSWORDS_JSON")) : {};
  const names = new Set([username]);
  const identities = new Set([externalSubject]);
  for (const person of people) {
    if (!person || ![person.username, person.externalSubjectId, person.subjectId, person.displayName].every((value) => typeof value === "string" && value.trim())) throw new Error("BOOTSTRAP_PERSON_INVALID");
    if (names.has(person.username) || identities.has(person.externalSubjectId)) throw new Error("BOOTSTRAP_PERSON_CONFLICT");
    if (typeof passwords[person.username] !== "string" || passwords[person.username].length < 12) throw new Error("BOOTSTRAP_PERSON_PASSWORD_REQUIRED");
    names.add(person.username);
    identities.add(person.externalSubjectId);
    desired.users.push({
      id: person.externalSubjectId,
      username: person.username,
      enabled: true,
      emailVerified: true,
      firstName: person.displayName,
      lastName: person.department || "UAT",
      email: person.email,
      attributes: { genioone_tenant_id: [required(environment, "GENIO_ONE_BOOTSTRAP_TENANT_ID")] },
      credentials: [{ type: "password", value: passwords[person.username], temporary: false }],
    });
  }
  return desired;
}

const loginBrandingEnvironment = new Map([
  ["GENIO_ONE_KEYCLOAK_LOGIN_BRAND_NAME", "genio.login.brandName"],
  ["GENIO_ONE_KEYCLOAK_LOGIN_TAGLINE", "genio.login.tagline"],
  ["GENIO_ONE_KEYCLOAK_LOGIN_LOGO_URL", "genio.login.logoUrl"],
  ["GENIO_ONE_KEYCLOAK_LOGIN_PRIMARY_COLOR", "genio.login.primaryColor"],
  ["GENIO_ONE_KEYCLOAK_LOGIN_PAGE_COLOR", "genio.login.pageColor"],
  ["GENIO_ONE_KEYCLOAK_LOGIN_CUSTOM_CSS", "genio.login.customCss"],
  ["GENIO_ONE_KEYCLOAK_LOGIN_BRANDING_ENDPOINT", "genio.login.brandingEndpoint"],
]);

export function configureLoginBranding(desired, environment) {
  const values = [...loginBrandingEnvironment.entries()]
    .filter(([environmentName]) => environment[environmentName] !== undefined)
    .map(([environmentName, attributeName]) => [
      attributeName,
      environment[environmentName],
      environmentName,
    ]);
  if (values.length === 0) return desired;
  const attributes = { ...(desired.attributes ?? {}) };
  for (const [attributeName, rawValue, environmentName] of values) {
    const value = String(rawValue);
    const trimmed = value.trim();
    if (attributeName === "genio.login.brandName" || attributeName === "genio.login.tagline") {
      if (trimmed.length > 256) throw new Error(`${environmentName} must be at most 256 characters`);
    } else if (attributeName === "genio.login.logoUrl") {
      if (
        trimmed &&
        !trimmed.startsWith("https://") &&
        !trimmed.startsWith("http://127.0.0.1") &&
        !trimmed.startsWith("http://localhost") &&
        !(trimmed.startsWith("/") && !trimmed.startsWith("//"))
      ) {
        throw new Error(`${environmentName} must use HTTPS, a loopback URL, or a relative path`);
      }
      if (trimmed.length > 2048) throw new Error(`${environmentName} must be at most 2048 characters`);
    } else if (attributeName === "genio.login.primaryColor" || attributeName === "genio.login.pageColor") {
      if (trimmed && !/^[#][0-9A-Fa-f]{6}$/.test(trimmed)) {
        throw new Error(`${environmentName} must be a six-digit hexadecimal color`);
      }
    } else if (attributeName === "genio.login.customCss") {
      if (value.length > 16_384) throw new Error(`${environmentName} must be at most 16384 characters`);
      if (/<\/style\b/i.test(value)) throw new Error(`${environmentName} must not contain a closing style tag`);
    } else if (attributeName === "genio.login.brandingEndpoint") {
      let valid = trimmed.startsWith("/") && !trimmed.startsWith("//");
      if (!valid) {
        try {
          const endpoint = new URL(trimmed);
          valid = endpoint.protocol === "http:" || endpoint.protocol === "https:";
        } catch {
          valid = false;
        }
      }
      if (!valid) throw new Error(`${environmentName} must use an HTTP(S) URL or a relative path`);
      if (trimmed.length > 2048) throw new Error(`${environmentName} must be at most 2048 characters`);
    }
    attributes[attributeName] = attributeName === "genio.login.customCss" ? value : trimmed;
  }
  desired.attributes = attributes;
  return desired;
}

export function keycloakRealmUpdateProfile(desired, current = {}) {
  const currentAttributes =
    typeof current.attributes === "object" && current.attributes !== null
      ? current.attributes
      : {};
  return {
    realm: desired.realm,
    enabled: desired.enabled,
    ...(desired.displayName !== undefined ? { displayName: desired.displayName } : {}),
    ...(desired.loginTheme !== undefined ? { loginTheme: desired.loginTheme } : {}),
    ...(desired.internationalizationEnabled !== undefined
      ? { internationalizationEnabled: desired.internationalizationEnabled }
      : {}),
    ...(desired.supportedLocales !== undefined ? { supportedLocales: desired.supportedLocales } : {}),
    ...(desired.defaultLocale !== undefined ? { defaultLocale: desired.defaultLocale } : {}),
    ...(desired.attributes !== undefined
      ? { attributes: { ...currentAttributes, ...desired.attributes } }
      : {}),
    // Security and session settings the realm file may declare. Without these
    // an operator could add a password policy, OTP policy, SMTP server or
    // token lifespan to the realm file and have it silently dropped on every
    // upgrade, because only the create path applies the whole document.
    ...realmSecurityProfile(desired),
  };
}

const REALM_SECURITY_KEYS = [
  "passwordPolicy",
  "otpPolicy",
  "smtpServer",
  "resetPasswordAllowed",
  "verifyEmail",
  "loginWithEmailAllowed",
  "duplicateEmailsAllowed",
  "bruteForceProtected",
  "permanentLockout",
  "maxFailureWaitSeconds",
  "failureFactor",
  "accessTokenLifespan",
  "ssoSessionIdleTimeout",
  "ssoSessionMaxLifespan",
];

/** Copies only the keys the realm file actually declares, so an absent key keeps the realm default. */
export function realmSecurityProfile(desired) {
  const profile = {};
  for (const key of REALM_SECURITY_KEYS) {
    if (desired[key] !== undefined) profile[key] = desired[key];
  }
  return profile;
}

export async function reconcileKeycloakUsers({
  realmUrl,
  users,
  headers,
  fetchImpl = fetch,
}) {
  for (const user of users ?? []) {
    let matches = await requestJson(
      fetchImpl,
      `${realmUrl}/users?username=${encodeURIComponent(user.username)}&exact=true`,
      { headers },
    );
    if (matches.length > 1) throw new Error(`Keycloak returned duplicate user ${user.username}`);
    if (matches.length === 0) {
      await requestJson(
        fetchImpl,
        `${realmUrl}/partialImport`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ ifResourceExists: "FAIL", users: [user] }),
        },
        [200],
      );
      matches = await requestJson(
        fetchImpl,
        `${realmUrl}/users?username=${encodeURIComponent(user.username)}&exact=true`,
        { headers },
      );
    } else {
      if (user.id && matches[0].id !== user.id) {
        throw new Error(
          `Keycloak managed user ${user.username} subject id drifted: expected ${user.id}, observed ${matches[0].id}`,
        );
      }
      const { credentials: _credentials, ...profile } = user;
      await requestJson(
        fetchImpl,
        `${realmUrl}/users/${matches[0].id}`,
        { method: "PUT", headers, body: JSON.stringify(profile) },
        [204],
      );
    }
    if (matches.length !== 1) throw new Error(`Keycloak did not reconcile user ${user.username}`);
    if (user.id && matches[0].id !== user.id) {
      throw new Error(
        `Keycloak managed user ${user.username} subject id drifted: expected ${user.id}, observed ${matches[0].id}`,
      );
    }
    for (const credential of user.credentials ?? []) {
      await requestJson(
        fetchImpl,
        `${realmUrl}/users/${matches[0].id}/reset-password`,
        { method: "PUT", headers, body: JSON.stringify(credential) },
        [204],
      );
    }
  }
}

export async function reconcileCodexOfflineAccess({ realmUrl, client, clientId, scopes, headers, fetchImpl = fetch }) {
  if (client.clientId !== "codex-mcp") return;
  const desired = (client.optionalClientScopes ?? []).includes("offline_access");
  const url = `${realmUrl}/clients/${clientId}/optional-client-scopes`;
  const current = await requestJson(fetchImpl, url, { headers });
  const linked = current.find((scope) => scope.name === "offline_access");
  if (!desired && linked) {
    await requestJson(fetchImpl, `${url}/${linked.id}`, { method: "DELETE", headers }, [204]);
  } else if (desired && !linked) {
    const scope = scopes.find((candidate) => candidate.name === "offline_access");
    if (!scope) throw new Error("Keycloak client scope offline_access does not exist");
    await requestJson(fetchImpl, `${url}/${scope.id}`, { method: "PUT", headers }, [204]);
  }
}

async function keycloakReconcile(environment, fetchImpl = fetch) {
  const origin = required(environment, "GENIO_ONE_KEYCLOAK_ORIGIN");
  const desired = JSON.parse(
    await readFile(resolve(appRoot, "config/keycloak/genio-one-realm.json"), "utf8"),
  );
  configureProductionIdentityBootstrap(desired, environment);
  configureLoginBranding(desired, environment);
  const token = await waitForKeycloakAdminToken(environment, fetchImpl);
  configureSelfServiceClient(desired, environment);
  configureManagementConsoleClient(desired, environment);
  configureManagementAgentClient(desired, environment);
  configureBotClient(desired, environment);
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const realmUrl = `${origin}/admin/realms/${encodeURIComponent(desired.realm)}`;
  const current = await fetchImpl(realmUrl, { headers });
  if (current.status === 404) {
    await requestJson(
      fetchImpl,
      `${origin}/admin/realms`,
      { method: "POST", headers, body: JSON.stringify(desired) },
      [201, 204],
    );
  } else {
    if (!current.ok) {
      throw new Error(`Keycloak realm lookup returned HTTP ${current.status}`);
    }
    const currentRealm = await current.json();
    await requestJson(
      fetchImpl,
      realmUrl,
      {
        method: "PUT",
        headers,
        body: JSON.stringify(keycloakRealmUpdateProfile(desired, currentRealm)),
      },
      [204],
    );
  }

  let existingScopes = await requestJson(
    fetchImpl,
    `${realmUrl}/client-scopes`,
    { headers },
  );
  for (const scope of desired.clientScopes ?? []) {
    let existing = existingScopes.find((candidate) => candidate.name === scope.name);
    const { protocolMappers = [], ...scopeProfile } = scope;
    if (existing) {
      await requestJson(
        fetchImpl,
        `${realmUrl}/client-scopes/${existing.id}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({ ...scopeProfile, id: existing.id }),
        },
        [204],
      );
    } else {
      await requestJson(
        fetchImpl,
        `${realmUrl}/client-scopes`,
        { method: "POST", headers, body: JSON.stringify(scopeProfile) },
        [201, 204],
      );
      existingScopes = await requestJson(fetchImpl, `${realmUrl}/client-scopes`, { headers });
      existing = existingScopes.find((candidate) => candidate.name === scope.name);
      if (!existing) throw new Error(`Keycloak did not create client scope ${scope.name}`);
    }
    const mapperUrl = `${realmUrl}/client-scopes/${existing.id}/protocol-mappers/models`;
    const existingMappers = await requestJson(fetchImpl, mapperUrl, { headers });
    for (const mapper of protocolMappers) {
      const currentMapper = existingMappers.find((candidate) => candidate.name === mapper.name);
      if (currentMapper) {
        await requestJson(
          fetchImpl,
          `${mapperUrl}/${currentMapper.id}`,
          {
            method: "PUT",
            headers,
            body: JSON.stringify({ ...mapper, id: currentMapper.id }),
          },
          [204],
        );
      } else {
        await requestJson(
          fetchImpl,
          mapperUrl,
          { method: "POST", headers, body: JSON.stringify(mapper) },
          [201, 204],
        );
      }
    }
  }

  const managedScopeNames = new Set(
    (desired.clientScopes ?? [])
      .map((scope) => scope.name)
      .filter((name) => name.startsWith("genioone-")),
  );
  for (const client of desired.clients ?? []) {
    let matches = await requestJson(
      fetchImpl,
      `${realmUrl}/clients?clientId=${encodeURIComponent(client.clientId)}`,
      { headers },
    );
    if (matches.length > 1) {
      throw new Error(`Keycloak returned duplicate client ${client.clientId}`);
    }
    const { defaultClientScopes = [], optionalClientScopes, protocolMappers = [], ...clientProfile } = client;
    if (matches.length === 0) {
      await requestJson(
        fetchImpl,
        `${realmUrl}/clients`,
        { method: "POST", headers, body: JSON.stringify(clientProfile) },
        [201, 204],
      );
      matches = await requestJson(
        fetchImpl,
        `${realmUrl}/clients?clientId=${encodeURIComponent(client.clientId)}`,
        { headers },
      );
      if (matches.length !== 1) throw new Error(`Keycloak did not create ${client.clientId}`);
    } else {
      await requestJson(
        fetchImpl,
        `${realmUrl}/clients/${matches[0].id}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({ ...clientProfile, id: matches[0].id }),
        },
        [204],
      );
    }
    const clientId = matches[0].id;
    const mapperUrl = `${realmUrl}/clients/${clientId}/protocol-mappers/models`;
    const existingMappers = await requestJson(fetchImpl, mapperUrl, { headers });
    const desiredMapperNames = new Set(protocolMappers.map((mapper) => mapper.name));
    for (const existing of existingMappers) {
      if (existing.name.startsWith("genio-one-") && !desiredMapperNames.has(existing.name)) {
        await requestJson(
          fetchImpl,
          `${mapperUrl}/${existing.id}`,
          { method: "DELETE", headers },
          [204],
        );
      }
    }
    for (const mapper of protocolMappers) {
      const existing = existingMappers.find((candidate) => candidate.name === mapper.name);
      if (existing) {
        await requestJson(
          fetchImpl,
          `${mapperUrl}/${existing.id}`,
          { method: "PUT", headers, body: JSON.stringify({ ...mapper, id: existing.id }) },
          [204],
        );
      } else {
        await requestJson(
          fetchImpl,
          mapperUrl,
          { method: "POST", headers, body: JSON.stringify(mapper) },
          [201, 204],
        );
      }
    }
    const currentDefaultScopes = await requestJson(
      fetchImpl,
      `${realmUrl}/clients/${clientId}/default-client-scopes`,
      { headers },
    );
    for (const scope of currentDefaultScopes) {
      if (managedScopeNames.has(scope.name) && !defaultClientScopes.includes(scope.name)) {
        await requestJson(
          fetchImpl,
          `${realmUrl}/clients/${clientId}/default-client-scopes/${scope.id}`,
          { method: "DELETE", headers },
          [204],
        );
      }
    }
    for (const name of defaultClientScopes) {
      const scope = existingScopes.find((candidate) => candidate.name === name);
      if (!scope) throw new Error(`Keycloak client scope ${name} does not exist`);
      if (!currentDefaultScopes.some((candidate) => candidate.id === scope.id)) {
        await requestJson(
          fetchImpl,
          `${realmUrl}/clients/${clientId}/default-client-scopes/${scope.id}`,
          { method: "PUT", headers },
          [204],
        );
      }
    }
    await reconcileCodexOfflineAccess({ realmUrl, client: { clientId: client.clientId, optionalClientScopes }, clientId, scopes: existingScopes, headers, fetchImpl });
  }

  const userProfileUrl = `${realmUrl}/users/profile`;
  const userProfile = await requestJson(fetchImpl, userProfileUrl, { headers });
  userProfile.attributes ??= [];
  const tenantAttribute = userProfile.attributes.find(
    (attribute) => attribute.name === "genioone_tenant_id",
  );
  const desiredTenantAttribute = {
    name: "genioone_tenant_id",
    displayName: "GenioOne Tenant ID",
    validations: { length: { min: 1, max: 255 } },
    permissions: { view: ["admin", "user"], edit: ["admin"] },
    multivalued: false,
  };
  if (tenantAttribute) Object.assign(tenantAttribute, desiredTenantAttribute);
  else userProfile.attributes.push(desiredTenantAttribute);
  await requestJson(
    fetchImpl,
    userProfileUrl,
    { method: "PUT", headers, body: JSON.stringify(userProfile) },
    [200, 204],
  );

  await reconcileKeycloakUsers({ realmUrl, users: desired.users, headers, fetchImpl });
  const discovery = await requestJson(
    fetchImpl,
    `${origin}/realms/${encodeURIComponent(desired.realm)}/.well-known/openid-configuration`,
  );
  const clients = {};
  for (const desiredClient of desired.clients ?? []) {
    const [client] = await requestJson(
      fetchImpl,
      `${realmUrl}/clients?clientId=${encodeURIComponent(desiredClient.clientId)}`,
      { headers },
    );
    const mappers = await requestJson(
      fetchImpl,
      `${realmUrl}/clients/${client.id}/protocol-mappers/models`,
      { headers },
    );
    const scopes = await requestJson(
      fetchImpl,
      `${realmUrl}/clients/${client.id}/default-client-scopes`,
      { headers },
    );
    clients[desiredClient.clientId] = {
      mappers: mappers.map((mapper) => mapper.name).sort(),
      default_scopes: scopes.map((scope) => scope.name).sort(),
    };
  }
  const users = {};
  for (const desiredUser of desired.users ?? []) {
    const [summary] = await requestJson(
      fetchImpl,
      `${realmUrl}/users?username=${encodeURIComponent(desiredUser.username)}&exact=true`,
      { headers },
    );
    const user = await requestJson(fetchImpl, `${realmUrl}/users/${summary.id}`, { headers });
    users[desiredUser.username] = {
      subject_id: user.id,
      attributes: user.attributes ?? {},
    };
  }
  return { provider: "keycloak", realm: desired.realm, issuer: discovery.issuer, clients, users };
}

async function clickhouseReconcile(environment, fetchImpl = fetch) {
  const origin = environment.GENIO_ONE_CLICKHOUSE_HTTP_ORIGIN
    ?? `http://127.0.0.1:${required(environment, "GENIO_ONE_CLICKHOUSE_HTTP_PORT")}`;
  const database = required(environment, "GENIO_ONE_CLICKHOUSE_DB");
  const authorization = `Basic ${Buffer.from(
    `${required(environment, "GENIO_ONE_CLICKHOUSE_USER")}:${required(environment, "GENIO_ONE_CLICKHOUSE_PASSWORD")}`,
  ).toString("base64")}`;
  const query = `CREATE DATABASE IF NOT EXISTS \`${database.replaceAll("`", "``")}\``;
  await requestJson(
    fetchImpl,
    `${origin}/?query=${encodeURIComponent(query)}`,
    { method: "POST", headers: { authorization } },
    [200],
  );
  return { provider: "clickhouse", database };
}

function graviteeRevision(environment) {
  const material = JSON.stringify({
    cross_id: environment.GENIO_ONE_GRAVITEE_API_CROSS_ID,
    name: environment.GENIO_ONE_GRAVITEE_API_NAME,
    context_path: environment.GENIO_ONE_GRAVITEE_API_CONTEXT_PATH,
    upstream_url: environment.GENIO_ONE_GRAVITEE_API_UPSTREAM_URL,
  });
  return `post-install-${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

async function waitForGraviteeManagement(environment, fetchImpl = fetch) {
  const origin = required(environment, "GENIO_ONE_GRAVITEE_MANAGEMENT_API_ORIGIN");
  const organization = required(environment, "GENIO_ONE_GRAVITEE_ORGANIZATION");
  const providerEnvironment = required(environment, "GENIO_ONE_GRAVITEE_ENVIRONMENT");
  const authorization = `Basic ${Buffer.from(
    `${required(environment, "GENIO_ONE_GRAVITEE_ADMIN_USERNAME")}:${required(environment, "GENIO_ONE_GRAVITEE_ADMIN_PASSWORD")}`,
  ).toString("base64")}`;
  const url = `${origin}/management/v2/organizations/${encodeURIComponent(organization)}/environments/${encodeURIComponent(providerEnvironment)}/apis`;
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, { headers: { authorization } });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Gravitee Management API did not become ready: ${lastError}`);
}

async function waitForPlatform(environment, fetchImpl = fetch) {
  const origin = required(environment, "GENIO_ONE_PLATFORM_ORIGIN").replace(/\/$/, "");
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${origin}/healthz`);
      if (response.ok) return { origin, state: "READY" };
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`TypeScript Platform API did not become ready: ${lastError}`);
}

function graviteeCollection(value, label) {
  const items = Array.isArray(value) ? value : value?.data;
  if (!Array.isArray(items)) throw new Error(`${label} response has no data array`);
  return items;
}

async function graviteeReconcile(environment, fetchImpl = fetch) {
  await waitForGraviteeManagement(environment, fetchImpl);
  const origin = required(environment, "GENIO_ONE_GRAVITEE_MANAGEMENT_API_ORIGIN").replace(/\/$/, "");
  const organization = required(environment, "GENIO_ONE_GRAVITEE_ORGANIZATION");
  const providerEnvironment = required(environment, "GENIO_ONE_GRAVITEE_ENVIRONMENT");
  const authorization = `Basic ${Buffer.from(
    `${required(environment, "GENIO_ONE_GRAVITEE_ADMIN_USERNAME")}:${required(environment, "GENIO_ONE_GRAVITEE_ADMIN_PASSWORD")}`,
  ).toString("base64")}`;
  const headers = { authorization, "content-type": "application/json" };
  const collectionUrl = `${origin}/management/v2/organizations/${encodeURIComponent(organization)}/environments/${encodeURIComponent(providerEnvironment)}/apis`;
  const crossId = required(environment, "GENIO_ONE_GRAVITEE_API_CROSS_ID");
  const configRevision = graviteeRevision(environment);
  const desired = {
    name: required(environment, "GENIO_ONE_GRAVITEE_API_NAME"),
    apiVersion: configRevision,
    definitionVersion: "V4",
    type: "PROXY",
    description: `Managed by GenioOne Gateway Runtime\ngenioone.provider-cross-id=${crossId}`,
    crossId,
    flows: [],
    listeners: [{
      type: "HTTP",
      paths: [{ path: required(environment, "GENIO_ONE_GRAVITEE_API_CONTEXT_PATH") }],
      entrypoints: [{ type: "http-proxy" }],
    }],
    endpointGroups: [{
      name: "default-group",
      type: "http-proxy",
      endpoints: [{
        name: "default",
        type: "http-proxy",
        weight: 1,
        inheritConfiguration: false,
        configuration: { target: required(environment, "GENIO_ONE_GRAVITEE_API_UPSTREAM_URL") },
      }],
    }],
  };
  const listed = graviteeCollection(
    await requestJson(fetchImpl, `${collectionUrl}?page=1&perPage=100`, { headers }),
    "Gravitee APIs",
  );
  const matches = listed.filter((api) =>
    api.crossId === crossId || api.description === desired.description
  );
  if (matches.length > 1) throw new Error(`Gravitee returned duplicate API identity ${crossId}`);
  let api;
  let changed = true;
  if (matches.length === 0) {
    api = await requestJson(fetchImpl, collectionUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(desired),
    }, [201]);
  } else {
    api = matches[0];
    changed = api.apiVersion !== configRevision;
    if (changed) {
      api = await requestJson(fetchImpl, `${collectionUrl}/${encodeURIComponent(api.id)}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...api, ...desired, id: api.id }),
      }, [200]);
    }
  }
  const apiUrl = `${collectionUrl}/${encodeURIComponent(api.id)}`;
  const plans = graviteeCollection(
    await requestJson(fetchImpl, `${apiUrl}/plans?page=1&perPage=100`, { headers }),
    "Gravitee plans",
  );
  let plan = plans.find((candidate) =>
    candidate.status !== "CLOSED" && candidate.security?.type === "KEY_LESS"
  );
  if (!plan) {
    plan = await requestJson(fetchImpl, `${apiUrl}/plans`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        definitionVersion: "V4",
        name: "GenioOne Keyless",
        description: "GenioOne governed keyless consumer access",
        characteristics: [],
        validation: "AUTO",
        security: { type: "KEY_LESS" },
        mode: "STANDARD",
      }),
    }, [201]);
  }
  if (plan.status !== "PUBLISHED") {
    await requestJson(fetchImpl, `${apiUrl}/plans/${encodeURIComponent(plan.id)}/_publish`, {
      method: "POST",
      headers,
    }, [200]);
  }
  if (api.state !== "STARTED") {
    await requestJson(fetchImpl, `${apiUrl}/_start`, { method: "POST", headers }, [204]);
  } else if (changed) {
    await requestJson(fetchImpl, `${apiUrl}/deployments`, { method: "POST", headers }, [202]);
  }
  return { provider: "gravitee", api_id: api.id, cross_id: crossId, revision: configRevision };
}

export async function runPostInstall({
  environment,
  exec = runCommand,
  fetchImpl = fetch,
  prepareAiMcpGateway,
}) {
  environment = { ...environment };
  if (
    !environment.GENIO_ONE_GRAVITEE_MANAGEMENT_API_ORIGIN &&
    environment.GENIO_ONE_GRAVITEE_MANAGEMENT_API_PORT
  ) {
    environment.GENIO_ONE_GRAVITEE_MANAGEMENT_API_ORIGIN =
      `http://127.0.0.1:${environment.GENIO_ONE_GRAVITEE_MANAGEMENT_API_PORT}`;
  }
  environment.GENIO_ONE_GRAVITEE_API_CROSS_ID ??= "genio-one-traditional-api";
  environment.GENIO_ONE_GRAVITEE_API_NAME ??= "GenioOne Traditional API";
  const deployables = new Set(
    (environment.GENIO_ONE_DEPLOYMENT_DEPLOYABLES ?? "genio-one-platform,genio-gateway")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const capabilities = new Set(
    (environment.GENIO_ONE_DEPLOYMENT_CAPABILITIES ?? "identity,api-management,analytics")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (deployables.has("genio-gateway") && capabilities.has("identity")) {
    environment.GENIO_ONE_GATEWAY_BOOTSTRAP_FILE = resolve(
      appRoot,
      required(environment, "GENIO_ONE_GATEWAY_BOOTSTRAP_FILE"),
    );
  }
  const steps = [];
  if (deployables.has("genio-one-platform")) {
    steps.push({
      id: "platform.typescript-api-ready",
      version: "1",
      run: () => waitForPlatform(environment, fetchImpl),
    });
  }
  if (deployables.has("genio-gateway") && capabilities.has("identity")) {
    steps.push({
      id: "gateway.keycloak-admin-api",
      version: environment.GENIO_ONE_KEYCLOAK_CONFIG_REVISION ?? "keycloak-v2",
      run: () => keycloakReconcile(environment, fetchImpl),
    });
    if (environment.GENIO_ONE_GATEWAY_RUNTIME_IDS) {
      steps.push({
        id: "gateway.platform-api-registration",
        version: "1",
        run: () => provisionGatewayRuntimeBootstraps({ environment, fetchImpl, exec }),
      });
    }
  }
  if (deployables.has("genio-one-platform") && capabilities.has("analytics")) {
    steps.push({ id: "platform.clickhouse-http-sql", version: "1", run: () => clickhouseReconcile(environment, fetchImpl) });
  }
  if (deployables.has("genio-gateway") && capabilities.has("api-management")) {
    steps.push({
      id: "gateway.gravitee-management-api",
      version: "1",
      run: async () => {
        await waitForGraviteeManagement(environment, fetchImpl);
        return graviteeReconcile(environment, fetchImpl);
      },
    });
  }
  return runVersionedSteps({
    journalPath:
      environment.GENIO_ONE_POST_INSTALL_STATE ??
      resolve(workspaceRoot, "target/genio-one/deployment/post-install-state.json"),
    steps,
    failStep: environment.GENIO_ONE_POST_INSTALL_FAIL_STEP,
  });
}

async function main() {
  const fileEnvironment = await loadEnvironment();
  const environment = { ...fileEnvironment, ...process.env };
  const journal = await runPostInstall({ environment });
  console.log(
    JSON.stringify({ ok: true, release: journal.release, runs: journal.runs, steps: journal.steps }, null, 2),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
