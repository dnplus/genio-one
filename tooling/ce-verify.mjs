import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))

async function lstatOrNull(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function assertRealDirectory(path, label) {
  const stat = await lstatOrNull(path)
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`)
  }
}

export async function verifyLocalCeState(outDir) {
  const destination = resolve(outDir)
  const statePath = resolve(destination, ".genioone-ce-sync-state.json")
  const state = JSON.parse(await readFile(statePath, "utf8"))
  if (state?.schema !== 2 || typeof state.files !== "object" || state.files === null || Array.isArray(state.files)) {
    throw new Error("CE sync state has an unsupported schema")
  }
  for (const [path, record] of Object.entries(state.files)) {
    const absolute = resolve(destination, path)
    const relativePath = relative(destination, absolute)
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      throw new Error(`CE sync state path escapes the checkout: ${path}`)
    }
    let current = destination
    for (const segment of relativePath.split(sep)) {
      current = resolve(current, segment)
      const component = await lstatOrNull(current)
      if (component?.isSymbolicLink()) throw new Error(`managed CE path contains a symlink: ${path}`)
    }
    if (typeof record !== "object" || record === null || typeof record.sha256 !== "string" || typeof record.mode !== "number") {
      throw new Error(`CE sync state has an invalid record for ${path}`)
    }
    const stat = await lstatOrNull(absolute)
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`managed CE file is missing or not regular: ${path}`)
    const digest = createHash("sha256").update(await readFile(absolute)).digest("hex")
    if (digest !== record.sha256 || (stat.mode & 0o777) !== record.mode) {
      throw new Error(`managed CE file differs from sync state: ${path}`)
    }
  }
}

async function runLocalCeState(outDir, label) {
  process.stdout.write(`\nCE verification: ${label}\n`)
  const started = Date.now()
  await verifyLocalCeState(outDir)
  return { step: label, status: "PASS", duration_ms: Date.now() - started }
}

export async function saveVerificationReceipt(outDir, receipt) {
  const destination = resolve(outDir)
  const localDir = resolve(destination, ".local")
  const receiptPath = resolve(localDir, "ce-verification.json")
  if (!receiptPath.startsWith(`${localDir}/`)) throw new Error("receipt path escapes .local")
  await assertRealDirectory(destination, "CE output directory")
  try {
    await mkdir(localDir)
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
  }
  await assertRealDirectory(localDir, "CE .local directory")
  const existing = await lstatOrNull(receiptPath)
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`CE verification receipt must be a regular file: ${receiptPath}`)
  }

  const temporaryPath = resolve(localDir, `.ce-verification-${process.pid}-${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporaryPath, "wx", 0o600)
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    // rename replaces a regular receipt atomically; it replaces a raced symlink
    // itself rather than following it, so it cannot write outside .local.
    await rename(temporaryPath, receiptPath)
  } finally {
    await handle?.close()
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error
    })
  }
  return receiptPath
}

function argumentsFor(argv) {
  const options = { outDir: resolve(root, "../genioone-ce"), sourceRef: "HEAD", containers: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--") continue
    if (argument === "--containers") options.containers = true
    else if (argument === "--out" || argument === "--source-ref") {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`)
      if (argument === "--out") options.outDir = resolve(value)
      else options.sourceRef = value
    } else throw new Error(`Unknown option ${argument}; use [--out PATH] [--source-ref REF] [--containers]`)
  }
  return options
}

async function run(command, args, cwd, label) {
  process.stdout.write(`\nCE verification: ${label}\n`)
  const started = Date.now()
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit" })
    child.once("error", rejectRun)
    child.once("exit", (code, signal) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`${label} failed (${signal ? `signal ${signal}` : `exit ${code}`})`)))
  })
  return { step: label, status: "PASS", duration_ms: Date.now() - started }
}

async function main() {
  const options = argumentsFor(process.argv.slice(2))
  const steps = []
  if (resolve(options.outDir) === root) {
    steps.push(await runLocalCeState(options.outDir, "CE matches its exported sync state"))
  } else {
    steps.push(await run(process.execPath, [
      resolve(root, "tooling/oss-export.mjs"), "--check", "--out", options.outDir,
      "--source-ref", options.sourceRef,
    ], root, "CE matches the selected source revision"))
  }
  const pkg = JSON.parse(await readFile(resolve(options.outDir, "package.json"), "utf8"))
  const requiredPnpm = pkg.packageManager?.match(/^pnpm@([^+]+)(?:\+.*)?$/)?.[1]
  if (!requiredPnpm) throw new Error("CE package.json must pin pnpm through packageManager")
  const pnpmVersion = await new Promise((resolveVersion, rejectVersion) => {
    const child = spawn("pnpm", ["--version"], { cwd: options.outDir, stdio: ["ignore", "pipe", "inherit"] })
    let output = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk })
    child.once("error", rejectVersion)
    child.once("exit", (code) => code === 0 ? resolveVersion(output.trim()) : rejectVersion(new Error("pnpm is unavailable")))
  })
  if (pnpmVersion !== requiredPnpm) throw new Error(`Use pnpm ${requiredPnpm}; found ${pnpmVersion}`)
  const receipt = {
    schema_version: 1,
    scope: options.containers ? "source-checks-and-container-builds" : "source-checks",
    source_state_sha256: createHash("sha256")
      .update(await readFile(resolve(options.outDir, ".genioone-ce-sync-state.json")))
      .digest("hex"),
    started_at: new Date().toISOString(),
    status: "RUNNING",
    steps,
  }
  let receiptPath
  const save = async () => {
    receiptPath = await saveVerificationReceipt(options.outDir, receipt)
  }
  await save()
  try {
    for (const [label, args] of [
      ["Frozen dependency installation", ["install", "--frozen-lockfile"]],
      ["Type checks", ["check"]],
      ["CE test suite", ["test"]],
      ["Source builds", ["build"]],
    ]) {
      steps.push(await run("pnpm", args, options.outDir, label))
      await save()
    }
    if (options.containers) {
      for (const [name, dockerfile] of [
        ["platform", "apps/platform/platform-api/Dockerfile"],
        ["bot", "apps/bot/Dockerfile"],
        ["archify", "apps/connectors/archify/Dockerfile"],
        ["gateway", "runtimes/gateway/controller/Dockerfile"],
        ["gateway-services", "runtimes/gateway/services/Dockerfile"],
      ]) {
        steps.push(await run("docker", [
          "build", "--file", dockerfile, "--tag", `genioone-ce-verify-${name}:local`, ".",
        ], options.outDir, `${name} container build`))
        await save()
      }
    }
    // Installation may normalize a lockfile or a generator may rewrite source;
    // keep that drift visible instead of reporting a verified sync prematurely.
    if (resolve(options.outDir) === root) {
      steps.push(await runLocalCeState(options.outDir, "Builds leave the managed CE source unchanged"))
    } else {
      steps.push(await run(process.execPath, [
        resolve(root, "tooling/oss-export.mjs"), "--check", "--out", options.outDir,
        "--source-ref", options.sourceRef,
      ], root, "Builds leave the managed CE source unchanged"))
    }
    receipt.status = "PASS"
  } catch (error) {
    receipt.status = "FAIL"
    receipt.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    receipt.finished_at = new Date().toISOString()
    await save()
  }
  process.stdout.write(`\nCE ${receipt.scope} verified. Receipt: ${receiptPath}\n`)
  process.stdout.write("Runtime readiness and product journeys require a separate live acceptance run.\n")
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`CE verification failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
