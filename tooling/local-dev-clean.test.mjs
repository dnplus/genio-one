import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { assertDevStopped, clearClickHouse, cleanPlan, confirmationPhrase, devServicePorts } from "./local-dev-clean.mjs"

test("local clean requires an explicit confirmation phrase", () => {
  assert.equal(confirmationPhrase, "CLEAN LOCAL GENIO DATA")
})

test("local clean preserves the login foundation", () => {
  assert.ok(cleanPlan.some((item) => item.includes("Identity")))
  assert.ok(cleanPlan.some((item) => item.includes("Keycloak realm")))
  assert.ok(cleanPlan.some((item) => item.includes("bot-registry.sqlite")))
  assert.ok(cleanPlan.some((item) => item.includes("first-party Bot seed")))
})

test("local clean refuses to run while the distillation triage service is listening", () => {
  assert.ok(devServicePorts.includes(8182))
  assert.throws(() => assertDevStopped({
    findRunningPids(port) {
      return port === 8182 ? ["48291"] : []
    },
  }), /8182\/48291/)
})

test("local clean refuses to run while the Mail2000 connector is listening", () => {
  assert.ok(devServicePorts.includes(58111))
  assert.throws(() => assertDevStopped({
    findRunningPids(port) {
      return port === 58111 ? ["58111"] : []
    },
  }), /58111\/58111/)
})

test("clearClickHouse validates database identifier to prevent SQL injection", async () => {
  await assert.rejects(
    clearClickHouse("GENIO_ONE_CLICKHOUSE_DB=genio_one' --\n"),
    /ClickHouse database name is invalid/,
  )
})
for (const [name, result] of [
  ["找不到 lsof", { status: null, error: Object.assign(new Error("spawnSync lsof ENOENT"), { code: "ENOENT" }), signal: null, stdout: null, stderr: null }],
  ["遭訊號終止", { status: null, signal: "SIGTERM", stdout: "", stderr: "" }],
  ["非預期退出碼", { status: 2, signal: null, stdout: "", stderr: "" }],
  ["無退出狀態", { status: null, signal: null, stdout: "", stderr: "" }],
  ["退出碼 1 帶有錯誤訊息", { status: 1, signal: null, stdout: "", stderr: "lsof: permission denied" }],
  ["退出碼 1 帶有部分結果", { status: 1, signal: null, stdout: "48291\n", stderr: "" }],
  ["正常找到 listener", { status: 0, signal: null, stdout: "48291\n", stderr: "" }],
  ["正常沒有 listener", { status: 1, signal: null, stdout: "", stderr: "" }],
]) {
  test(`清理前探測：${name}`, () => {
    const probe = spawnSync("node", ["--input-type=module", "--eval", `
      import assert from "node:assert/strict"
      import childProcess from "node:child_process"
      import fs from "node:fs"
      import { syncBuiltinESMExports } from "node:module"
      import { cleanLocalDev, cleanPlan, devServicePorts } from ${JSON.stringify(new URL("./local-dev-clean.mjs", import.meta.url).href)}

      const result = ${JSON.stringify(result, (key, value) => value instanceof Error ? { message: value.message, code: value.code } : value)}
      const commands = []
      let outputWrites = 0
      childProcess.spawnSync = (command) => {
        commands.push(command)
        assert.equal(command, "lsof")
        return result
      }
      fs.existsSync = () => true
      syncBuiltinESMExports()
      const noListeners = ${JSON.stringify(name === "正常沒有 listener")}
      await assert.rejects(cleanLocalDev({
        input: { isTTY: false },
        output: { isTTY: false, write() { outputWrites += 1 } },
      }), noListeners ? /必須在互動式終端執行/ : result.status === 0 ? /請先停止本地 dev 服務/ : /lsof.*5173/)
      assert.equal(commands.length, noListeners || result.status === 0 ? devServicePorts.length : 1)
      assert.equal(outputWrites, noListeners ? cleanPlan.length + 1 : 0)
    `], { encoding: "utf8" })
    assert.equal(probe.status, 0, probe.stderr || probe.error?.message)
  })
}
