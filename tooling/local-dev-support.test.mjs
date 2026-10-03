import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import { parseLocalDevArguments, preflightLocalSupport, recordLocalSupportOwnership } from "./local-dev-support.mjs"
import { ensureIdentity, prepareLocalSupport } from "./local-dev.mjs"

const checkoutRoot = "/test/current"
const platformDir = resolve(checkoutRoot, "apps/platform")
const labels = (service, directory = "/test/previous/apps/platform") => ({
  "com.docker.compose.project": "genio-one-dev",
  "com.docker.compose.service": service,
  "com.docker.compose.project.working_dir": directory,
  "com.docker.compose.project.config_files": `${directory}/compose.yaml`,
})
const ports = { postgres: [55432, 5432], valkey: [56379, 6379], keycloak: [58080, 8080], clickhouse: [58123, 8123, 59000, 9000], "otel-collector": [54317, 4317, 54318, 4318, 53133, 13133], "otel-collector-analytics": [54319, 4317, 54320, 4318, 53134, 13133] }
const envText = readFileSync(new URL("../apps/platform/.env.example", import.meta.url), "utf8")

function fixture() {
  const config = { name: "genio-one-dev", services: {}, volumes: { "postgres-data": { name: "genio-one-dev_postgres-data" } } }
  const images = {}
  const containers = Object.entries(ports).map(([name, servicePorts], index) => {
    const service = {
      image: `test/${name}:1`,
      ports: servicePorts.flatMap((port, position) => position % 2 === 0 ? [{ host_ip: "127.0.0.1", published: String(port), target: servicePorts[position + 1], protocol: "tcp" }] : []),
      environment: name === "postgres" ? { POSTGRES_DB: "genio_one", POSTGRES_USER: "genio_one", POSTGRES_PASSWORD: "genio-one-local" } : name === "clickhouse" ? { CLICKHOUSE_DB: "genio_one_analytics", CLICKHOUSE_USER: "genio_one", CLICKHOUSE_PASSWORD: "genio-one-local" } : {},
      command: ["start"],
      ...(name === "postgres" ? { healthcheck: { test: ["CMD", "healthy"] }, volumes: [{ type: "volume", source: "postgres-data", target: "/var/lib/postgresql" }] } : {}),
    }
    config.services[name] = service
    images[service.image] = { Config: { Env: ["PATH=/usr/local/bin:/usr/bin:/bin"], Volumes: name === "clickhouse" ? { "/var/log/clickhouse-server": {} } : {} } }
    return {
      Id: `container-${index}`,
      Config: { Image: service.image, Env: [...Object.entries(service.environment).map(([key, value]) => `${key}=${value}`), ...images[service.image].Config.Env], Cmd: ["start"], Labels: labels(name) },
      HostConfig: { PortBindings: Object.fromEntries(service.ports.map((port) => [`${port.target}/tcp`, [{ HostIp: "127.0.0.1", HostPort: port.published }]])) },
      NetworkSettings: { Networks: { "genio-one-dev_default": {} } },
      Mounts: name === "postgres" ? [{ Type: "volume", Name: "genio-one-dev_postgres-data", Destination: "/var/lib/postgresql", RW: true }] : name === "clickhouse" ? [{ Type: "volume", Name: "anonymous-image-log-volume", Destination: "/var/log/clickhouse-server", RW: true }] : [],
      State: { Running: true, Health: { Status: "healthy" } },
    }
  })
  const volumes = [{ Name: "genio-one-dev_postgres-data", CreatedAt: "2026-09-30T01:00:00Z", Labels: { "com.docker.compose.project": "genio-one-dev", "com.docker.compose.volume": "postgres-data" } }]
  const commands = []
  let marker
  const options = {
    checkoutRoot,
    environmentOverrides: {},
    canonicalPath: (path) => path,
    occupied: async () => false,
    readFile: (path) => path.endsWith(".env.local") ? envText : marker ?? (() => { throw new Error("missing") })(),
    fetchUrl: async () => ({ ok: true, json: async () => ({ issuer: "http://127.0.0.1:58080/realms/genio-one" }) }),
    docker: (args) => {
      commands.push(args)
      if (args[0] === "info") return "docker-daemon"
      if (args[0] === "compose") return JSON.stringify(config)
      if (args[0] === "ps") return containers.map((container) => container.Id).join("\n")
      if (args[0] === "inspect") return JSON.stringify(containers)
      if (args[0] === "image" && args[1] === "inspect") return JSON.stringify([images[args[2]]])
      if (args[0] === "exec") return args[1] === "container-0" ? "genio_one|genio_one" : args[1] === "container-1" ? "PONG" : "genio_one_analytics\tgenio_one"
      if (args[0] === "volume" && args[1] === "ls") return volumes.map((volume) => volume.Name).join("\n")
      if (args[0] === "volume" && args[1] === "inspect") return JSON.stringify(volumes)
      throw new Error(`unexpected Docker operation ${args[0]}`)
    },
  }
  return { options, config, containers, volumes, images, commands, setMarker: (value) => { marker = value } }
}

