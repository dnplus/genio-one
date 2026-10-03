import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { portIsOccupied } from "../runtimes/gateway/controller/local-port-owner.mjs"

const project = "genio-one-dev"
const requiredServices = ["postgres", "valkey", "otel-collector", "otel-collector-analytics", "keycloak", "clickhouse"]
const labelPrefix = "com.docker.compose."

export function parseLocalDevArguments(args) {
  if (args.some((arg) => !["clean", "--reuse-support"].includes(arg)) || new Set(args).size !== args.length) {
    throw new Error("用法：pnpm dev [clean] [--reuse-support]")
  }
  return { clean: args.includes("clean"), reuseSupport: args.includes("--reuse-support") }
}

function failure(reason, details = {}) {
  const diagnostic = {
    event: "local-dev.support-refused",
    project,
    reason,
    ...details,
    next_action: "相容且已運行的共用支援服務可明確使用 --reuse-support；獨立安裝請使用自己的 VM／host 與 Docker daemon。缺少服務請由擁有 checkout 啟動。",
  }
  const error = new Error(JSON.stringify(diagnostic))
  error.diagnostic = diagnostic
  throw error
}

function capturedDocker(args, cwd) {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) failure("DOCKER_READ_FAILED", { operation: args[0] })
  return result.stdout
}

function parseJson(text, operation) {
  try { return JSON.parse(text) } catch { failure("DOCKER_RESPONSE_INVALID", { operation }) }
}

function environment(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match) return []
    let value = match[2]
    if (/^["']/.test(value)) value = value.slice(1, value.lastIndexOf(value[0]))
    else value = value.replace(/\s+#.*$/, "")
    return [[match[1], value]]
  }))
}

function owner(container) {
  const labels = container.Config?.Labels ?? {}
  const directory = labels[`${labelPrefix}project.working_dir`]
  const files = labels[`${labelPrefix}project.config_files`]?.split(",")
  return directory && files?.length === 1 && resolve(files[0]) === resolve(directory, "compose.yaml") ? resolve(directory) : null
}

function bindings(container) {
  return Object.entries(container.HostConfig?.PortBindings ?? {}).flatMap(([target, values]) =>
    (values ?? []).map((value) => `${value.HostIp || "0.0.0.0"}:${value.HostPort}:${target}`),
  ).sort()
}

function expectedBindings(service) {
  return (service.ports ?? []).map((port) => `${port.host_ip || "0.0.0.0"}:${port.published}:${port.target}/${port.protocol || "tcp"}`).sort()
}

function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right) }

function bindDigest(path, readFile) {
  try { return createHash("sha256").update(readFile(path)).digest("hex") } catch (error) {
    if (error.code !== "EISDIR") throw error
    return createHash("sha256").update(JSON.stringify(readdirSync(path).sort().map((name) => [name, bindDigest(resolve(path, name), readFile)]))).digest("hex")
  }
}

function volumeIdentity(volumes) {
  return volumes.map((volume) => ({ name: volume.Name, createdAt: volume.CreatedAt, project: volume.Labels?.[`${labelPrefix}project`], volume: volume.Labels?.[`${labelPrefix}volume`] })).sort((left, right) => left.name.localeCompare(right.name))
}

export function recordLocalSupportOwnership(plan, { docker = capturedDocker, writeFile = writeFileSync, mkdir = mkdirSync } = {}) {
  if (plan.shared) return
  const names = docker(["volume", "ls", "-q", "--filter", `label=${labelPrefix}project=${project}`], plan.platformDir).trim().split(/\s+/).filter(Boolean)
  const volumes = names.length ? parseJson(docker(["volume", "inspect", ...names], plan.platformDir), "volumes") : []
  mkdir(resolve(plan.platformDir, ".local"), { recursive: true })
  writeFile(resolve(plan.platformDir, ".local/support-ownership.json"), `${JSON.stringify({ project, owner: plan.platformDir, daemonId: plan.daemonId, volumes: volumeIdentity(volumes) })}\n`, { mode: 0o600 })
}

