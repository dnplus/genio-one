import { generateKeyPairSync, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
export const defaultOutput = resolve(root, ".local/ce-helm/secrets.yaml")

export function parseArgs(argv) {
  let output = defaultOutput
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== "--out") throw new Error(`unknown option: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) throw new Error("--out requires a path")
    if (output !== defaultOutput) throw new Error("--out may only be supplied once")
    output = resolve(value)
    index += 1
  }
  return { output }
}

function randomSecret(bytes = 24) {
  return randomBytes(bytes).toString("hex")
}

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  return {
    privateKeyPem: String(privateKey.export({ type: "pkcs8", format: "pem" })),
    publicKeyPem: String(publicKey.export({ type: "spki", format: "pem" })),
  }
}

function keySet(keyId, publicKeyPem) {
  return JSON.stringify({ schema_version: 1, keys: [{ key_id: keyId, public_key_pem: publicKeyPem }] })
}

function literal(name, value) {
  return `  ${name}: |-\n${value.split("\n").filter(Boolean).map((line) => `    ${line}`).join("\n")}\n`
}

export function generateSecretValues() {
  const postgresPassword = randomSecret()
  const projection = keyPair()
  const runtimeCommand = keyPair()
  const policyArtifact = keyPair()
  const releaseRoot = keyPair()
  const botRuntimeReport = keyPair()
  const values = {
    postgresPassword,
    valkeyPassword: randomSecret(),
    tokenVaultKey: randomBytes(32).toString("base64"),
    mcpOAuthEncryptionKey: randomBytes(32).toString("base64"),
    keycloakDatabasePassword: randomSecret(),
    keycloakAdminPassword: randomSecret(),
    tenantAdministratorPassword: randomSecret(),
    productApiClientSecret: randomSecret(),
    egressAttributionKey: randomSecret(32),
    // Keep these values while the shared chart supports its EE API-management profile.
    // They are unused when apiManagement.enabled is false.
    graviteeDatabasePassword: randomSecret(),
    graviteeAdminPassword: randomSecret(),
    graviteeJwtSecret: randomSecret(32),
    clickhousePassword: randomSecret(),
    authorizationReceiptKey: randomSecret(32),
  }
  const literals = {
    projectionSigningPrivateKeyPem: projection.privateKeyPem,
    runtimeCommandSigningPrivateKeyPem: runtimeCommand.privateKeyPem,
    runtimeCommandVerificationKeysJson: keySet("runtime-command-key-1", runtimeCommand.publicKeyPem),
    policyArtifactSigningPrivateKeyPem: policyArtifact.privateKeyPem,
    releaseRootSigningPrivateKeyPem: releaseRoot.privateKeyPem,
    releaseRootVerificationKeysJson: keySet("release-root-key-1", releaseRoot.publicKeyPem),
    enforcementPrivateKeyPem: policyArtifact.privateKeyPem,
    enforcementVerificationKeysJson: keySet("policy-artifact-key-1", policyArtifact.publicKeyPem),
    downstreamCredentialsJson: JSON.stringify({ schema_version: 1, credentials: [] }),
    archifyConnectorBearerToken: randomSecret(32),
    botRuntimeReportPrivateKeyPem: botRuntimeReport.privateKeyPem,
    botRuntimeReportPublicKeyPem: botRuntimeReport.publicKeyPem,
  }
  return {
    values,
    literals,
    runtimeReport: { generatedKeyId: "genio-one-bot-runtime-v1" },
  }
}

export function renderSecretValues() {
  const { values, literals, runtimeReport } = generateSecretValues()
  return [
    "# Generated for one CE Helm installation. Keep private; do not commit or rotate in place.",
    "runtimeReport:",
    `  generatedKeyId: ${JSON.stringify(runtimeReport.generatedKeyId)}`,
    "secrets:",
    ...Object.entries(values).map(([name, value]) => `  ${name}: ${JSON.stringify(value)}`),
    ...Object.entries(literals).map(([name, value]) => literal(name, value).trimEnd()),
    "",
  ].join("\n")
}

export function writeSecretValues(output) {
  if (existsSync(output)) throw new Error(`refusing to overwrite existing secret values file: ${output}`)
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
  writeFileSync(output, renderSecretValues(), { encoding: "utf8", mode: 0o600, flag: "wx" })
  chmodSync(output, 0o600)
}

function main() {
  const { output } = parseArgs(process.argv.slice(2))
  writeSecretValues(output)
  process.stderr.write(`Generated private Helm values file: ${output}\n`)
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
