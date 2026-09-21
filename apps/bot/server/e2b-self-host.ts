import type { ConnectionOpts } from "@e2b/desktop"
import botPackage from "../package.json" with { type: "json" }

const configuredPackageVersion = botPackage.devDependencies?.["@openai/codex"]

if (typeof configuredPackageVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(configuredPackageVersion)) {
  throw new Error("GENIO_BOT_CODEX_PACKAGE_VERSION_INVALID")
}

export const DEFAULT_CODEX_VERSION = configuredPackageVersion

export interface SelfHostedE2BConfiguration {
  connection: ConnectionOpts
  desktopBaseTemplate: string
  desktopTemplate: string
  headlessTemplate: string
  codexVersion: string
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name}_REQUIRED`)
  return value
}

function requiredWithFallback(environment: NodeJS.ProcessEnv, name: string, fallbackName: string) {
  const value = environment[name]?.trim() || environment[fallbackName]?.trim()
  if (!value) throw new Error(`${name}_REQUIRED`)
  return value
}

function optionalUrl(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim()
  if (!value) return undefined
  const url = new URL(value)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name}_INVALID`)
  }
  const hostname = url.hostname.toLowerCase()
  if (hostname === "e2b.app" || hostname.endsWith(".e2b.app")) {
    throw new Error("PUBLIC_E2B_URL_NOT_ALLOWED")
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name}_INVALID`)
  }
  return url.toString().replace(/\/$/, "")
}

export function selfHostedE2BConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): SelfHostedE2BConfiguration {
  const domain = required(environment, "E2B_DOMAIN")
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(domain)) throw new Error("E2B_DOMAIN_INVALID")
  const hostname = domain.split(":", 1)[0]!.toLowerCase()
  if (hostname === "e2b.app" || hostname.endsWith(".e2b.app")) {
    throw new Error("PUBLIC_E2B_DOMAIN_NOT_ALLOWED")
  }
  const apiKey = required(environment, "E2B_API_KEY")
  const codexVersion = environment.GENIO_BOT_CODEX_VERSION?.trim() || DEFAULT_CODEX_VERSION
  if (!/^\d+\.\d+\.\d+$/.test(codexVersion)) {
    throw new Error("GENIO_BOT_CODEX_VERSION_INVALID")
  }
  const requestTimeoutMs = Number(environment.GENIO_BOT_E2B_REQUEST_TIMEOUT_MS?.trim() || "120000")
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000) {
    throw new Error("GENIO_BOT_E2B_REQUEST_TIMEOUT_MS_INVALID")
  }
  const desktopTemplate = requiredWithFallback(
    environment,
    "GENIO_BOT_E2B_DESKTOP_TEMPLATE",
    "GENIO_BOT_E2B_TEMPLATE",
  )
  const headlessTemplate = requiredWithFallback(
    environment,
    "GENIO_BOT_E2B_HEADLESS_TEMPLATE",
    "GENIO_BOT_E2B_TEMPLATE",
  )
  return {
    connection: {
      domain,
      apiKey,
      apiUrl: optionalUrl(environment, "E2B_API_URL"),
      sandboxUrl: optionalUrl(environment, "E2B_SANDBOX_URL"),
      requestTimeoutMs,
    },
    desktopBaseTemplate: required(environment, "GENIO_BOT_E2B_DESKTOP_BASE_TEMPLATE"),
    desktopTemplate,
    headlessTemplate,
    codexVersion,
  }
}