function validateSharedService(name, container, expected, config, volumes, readFile, image) {
  const mismatch = (field) => failure("SUPPORT_CONFIGURATION_MISMATCH", { service: name, field, owner: owner(container) })
  if (container.Config?.Image !== expected.image) mismatch("image")
  if (!equal(bindings(container), expectedBindings(expected))) mismatch("ports")
  const actualEnvironment = Object.fromEntries((container.Config?.Env ?? []).map((entry) => {
    const index = entry.indexOf("=")
    return [entry.slice(0, index), entry.slice(index + 1)]
  }))
  const expectedEnvironment = {
    ...Object.fromEntries((image.Config.Env ?? []).map((entry) => {
      const index = entry.indexOf("=")
      return [entry.slice(0, index), entry.slice(index + 1)]
    })),
    ...expected.environment,
  }
  if ((container.Config?.Env ?? []).length !== Object.keys(actualEnvironment).length) mismatch("environment.duplicates")
  for (const [key, value] of Object.entries(expectedEnvironment)) {
    if (actualEnvironment[key] !== String(value)) mismatch(`environment.${key}`)
  }
  if (Object.keys(actualEnvironment).some((key) => !Object.hasOwn(expectedEnvironment, key))) mismatch("environment.extra")
  for (const field of ["command", "entrypoint"]) {
    if (expected[field] && !equal(container.Config?.[field === "command" ? "Cmd" : "Entrypoint"], expected[field])) mismatch(field)
  }
  for (const [key, value] of Object.entries(expected.labels ?? {})) {
    if (container.Config?.Labels?.[key] !== String(value)) mismatch(`labels.${key}`)
  }
  if (!container.NetworkSettings?.Networks?.[`${project}_default`]) mismatch("network")
  for (const mount of expected.volumes ?? []) {
    const actual = container.Mounts?.find((item) => item.Destination === mount.target)
    if (!actual || actual.Type !== mount.type || actual.RW !== !mount.read_only) mismatch(`mount.${mount.target}`)
    if (mount.type === "volume") {
      const volumeName = config.volumes?.[mount.source]?.name
      if (actual.Name !== volumeName || !volumes.some((volume) => volume.Name === volumeName && volume.Labels?.[`${labelPrefix}project`] === project && volume.Labels?.[`${labelPrefix}volume`] === mount.source)) mismatch(`volume.${mount.source}`)
    } else if (mount.type === "bind") {
      try {
        if (bindDigest(actual.Source, readFile) !== bindDigest(mount.source, readFile)) mismatch(`bind.${mount.target}`)
      } catch (error) {
        if (error.diagnostic) throw error
        mismatch(`bind.${mount.target}`)
      }
    }
  }
  const expectedMounts = new Set((expected.volumes ?? []).map((mount) => mount.target))
  for (const actual of container.Mounts ?? []) {
    if (expectedMounts.has(actual.Destination)) continue
    if (!Object.hasOwn(image.Config.Volumes ?? {}, actual.Destination) || actual.Type !== "volume" || !actual.RW) mismatch(`mount.extra.${actual.Destination}`)
  }
  if (!container.State?.Running || (expected.healthcheck && container.State.Health?.Status !== "healthy")) {
    failure("SUPPORT_NOT_HEALTHY", { service: name, owner: owner(container) })
  }
}