function refused(reason) { return (error) => error.diagnostic?.reason === reason }

test("unknown and duplicate CLI arguments are refused", () => {
  assert.deepEqual(parseLocalDevArguments(["clean", "--reuse-support"]), { clean: true, reuseSupport: true })
  for (const args of [["--fresh"], ["clean", "oops"], ["--reuse-support", "--reuse-support"]]) assert.throws(() => parseLocalDevArguments(args), /用法/)
})

test("foreign healthy identity is refused before signing, Compose up or app startup", async () => {
  const { options, commands } = fixture()
  const effects = []
  await assert.rejects(prepareLocalSupport({ preflightOptions: options, signingKeys: () => effects.push("keys"), identity: () => effects.push("identity"), run: () => effects.push("compose-up"), record: () => effects.push("record") }), refused("SUPPORT_OWNED_BY_OTHER_CHECKOUT"))
  assert.deepEqual(effects, [])
  assert.equal(commands.some((args) => args.includes("up")), false)
})

test("explicit compatible reuse skips every Compose reconciliation and ownership write", async () => {
  const { options, commands } = fixture()
  const effects = []
  assert.equal(await prepareLocalSupport({ reuseSupport: true, preflightOptions: options, signingKeys: () => effects.push("keys"), identity: ensureIdentity, run: () => effects.push("up"), record: () => effects.push("record") }), true)
  assert.deepEqual(effects, ["keys"])
  assert.equal(commands.some((args) => args.includes("up")), false)
})

test("shared reuse accepts image default environment and image-declared anonymous volumes", async () => {
  const input = fixture()
  input.images[input.config.services.postgres.image].Config.Env.push("PGDATA=/var/lib/postgresql/data")
  input.containers[0].Config.Env.push("PGDATA=/var/lib/postgresql/data")
  assert.equal((await preflightLocalSupport({ ...input.options, reuseSupport: true })).shared, true)
  assert.equal(input.commands.filter((args) => args[0] === "image" && args[1] === "inspect").length, 6)
  assert.equal(input.commands.some((args) => args.includes("pull")), false)
})

test("shared reuse refuses unconfigured environment and data-directory overrides", async () => {
  for (const defaultValue of [null, "PGDATA=/var/lib/postgresql/data"]) {
    const input = fixture()
    if (defaultValue) input.images[input.config.services.postgres.image].Config.Env.push(defaultValue)
    input.containers[0].Config.Env.push("PGDATA=/different-installation")
    await assert.rejects(preflightLocalSupport({ ...input.options, reuseSupport: true }), refused("SUPPORT_CONFIGURATION_MISMATCH"))
  }
})

