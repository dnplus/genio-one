import { copyFile, mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

const appRoot = resolve(import.meta.dirname, "..")
const outputRoot = resolve(appRoot, "../../runtimes/gateway/services/dist")

await rm(outputRoot, { recursive: true, force: true })
await mkdir(resolve(outputRoot, "proto"), { recursive: true })

for (const [name, entrypoint] of [
  ["authorizer", "../../runtimes/gateway/services/authorizer/server.ts"],
  ["processor", "../../runtimes/gateway/services/processor/server.ts"],
]) {
  const result = await Bun.build({
    entrypoints: [resolve(appRoot, entrypoint)],
    outdir: outputRoot,
    naming: `${name}.js`,
    target: "bun",
    minify: false,
    sourcemap: "external",
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`failed to build ${name}`)
  }
}

await copyFile(
  resolve(
    appRoot,
    "../../runtimes/gateway/services/authorizer/proto/external_auth_minimal.proto",
  ),
  resolve(outputRoot, "proto/external_auth_minimal.proto"),
)

await copyFile(
  resolve(
    appRoot,
    "../../runtimes/gateway/services/processor/proto/external_processor_minimal.proto",
  ),
  resolve(outputRoot, "proto/external_processor_minimal.proto"),
)