function validateEndpoints(env, config) {
  const mismatch = (field) => failure("LOCAL_SUPPORT_SCOPE_MISMATCH", { field })
  const database = config.services.postgres.environment
  try {
    const url = new URL(env.GENIO_ONE_DATABASE_URL)
    if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "55432" || decodeURIComponent(url.pathname.slice(1)) !== database.POSTGRES_DB || decodeURIComponent(url.username) !== database.POSTGRES_USER || decodeURIComponent(url.password) !== database.POSTGRES_PASSWORD) mismatch("GENIO_ONE_DATABASE_URL")
  } catch (error) { if (error.diagnostic) throw error; mismatch("GENIO_ONE_DATABASE_URL") }
  if (env.GENIO_ONE_VALKEY_URL !== "redis://127.0.0.1:56379") mismatch("GENIO_ONE_VALKEY_URL")
  for (const key of ["GENIO_ONE_KEYCLOAK_ORIGIN", "GENIO_ONE_KEYCLOAK_ISSUER_ORIGIN"]) {
    if (env[key] !== "http://127.0.0.1:58080") mismatch(key)
  }
  if (env.GENIO_ONE_KEYCLOAK_REALM !== "genio-one") mismatch("GENIO_ONE_KEYCLOAK_REALM")
  const fixedPorts = { postgres: [55432], valkey: [56379], keycloak: [58080], clickhouse: [58123, 59000], "otel-collector": [54317, 54318, 53133], "otel-collector-analytics": [54319, 54320, 53134] }
  for (const [name, ports] of Object.entries(fixedPorts)) {
    if (!equal((config.services[name]?.ports ?? []).map((port) => Number(port.published)).sort(), ports.sort()) || config.services[name].ports.some((port) => port.host_ip !== "127.0.0.1")) mismatch(`${name}.ports`)
  }
}

