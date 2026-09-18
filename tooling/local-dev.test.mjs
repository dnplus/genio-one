import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import test from "node:test"

import { runtimePolicyReportEnvironment, services, serviceOwnerMatches, startupServiceNames, waitForHealthy, watchServiceExit } from "./local-dev.mjs"

function fixtureChild(script) {
  return spawn(process.execPath, ["-e", script], { stdio: "ignore" })
}

test("local development supervisor owns the complete GenioOne web path", () => {
  assert.deepEqual(services.map((service) => [service.name, service.port]), [
    ["platform-api", 58082],
    ["platform-web", 5173],
    ["bot-server", 5181],
    ["bot-web", 5180],
  ])
})

test("Bot service is ready before the Platform API bootstrap that seeds it", () => {
  assert.deepEqual(startupServiceNames, ["bot-server", "platform-api", "platform-web", "bot-web"])
  const api = services.find((service) => service.name === "platform-api")
  assert.equal(api.env.GENIO_BOT_SERVICE_ENDPOINT, "http://127.0.0.1:5181")
})

test("local runtime policy reports use a split Bot private key and Platform public key", () => {
  const bot = runtimePolicyReportEnvironment("bot-server", "bot-private-key", "platform-public-key")
  const platform = runtimePolicyReportEnvironment("platform-api", "bot-private-key", "platform-public-key")
  assert.deepEqual(bot, {
    GENIO_ONE_RUNTIME_REPORT_KEY_ID: "local-bot-runtime-report",
    GENIO_ONE_RUNTIME_REPORT_PRIVATE_KEY_PEM: "bot-private-key",
  })
  assert.deepEqual(platform, {
    GENIO_ONE_RUNTIME_REPORT_KEY_ID: "local-bot-runtime-report",
    GENIO_ONE_RUNTIME_REPORT_PUBLIC_KEY_PEM: "platform-public-key",
  })
  assert.equal("GENIO_ONE_RUNTIME_REPORT_PRIVATE_KEY_PEM" in platform, false)
  assert.equal("GENIO_ONE_RUNTIME_REPORT_PUBLIC_KEY_PEM" in bot, false)
})

test("an unexpected zero-exit fixture is reported and fails the supervisor", async () => {
  const child = fixtureChild("setTimeout(() => process.exit(0), 50)")
  const reports = []
  const exitCodes = []
  const handled = new Promise((resolve) => {
    watchServiceExit(child, { name: "fixture-zero" }, {
      isStopping: () => false,
      report: (event) => reports.push(event),
      onUnexpectedExit: (code) => { exitCodes.push(code); resolve() },
    })
  })
  await handled
  assert.deepEqual(reports, [{ event: "local-dev.service-exit", service: "fixture-zero", code: 0, signal: null }])
  assert.deepEqual(exitCodes, [1])
})

test("an unexpected signal-exit fixture is reported and fails the supervisor", async () => {
  const child = fixtureChild("setInterval(() => {}, 1_000)")
  const reports = []
  const exitCodes = []
  const handled = new Promise((resolve) => {
    watchServiceExit(child, { name: "fixture-signal" }, {
      isStopping: () => false,
      report: (event) => reports.push(event),
      onUnexpectedExit: (code) => { exitCodes.push(code); resolve() },
    })
  })
  await once(child, "spawn")
  child.kill("SIGTERM")
  await handled
  assert.deepEqual(reports, [{ event: "local-dev.service-exit", service: "fixture-signal", code: null, signal: "SIGTERM" }])
  assert.deepEqual(exitCodes, [1])
})

test("a fixture exit during a requested shutdown is not reported as a failure", async () => {
  const child = fixtureChild("setTimeout(() => process.exit(0), 50)")
  const reports = []
  let unexpectedExit = false
  watchServiceExit(child, { name: "fixture-stopping" }, {
    isStopping: () => true,
    report: (event) => reports.push(event),
    onUnexpectedExit: () => { unexpectedExit = true },
  })
  await once(child, "exit")
  assert.deepEqual(reports, [])
  assert.equal(unexpectedExit, false)
})

test("a child exit cancels a pending health wait instead of consuming its timeout", async () => {
  let stopping = false
  const child = fixtureChild("setTimeout(() => process.exit(0), 50)")
  const handled = new Promise((resolve) => {
    watchServiceExit(child, { name: "fixture-health-wait" }, {
      isStopping: () => stopping,
      report: () => {},
      onUnexpectedExit: () => { stopping = true; resolve() },
    })
  })
  const startedAt = Date.now()
  const healthy = waitForHealthy({
    name: "fixture-health-wait",
    url: "http://127.0.0.1:0",
    port: 0,
    healthTimeoutMs: 60_000,
    healthy: () => false,
  }, { isStopping: () => stopping })
  await handled
  assert.equal(await healthy, false)
  assert.ok(Date.now() - startedAt < 2_000)
})

test("local API and Bot health predicates reject the old development lanes", () => {
  const api = services.find((service) => service.name === "platform-api")
  const bot = services.find((service) => service.name === "bot-server")
  assert.ok(api)
  assert.ok(bot)
  assert.equal(api.healthy({ status: "ok", component: "genio-one-platform-api", api_mode: "memory-dev" }, new Response()), false)
  assert.equal(bot.healthy({ configured: "e2b-self-hosted", capabilityGate: "open", modelDirectory: "genio-gateway" }), false)
})

test("a healthy local service is reused only from this checkout and expected command", () => {
  const api = services.find((service) => service.name === "platform-api")
  assert.ok(api)
  assert.equal(serviceOwnerMatches(api, {
    cwd: api.cwd,
    command: "bun --env-file=.env.local --watch platform-api/src/server.ts",
  }), true)
  assert.equal(serviceOwnerMatches(api, {
    cwd: "/tmp/another-genioone-checkout/apps/platform",
    command: "bun --env-file=.env.local --watch platform-api/src/server.ts",
  }), false)
  assert.equal(serviceOwnerMatches(api, {
    cwd: api.cwd,
    command: "node unrelated-server.mjs",
  }), false)
})
