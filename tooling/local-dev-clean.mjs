import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"

const root = resolve(import.meta.dirname, "..")
const platformDir = resolve(root, "apps/platform")
const botDir = resolve(root, "apps/bot")
const envFile = resolve(platformDir, ".env.local")
const confirmationPhrase = "CLEAN LOCAL GENIO DATA"

const preserveTables = [
  "schema_migrations",
  "genio_one_subjects",
  "genio_one_subject_roles",
  "genio_one_external_identity_bindings",
  "genio_one_organizations",
  "genio_one_organization_memberships",
  "genio_one_organization_membership_sources",
  "genio_one_provider_profiles",
  "genio_one_first_party_policy_seeds",
]

const cleanPlan = [
  "PostgreSQL genio_one：清除 public 內除 migration、Identity、Organization、內建 Provider 之外的所有表格資料",
  "One Policy：保留內建 first-party Bot seed 與目前的啟用／停用狀態",
  "Bot：清除 apps/bot/.local/bot-registry.sqlite、artifacts、bot-packages",
  "Valkey：清除本機 database 0",
  "ClickHouse：只在本地 analytics container 已運行時清除 genio_one_analytics 表格",
  "保留 Keycloak realm、admin/admin、Keycloak volume、程式碼與 SIT",
]

function composeArgs(...args) {
  return ["compose", "--env-file", ".env.local", "--profile", "analytics", "-f", "compose.yaml", ...args]
}

function runningPids(port) {
  const result = spawnSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN", "-n", "-P"], { encoding: "utf8" })
  if (result.status !== 0) return []
  return [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean))]
}

function readEnvValue(text, name, fallback = "") {
  const match = text.match(new RegExp(`^${name}=(.*)$`, "m"))
  if (!match) return fallback
  return match[1].trim().replace(/^['"]|['"]$/g, "")
}

async function run(command, args, cwd = root) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" })
    child.once("error", rejectRun)
    child.once("exit", (code) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`${command} ${args.join(" ")} exited with ${code}`)))
  })
}

function captured(command, args, cwd = root) {
  return spawnSync(command, args, { cwd, encoding: "utf8" })
}

function assertDevStopped() {
  const ports = [5173, 5180, 5181, 58082]
  const busy = ports.flatMap((port) => runningPids(port).map((pid) => `${port}/${pid}`))
  if (busy.length > 0) throw new Error(`請先停止本地 dev 服務：${busy.join(", ")}`)
}

async function clearPostgres() {
  const sql = `do $$ declare item record; begin for item in select table_schema, table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not in (${preserveTables.map((table) => `'${table}'`).join(", ")}) loop execute format('truncate table %I.%I cascade', item.table_schema, item.table_name); end loop; end $$;`
  await run("docker", [...composeArgs("exec", "-T", "postgres", "psql", "-U", "genio_one", "-d", "genio_one", "-v", "ON_ERROR_STOP=1", "-c", sql)], platformDir)
}

async function clearValkey() {
  await run("docker", [...composeArgs("exec", "-T", "valkey", "valkey-cli", "FLUSHDB")], platformDir)
}

async function clearClickHouse(envText) {
  const running = captured("docker", [...composeArgs("ps", "-q", "clickhouse")], platformDir)
  if (running.status !== 0 || !running.stdout.trim()) return false
  const user = readEnvValue(envText, "GENIO_ONE_CLICKHOUSE_USER", "genio_one")
  const password = readEnvValue(envText, "GENIO_ONE_CLICKHOUSE_PASSWORD", "genio-one-local")
  const database = readEnvValue(envText, "GENIO_ONE_CLICKHOUSE_DB", "genio_one_analytics")
  const tables = captured("docker", [...composeArgs("exec", "-T", "clickhouse", "clickhouse-client", "--user", user, "--password", password, "--database", database, "--query", `select name from system.tables where database = '${database}' and is_temporary = 0 format TSVRaw`)], platformDir)
  if (tables.status !== 0) throw new Error(tables.stderr.trim() || "ClickHouse table inventory failed")
  for (const table of tables.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error("ClickHouse table name is invalid")
    await run("docker", [...composeArgs("exec", "-T", "clickhouse", "clickhouse-client", "--user", user, "--password", password, "--database", database, "--query", `truncate table \`${table}\``)], platformDir)
  }
  return true
}

async function clearBotFiles() {
  const localDir = resolve(botDir, ".local")
  const targets = [
    resolve(localDir, "bot-registry.sqlite"),
    resolve(localDir, "bot-registry.sqlite-wal"),
    resolve(localDir, "bot-registry.sqlite-shm"),
    resolve(localDir, "artifacts"),
    resolve(localDir, "bot-packages"),
  ]
  for (const target of targets) {
    if (!target.startsWith(`${localDir}/`)) throw new Error("Refusing an out-of-scope local clean target")
    await rm(target, { recursive: true, force: true })
  }
  await mkdir(localDir, { recursive: true })
}

export async function cleanLocalDev({ input = process.stdin, output = process.stdout } = {}) {
  if (!existsSync(envFile)) throw new Error("apps/platform/.env.local 不存在，拒絕猜測清理目標")
  assertDevStopped()
  output.write("本指令會清理以下本機資料：\n")
  for (const item of cleanPlan) output.write(`- ${item}\n`)
  if (!input.isTTY || !output.isTTY) throw new Error("pnpm dev clean 必須在互動式終端執行")
  const readline = createInterface({ input, output })
  try {
    const answer = await readline.question(`請輸入 ${confirmationPhrase} 以繼續：`)
    if (answer.trim() !== confirmationPhrase) {
      output.write("已取消，沒有清理任何資料。\n")
      return false
    }
  } finally {
    readline.close()
  }
  const envText = await readFile(envFile, "utf8")
  await run("docker", [...composeArgs("up", "-d", "--wait", "postgres", "valkey")], platformDir)
  await clearPostgres()
  await clearValkey()
  await clearBotFiles()
  const clickHouseCleared = await clearClickHouse(envText)
  output.write(`${JSON.stringify({ event: "local-dev.clean-complete", clickhouse: clickHouseCleared ? "cleared" : "not-running" })}\n`)
  return true
}

export { cleanPlan, confirmationPhrase }