export async function preflightLocalSupport({
  checkoutRoot,
  reuseSupport = false,
  clean = false,
  docker = capturedDocker,
  readFile = readFileSync,
  canonicalPath = realpathSync,
  occupied = portIsOccupied,
  fetchUrl = fetch,
  environmentOverrides = process.env,
} = {}) {
  const platformDir = resolve(checkoutRoot, "apps/platform")
  let env
  try { env = { ...environment(readFile(resolve(platformDir, ".env.local"), "utf8")), ...environmentOverrides } } catch { failure("LOCAL_ENV_REQUIRED") }
  const daemonId = docker(["info", "--format", "{{.ID}}"], platformDir).trim()
  if (!daemonId) failure("DOCKER_DAEMON_ID_UNAVAILABLE")
  const config = parseJson(docker(["compose", "--env-file", ".env.local", "--profile", "identity", "--profile", "analytics", "-f", "compose.yaml", "config", "--format", "json"], platformDir), "compose-config")
  if (config.name !== project) failure("LOCAL_PROJECT_MISMATCH")
  validateEndpoints(env, config)
  const ids = docker(["ps", "-aq"], platformDir).trim().split(/\s+/).filter(Boolean)
  const containers = ids.length ? parseJson(docker(["inspect", ...ids], platformDir), "containers") : []
  const names = docker(["volume", "ls", "-q"], platformDir).trim().split(/\s+/).filter(Boolean)
  const allVolumes = names.length ? parseJson(docker(["volume", "inspect", ...names], platformDir), "volumes") : []
  const expectedVolumes = Object.values(config.volumes ?? {}).map((volume) => volume.name)
  const volumes = allVolumes.filter((volume) => volume.Labels?.[`${labelPrefix}project`] === project || expectedVolumes.includes(volume.Name))
  const members = containers.filter((container) => container.Config?.Labels?.[`${labelPrefix}project`] === project)
  const expectedPorts = requiredServices.flatMap((name) => config.services[name].ports ?? []).map((port) => Number(port.published))
  for (const port of expectedPorts) {
    const reserved = containers.filter((container) => container.State?.Running && Object.values(container.HostConfig?.PortBindings ?? {}).some((values) => values?.some((value) => Number(value.HostPort) === port)))
    if (reserved.some((container) => !members.includes(container))) failure("SUPPORT_PORT_OWNED_BY_OTHER_PROJECT", { port, owners: reserved.map((container) => ({ project: container.Config?.Labels?.[`${labelPrefix}project`] ?? null, owner: owner(container) })) })
    if (await occupied(port) && reserved.length === 0) failure("SUPPORT_PORT_OWNER_UNKNOWN", { port })
  }
  const owners = [...new Set(members.map(owner))]
  const canonical = (path) => { try { return canonicalPath(path) } catch { return resolve(path) } }
  let own = members.length > 0 && owners.length === 1 && owners[0] !== null && canonical(owners[0]) === canonical(platformDir)
  if (members.length === 0 && volumes.length > 0) {
    let marker
    try { marker = JSON.parse(readFile(resolve(platformDir, ".local/support-ownership.json"), "utf8")) } catch {}
    own = marker?.project === project && marker.owner === platformDir && marker.daemonId === daemonId && equal(marker.volumes, volumeIdentity(volumes)) && volumes.every((volume) => Boolean(volume.CreatedAt))
    if (!own) failure("RETAINED_VOLUME_OWNER_UNKNOWN", { volumes: volumes.map((volume) => volume.Name) })
  }
  if (members.length > 0 && (!own && (!reuseSupport || owners.length !== 1 || owners[0] === null))) {
    failure("SUPPORT_OWNED_BY_OTHER_CHECKOUT", { owners })
  }
  if (volumes.some((volume) => volume.Labels?.[`${labelPrefix}project`] !== project || !volume.Labels?.[`${labelPrefix}volume`] || !volume.CreatedAt)) failure("SUPPORT_VOLUME_OWNER_UNKNOWN", { volumes: volumes.map((volume) => volume.Name) })
  const shared = members.length > 0 && !own
  if (clean && shared) failure("SHARED_SUPPORT_CLEAN_REFUSED", { owners })
  if (shared) {
    const verified = {}
    const images = new Map()
    for (const name of requiredServices) {
      const matches = members.filter((container) => container.Config.Labels[`${labelPrefix}service`] === name)
      if (matches.length !== 1) failure("SUPPORT_SERVICE_MISSING", { service: name, owners })
      const imageName = config.services[name].image
      if (!images.has(imageName)) {
        let image
        try { [image] = JSON.parse(docker(["image", "inspect", imageName], platformDir)) } catch { failure("SHARED_SUPPORT_IMAGE_METADATA_UNAVAILABLE", { service: name, owners }) }
        if (!image?.Config || !Array.isArray(image.Config.Env ?? [])) failure("SHARED_SUPPORT_IMAGE_METADATA_UNAVAILABLE", { service: name, owners })
        images.set(imageName, image)
      }
      validateSharedService(name, matches[0], config.services[name], config, volumes, readFile, images.get(imageName))
      verified[name] = matches[0]
    }
    const postgres = config.services.postgres.environment
    const clickhouse = config.services.clickhouse.environment
    for (const [service, command, expected] of [
      ["postgres", ["sh", "-c", "PGPASSWORD=\"$POSTGRES_PASSWORD\" psql -h 127.0.0.1 -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -At -c 'SELECT current_database(), current_user'"], `${postgres.POSTGRES_DB}|${postgres.POSTGRES_USER}`],
      ["valkey", ["valkey-cli", "ping"], "PONG"],
      ["clickhouse", ["sh", "-c", "clickhouse-client --user \"$CLICKHOUSE_USER\" --password \"$CLICKHOUSE_PASSWORD\" --database \"$CLICKHOUSE_DB\" --query 'SELECT currentDatabase(), currentUser()'"], `${clickhouse.CLICKHOUSE_DB}\t${clickhouse.CLICKHOUSE_USER}`],
    ]) {
      let result
      try { result = docker(["exec", verified[service].Id, ...command], platformDir).trim() } catch { failure("SUPPORT_DATA_SCOPE_UNVERIFIED", { service, owners }) }
      if (result !== expected) failure("SUPPORT_DATA_SCOPE_MISMATCH", { service, owners })
    }
    for (const [service, port, path] of [["keycloak", 58080, "/realms/genio-one/.well-known/openid-configuration"], ["otel-collector", 53133, "/"], ["otel-collector-analytics", 53134, "/"]]) {
      let response
      try { response = await fetchUrl(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3000) }) } catch { failure("SUPPORT_NOT_HEALTHY", { service, owners }) }
      if (!response.ok) failure("SUPPORT_NOT_HEALTHY", { service, owners })
      if (service === "keycloak") {
        let discovery
        try { discovery = await response.json() } catch { failure("IDENTITY_DISCOVERY_INVALID") }
        if (discovery.issuer !== "http://127.0.0.1:58080/realms/genio-one") failure("IDENTITY_ISSUER_MISMATCH", { owners })
      }
    }
  }
  return { shared, platformDir, daemonId, owner: owners[0] ?? platformDir, project, issuer: "http://127.0.0.1:58080/realms/genio-one" }
}
