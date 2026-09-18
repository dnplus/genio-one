#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
export const images = [
  ["genio-one-platform-ts", "0.1.0-dev.1", "apps/platform/platform-api/Dockerfile"],
  ["genio-one-bot", "0.1.0-dev.1", "apps/bot/Dockerfile"],
  ["genio-one-archify", "0.1.0-dev.1", "apps/connectors/archify/Dockerfile"],
  ["genio-one-gateway", "0.1.0-dev.8", "runtimes/gateway/controller/Dockerfile"],
  ["genio-one-gateway-policy", "0.1.0-dev.1", "runtimes/gateway/services/Dockerfile"],
  ["genio-one-installer", "0.1.0-dev.1", "apps/platform/installer/Dockerfile"],
]

export function buildPlan(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (["--push", "--dry-run"].includes(flag)) options[flag.slice(2)] = true
    else if (["--registry", "--tag", "--load-kind"].includes(flag)) {
      const value = argv[++index]
      if (!value || value.startsWith("-") || /\s/.test(value)) throw new Error(`Invalid ${flag}`)
      options[flag.slice(2)] = value
    } else throw new Error(`Unknown option ${flag}`)
  }
  if (options.registry && !/^[a-z0-9][a-z0-9.:/-]*[a-z0-9]$/.test(options.registry)) throw new Error("Registry must be a registry/namespace without a URL scheme or credentials")
  if (options.tag && !/^[\w][\w.-]{0,127}$/.test(options.tag)) throw new Error("Invalid image tag")
  if (options["load-kind"] && !/^[a-z0-9][a-z0-9-]*$/.test(options["load-kind"])) throw new Error("Invalid Kind cluster name")
  if (options.push && !options.registry) throw new Error("--push requires an explicit --registry")
  const tagged = images.map(([name, tag, dockerfile]) => ({ name, dockerfile, image: `${options.registry ? `${options.registry}/` : ""}${name}:${options.tag ?? tag}` }))
  const commands = tagged.map(({ image, dockerfile }) => ["docker", "build", "--file", dockerfile, "--tag", image, "."])
  if (options["load-kind"]) commands.push(["kind", "load", "docker-image", "--name", options["load-kind"], ...tagged.map(({ image }) => image)])
  if (options.push) commands.push(...tagged.map(({ image }) => ["docker", "push", image]))
  return { options, images: tagged, commands }
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    console.log("Build the six CE Helm images from this checkout.\nUsage: node tooling/ce-build-images.mjs [--registry REGISTRY/NAMESPACE] [--tag TAG] [--load-kind CLUSTER] [--push] [--dry-run]\nImages stay local unless --push is explicitly supplied. With --registry/--tag, use the same repositories/tags in Helm values.")
    return
  }
  const plan = buildPlan(argv)
  if (plan.options["dry-run"]) { console.log(JSON.stringify(plan, null, 2)); return }
  for (const [command, ...args] of plan.commands) {
    console.log(`Running: ${command} ${args.join(" ")}`)
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit" })
    if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.signal ?? result.status}`)
  }
  console.log(JSON.stringify({ status: "PASS", images: plan.images.map(({ image }) => image) }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
