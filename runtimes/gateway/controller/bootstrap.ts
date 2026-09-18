import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
  parseGatewayBootstrapConfiguration,
  type GatewayBootstrapConfiguration,
} from "../services/shared/gateway-bootstrap"

export interface MaterializedGatewayBootstrap {
  bootstrap: GatewayBootstrapConfiguration
  clientIdFile: string
  clientSecretFile: string
  commandKeyRingPath: string
  releaseRootKeyRingPath: string
  reportPrivateKeyPath: string
}

function httpUrl(value: string, label: string): string {
  const url = new URL(value)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials, query, or fragment`)
  }
  return url.toString().replace(/\/$/, "")
}

function assertConsistent(bootstrap: GatewayBootstrapConfiguration): void {
  if (
    bootstrap.registration.tenant_id !== bootstrap.tenant_id ||
    bootstrap.registration.runtime_id !== bootstrap.runtime_id ||
    bootstrap.registration.gateway_id !== bootstrap.gateway_id ||
    bootstrap.registration.identity_client_id !== bootstrap.oidc.client_id
  ) {
    throw new Error("Gateway bootstrap identity is inconsistent")
  }
  if (bootstrap.registration.state !== "ACTIVE") {
    throw new Error("Gateway bootstrap registration must be ACTIVE")
  }
  if (bootstrap.report_signing.key_id !== `${bootstrap.runtime_id}-report`) {
    throw new Error("Gateway bootstrap report key does not match Runtime identity")
  }
  httpUrl(bootstrap.platform_origin, "Gateway bootstrap Platform origin")
  httpUrl(bootstrap.oidc.issuer, "Gateway bootstrap OIDC issuer")
  httpUrl(bootstrap.oidc.token_endpoint, "Gateway bootstrap OIDC token endpoint")
}

async function writePrivateFile(path: string, value: string): Promise<void> {
  const temporary = `${path}.candidate-${randomUUID()}`
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600)
}

export async function materializeGatewayBootstrap(input: {
  path: string
  stateRoot: string
}): Promise<MaterializedGatewayBootstrap> {
  const raw = JSON.parse(await readFile(input.path, "utf8")) as unknown
  const bootstrap = parseGatewayBootstrapConfiguration(raw)
  assertConsistent(bootstrap)
  const directory = resolve(input.stateRoot, "bootstrap")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const clientIdFile = resolve(directory, "oidc-client-id")
  const clientSecretFile = resolve(directory, "oidc-client-secret")
  const commandKeyRingPath = resolve(directory, "runtime-command-verification-keys.json")
  const releaseRootKeyRingPath = resolve(directory, "policy-release-root-keys.json")
  const reportPrivateKeyPath = resolve(directory, "report-private-key.pem")
  await Promise.all([
    writePrivateFile(clientIdFile, `${bootstrap.oidc.client_id}\n`),
    writePrivateFile(clientSecretFile, `${bootstrap.oidc.client_secret}\n`),
    writePrivateFile(commandKeyRingPath, `${JSON.stringify(bootstrap.runtime_command_verification_keys)}\n`),
    writePrivateFile(releaseRootKeyRingPath, `${JSON.stringify(bootstrap.policy_release_root_keys)}\n`),
    writePrivateFile(reportPrivateKeyPath, bootstrap.report_signing.private_key_pem),
  ])
  return {
    bootstrap,
    clientIdFile,
    clientSecretFile,
    commandKeyRingPath,
    releaseRootKeyRingPath,
    reportPrivateKeyPath,
  }
}