test("shared reuse refuses unknown mounts and binds at image-declared volume destinations", async () => {
  for (const mount of [
    { Type: "bind", Source: "/other-installation/postgres", Destination: "/unconfigured-data", RW: true },
    { Type: "volume", Name: "other-data", Destination: "/unconfigured-data", RW: true },
  ]) {
    const input = fixture()
    input.containers[0].Mounts.push(mount)
    await assert.rejects(preflightLocalSupport({ ...input.options, reuseSupport: true }), refused("SUPPORT_CONFIGURATION_MISMATCH"))
  }
  const logs = fixture()
  logs.containers[3].Mounts[0] = { Type: "bind", Source: "/other-logs", Destination: "/var/log/clickhouse-server", RW: true }
  await assert.rejects(preflightLocalSupport({ ...logs.options, reuseSupport: true }), refused("SUPPORT_CONFIGURATION_MISMATCH"))
})

test("shared reuse cannot verify missing local image metadata and never pulls images", async () => {
  const input = fixture()
  const docker = input.options.docker
  input.options.docker = (args) => args[0] === "image" ? (() => { throw new Error("image unavailable") })() : docker(args)
  await assert.rejects(preflightLocalSupport({ ...input.options, reuseSupport: true }), refused("SHARED_SUPPORT_IMAGE_METADATA_UNAVAILABLE"))
  assert.equal(input.commands.some((args) => args.includes("pull")), false)
})

test("explicit reuse checks service configuration and discovery issuer without logging credentials", async () => {
  for (const change of [
    (input) => { input.containers[0].Config.Image = "other-image" },
    (input) => { input.containers[0].Config.Env[2] = "POSTGRES_PASSWORD=super-secret" },
    (input) => { input.containers[1].HostConfig.PortBindings["6379/tcp"][0].HostIp = "0.0.0.0" },
    (input) => { input.containers[2].Config.Cmd = ["wrong"] },
    (input) => { delete input.containers[1].NetworkSettings.Networks["genio-one-dev_default"] },
  ]) {
    const input = fixture()
    change(input)
    await assert.rejects(preflightLocalSupport({ ...input.options, reuseSupport: true }), (error) => error.diagnostic.reason === "SUPPORT_CONFIGURATION_MISMATCH" && !error.message.includes("super-secret"))
  }
  const input = fixture()
  input.options.fetchUrl = async () => ({ ok: true, json: async () => ({ issuer: "http://wrong/realms/genio-one" }) })
  await assert.rejects(preflightLocalSupport({ ...input.options, reuseSupport: true }), refused("IDENTITY_ISSUER_MISMATCH"))
})

test("explicit reuse requires every running healthy support service and refuses cleaning shared data", async () => {
  const input = fixture()
  input.containers.pop()
  await assert.rejects(preflightLocalSupport({ ...input.options, reuseSupport: true }), refused("SUPPORT_SERVICE_MISSING"))
  const stopped = fixture()
  stopped.containers[0].State.Running = false
  await assert.rejects(preflightLocalSupport({ ...stopped.options, reuseSupport: true }), refused("SUPPORT_NOT_HEALTHY"))
  const clean = fixture()
  await assert.rejects(preflightLocalSupport({ ...clean.options, reuseSupport: true, clean: true }), refused("SHARED_SUPPORT_CLEAN_REFUSED"))
})

test("shared PostgreSQL and analytics queries verify the actual database and user", async () => {
  const input = fixture()
  const docker = input.options.docker
  input.options.docker = (args) => args[0] === "exec" && args[1] === "container-0" ? "other_database|other_user" : docker(args)
  await assert.rejects(preflightLocalSupport({ ...input.options, reuseSupport: true }), refused("SUPPORT_DATA_SCOPE_MISMATCH"))
})

