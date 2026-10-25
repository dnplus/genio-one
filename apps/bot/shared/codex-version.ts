import botPackage from "../package.json" with { type: "json" }

const configuredPackageVersion = botPackage.devDependencies?.["@openai/codex"]

if (typeof configuredPackageVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(configuredPackageVersion)) {
  throw new Error("GENIO_BOT_CODEX_PACKAGE_VERSION_INVALID")
}

export const CODEX_VERSION: string = configuredPackageVersion