test("same checkout stopped containers can restart, then record ownership for down and restart", async () => {
  const input = fixture()
  for (const container of input.containers) {
    container.Config.Labels = labels(container.Config.Labels["com.docker.compose.service"], platformDir)
    container.State.Running = false
  }
  const plan = await preflightLocalSupport(input.options)
  assert.equal(plan.shared, false)
  recordLocalSupportOwnership(plan, { docker: input.options.docker, mkdir: () => {}, writeFile: (_path, value) => input.setMarker(value) })
  input.containers.length = 0
  assert.equal((await preflightLocalSupport(input.options)).shared, false)
  const docker = input.options.docker
  await assert.rejects(preflightLocalSupport({ ...input.options, docker: (args) => args[0] === "info" ? "another-daemon" : docker(args) }), refused("RETAINED_VOLUME_OWNER_UNKNOWN"))
  input.volumes[0].CreatedAt = "2026-10-01T01:00:00Z"
  await assert.rejects(preflightLocalSupport(input.options), refused("RETAINED_VOLUME_OWNER_UNKNOWN"))
})

test("unknown retained volumes, foreign ports and non-Docker listeners fail closed", async () => {
  const retained = fixture()
  retained.containers.length = 0
  await assert.rejects(preflightLocalSupport({ ...retained.options, reuseSupport: true }), refused("RETAINED_VOLUME_OWNER_UNKNOWN"))
  const foreignPort = fixture()
  foreignPort.containers[2].Config.Labels["com.docker.compose.project"] = "other-project"
  const effects = []
  const preparation = (options) => prepareLocalSupport({ preflightOptions: options, signingKeys: () => effects.push("keys"), identity: () => effects.push("identity"), run: () => effects.push("compose-up"), record: () => effects.push("record") })
  await assert.rejects(preparation(foreignPort.options), refused("SUPPORT_PORT_OWNED_BY_OTHER_PROJECT"))
  const nonDocker = fixture()
  nonDocker.containers.length = 0
  nonDocker.volumes.length = 0
  nonDocker.options.occupied = async (port) => port === 58080
  await assert.rejects(preparation(nonDocker.options), refused("SUPPORT_PORT_OWNER_UNKNOWN"))
  assert.deepEqual(effects, [])
})

test("stopped containers in unrelated projects do not reserve free installation ports", async () => {
  const input = fixture()
  for (const container of input.containers) {
    container.Config.Labels["com.docker.compose.project"] = "other-project"
    container.State.Running = false
  }
  input.volumes.length = 0
  const before = JSON.stringify(input.containers)
  assert.equal((await preflightLocalSupport(input.options)).shared, false)
  assert.equal(JSON.stringify(input.containers), before)
  assert.equal(input.commands.some((args) => ["exec", "up", "start", "rm"].some((action) => args.includes(action))), false)
})

test("fresh empty Docker installation passes but Docker or local endpoint mismatches fail before mutation", async () => {
  const fresh = fixture()
  fresh.containers.length = 0
  fresh.volumes.length = 0
  assert.equal((await preflightLocalSupport(fresh.options)).shared, false)
  const mismatch = fixture()
  mismatch.options.environmentOverrides = { GENIO_ONE_DATABASE_URL: "postgresql://genio_one:secret@127.0.0.1:1111/other" }
  await assert.rejects(preflightLocalSupport(mismatch.options), refused("LOCAL_SUPPORT_SCOPE_MISMATCH"))
  const unavailable = fixture()
  unavailable.options.docker = () => { const error = new Error("docker unavailable"); error.diagnostic = { reason: "DOCKER_READ_FAILED" }; throw error }
  await assert.rejects(preflightLocalSupport(unavailable.options), refused("DOCKER_READ_FAILED"))
})

test("own identity starts through Compose and requires the precise discovery issuer", async () => {
  const calls = []
  const support = { shared: false, issuer: "http://127.0.0.1:58080/realms/genio-one" }
  const healthy = await ensureIdentity(support, {
    run: async (_command, args) => calls.push(args),
    wait: async (service) => {
      assert.equal(service.healthy({ issuer: "http://wrong" }, { ok: true }), false)
      assert.equal(service.healthy({ issuer: support.issuer }, { ok: false }), false)
      return service.healthy({ issuer: support.issuer }, { ok: true })
    },
  })
  assert.equal(healthy, true)
  assert.deepEqual(calls, [["env:up:identity"]])
})
