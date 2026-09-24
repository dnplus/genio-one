import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { resolve } from "node:path"
import test from "node:test"

import { adoptDistillationProcessor, canCompleteTriageRecovery, canRestartStandaloneDistillationTriage, configureDistillationLaunch, distillationLaunchConfiguration, distillationLaunchState, distillationPortRole, existingServiceLaunchIsCurrent, launchConfigurationDigest, nextTriageHandoffAction, nextTriageRestoreAction, reconcileDistillationLaunchConfiguration, runtimePolicyReportEnvironment, serviceLaunchState, services, serviceOwnerMatches, shouldMonitorUnmanagedTriageHandoff, signalVerifiedServiceOwner, startupServiceNames, triageHandoffPhase, triageHandoffStartupRecoveryOptions, triggerUnmanagedTriageRecovery, unmanagedTriageRecoveryOptions, waitForHealthy, watchServiceExit } from "./local-dev.mjs"

function fixtureChild(script) {
  return spawn(process.execPath, ["-e", script], { stdio: "ignore" })
}

test("local development supervisor owns the complete GenioOne web path", () => {
  assert.deepEqual(services.map((service) => [service.name, service.port]), [
    ["mail2000-connector", 58111],
    ["platform-api", 58082],
    ["platform-web", 5173],
    ["bot-server", 5181],
    ["bot-web", 5180],
    ["distillation-triage", 8182],
  ])
})

test("Mail2000 connector and Bot service are ready before the Platform API bootstrap that seeds them", () => {
  assert.deepEqual(startupServiceNames, ["distillation-triage", "mail2000-connector", "bot-server", "platform-api", "platform-web", "bot-web"])
  const triage = services.find((service) => service.name === "distillation-triage")
  const bot = services.find((service) => service.name === "bot-server")
  assert.equal(triage.env.GENIO_ONE_DISTILLATION_TRIAGE_TOKEN, "local-distillation-triage")
  assert.equal(bot.env.GENIO_ONE_DISTILLATION_TRIAGE_URL, "http://127.0.0.1:8182/v1/distillation-triage")
  assert.equal(bot.env.GENIO_ONE_DISTILLATION_TRIAGE_TOKEN, triage.env.GENIO_ONE_DISTILLATION_TRIAGE_TOKEN)
  assert.equal(distillationPortRole({
    cwd: `${triage.cwd}`,
    command: "bun services/processor/local-distillation-triage.ts",
  }, resolve(triage.cwd, "..", "..")), "local-triage")
  assert.equal(distillationPortRole({
    cwd: "/tmp/other-checkout",
    command: "bun services/processor/server.ts",
  }, resolve(triage.cwd, "..", "..")), "other")
  assert.equal(distillationPortRole({
    cwd: "",
    command: "bun services/processor/local-distillation-triage.ts",
  }, resolve(triage.cwd, "..", "..")), "other")
  const api = services.find((service) => service.name === "platform-api")
  assert.equal(api.env.GENIO_BOT_SERVICE_ENDPOINT, "http://127.0.0.1:5181")
  assert.equal(api.env.GENIO_ONE_CONNECTION_VERIFIER_ALLOW_HTTP, "1")
  assert.equal(api.env.GENIO_ONE_CONNECTION_VERIFIER_ALLOWED_HOSTS, "127.0.0.1,localhost,::1")
  const mail2000 = services.find((service) => service.name === "mail2000-connector")
  assert.equal(mail2000.env.CONNECTOR_PORT, "58111")
})

test("a healthy Platform API without the recorded connector launch is restarted, not reused", () => {
  // Why: `pnpm dev:api` started by hand is healthy but lacks the Mail2000 endpoint and shared
  // configuration key, so reusing it would silently leave the Mail2000 connector unavailable.
  const names = ["GENIO_CONNECTOR_CONFIGURATION_KEY", "GENIO_CONNECTOR_MAIL2000_ENDPOINT"]
  const configured = launchConfigurationDigest({
    GENIO_CONNECTOR_CONFIGURATION_KEY: "k".repeat(43),
    GENIO_CONNECTOR_MAIL2000_ENDPOINT: "http://127.0.0.1:58111/mcp",
  }, names)
  const owners = [{ pid: "4242", cwd: "/repo/apps/platform", command: "tsx platform-api/src/server.ts" }]
  // Manually started API: nothing was recorded by the supervisor.
  assert.equal(existingServiceLaunchIsCurrent({ recorded: "", configuration: configured, owners }), false)
  // Supervisor launched these exact processes with this configuration: reuse.
  const recorded = serviceLaunchState(configured, owners)
  assert.equal(existingServiceLaunchIsCurrent({ recorded, configuration: configured, owners }), true)
  // Same config but a different process now owns the port (restarted outside the supervisor).
  assert.equal(existingServiceLaunchIsCurrent({ recorded, configuration: configured, owners: [{ ...owners[0], pid: "5151" }] }), false)
  // Supervisor-launched process but connector configuration changed since (e.g. rotated key).
  const rotated = launchConfigurationDigest({
    GENIO_CONNECTOR_CONFIGURATION_KEY: "r".repeat(43),
    GENIO_CONNECTOR_MAIL2000_ENDPOINT: "http://127.0.0.1:58111/mcp",
  }, names)
  assert.notEqual(rotated, configured)
  assert.equal(existingServiceLaunchIsCurrent({ recorded, configuration: rotated, owners }), false)
  // The recorded state never contains the raw configuration key.
  assert.equal(recorded.includes("k".repeat(43)), false)
  assert.equal(typeof services.find((service) => service.name === "platform-api").launchConfiguration, "function")
})

test("the distillation worker stays off until a local adapter registry exists", () => {
  const names = ["distillation-triage", "bot-server", "platform-api", "platform-web", "bot-web"]
  const disabledBot = {
    name: "bot-server",
    env: {
      GENIO_ONE_DISTILLATION_TRIAGE_URL: "http://127.0.0.1:8182/v1/distillation-triage",
      GENIO_ONE_DISTILLATION_TRIAGE_TOKEN: "local-distillation-triage",
      GENIO_ONE_DISTILLATION_ADAPTER_ID: "jev-production",
    },
  }
  const disabledTriage = { name: "distillation-triage", env: {} }
  assert.deepEqual(configureDistillationLaunch([disabledBot, disabledTriage], names, {}, () => false), [
    "bot-server", "platform-api", "platform-web", "bot-web",
  ])
  assert.equal(disabledBot.env.GENIO_ONE_DISTILLATION_TRIAGE_URL, undefined)
  assert.equal(disabledBot.env.GENIO_ONE_DISTILLATION_ADAPTER_ID, undefined)
  const missingBot = {
    name: "bot-server",
    env: { GENIO_ONE_DISTILLATION_TRIAGE_URL: "http://127.0.0.1:8182/v1/distillation-triage" },
  }
  assert.deepEqual(configureDistillationLaunch(
    [missingBot, { name: "distillation-triage", env: {} }],
    names,
    { GENIO_ONE_PROCESSOR_ADAPTERS_FILE: "/tmp/missing.json" },
    () => false,
  ), ["bot-server", "platform-api", "platform-web", "bot-web"])
  const enabledBot = {
    name: "bot-server",
    env: { GENIO_ONE_DISTILLATION_ADAPTER_ID: "jev-production" },
  }
  const enabledTriage = { name: "distillation-triage", env: {} }
  const enabled = configureDistillationLaunch(
    [enabledBot, enabledTriage],
    names,
    { GENIO_ONE_PROCESSOR_ADAPTERS_FILE: " /tmp/adapters.json " },
    (file) => file === "/tmp/adapters.json",
  )
  assert.equal(enabled[0], "distillation-triage")
  assert.equal(enabledTriage.env.GENIO_ONE_PROCESSOR_ADAPTERS_FILE, "/tmp/adapters.json")
  assert.equal(enabledBot.env.GENIO_ONE_DISTILLATION_ADAPTER_ID, "jev-production")
  const relativeBot = { name: "bot-server", env: {} }
  const relativeTriage = { name: "distillation-triage", env: {} }
  const relativePlatform = { name: "platform-api", env: {} }
  const expected = resolve(services.find((service) => service.name === "distillation-triage").cwd, "fixtures/adapters.json")
  assert.deepEqual(configureDistillationLaunch(
    [relativeBot, relativeTriage, relativePlatform],
    names,
    { GENIO_ONE_PROCESSOR_ADAPTERS_FILE: "fixtures/adapters.json" },
    (file) => file === expected,
  ), names)
  assert.equal(relativeTriage.env.GENIO_ONE_PROCESSOR_ADAPTERS_FILE, expected)
  // Platform runs from apps/platform; an unresolved relative path would point at a different file there.
  assert.equal(relativePlatform.env.GENIO_ONE_PROCESSOR_ADAPTERS_FILE, expected)
})

test("changing or disabling distillation configuration restarts the Bot before triage", async () => {
  const serviceList = [
    {
      name: "bot-server",
      env: {
        GENIO_ONE_DISTILLATION_TRIAGE_URL: "http://127.0.0.1:8182/v1/distillation-triage",
        GENIO_ONE_DISTILLATION_TRIAGE_TOKEN: "local-distillation-triage",
        GENIO_ONE_DISTILLATION_ADAPTER_ID: "jev-production",
      },
    },
    {
      name: "distillation-triage",
      env: {
        GENIO_ONE_AI_PROCESSOR_HTTP_LISTEN: "127.0.0.1:8182",
        GENIO_ONE_DISTILLATION_TRIAGE_TOKEN: "local-distillation-triage",
        GENIO_ONE_PROCESSOR_ADAPTERS_FILE: "/tmp/adapters.json",
      },
    },
  ]
  const initial = distillationLaunchConfiguration(serviceList, () => "{\"adapters\":[\"one\"]}")
  serviceList[1].env.GENIO_ONE_PROCESSOR_ADAPTERS_FILE = "/tmp/updated-adapters.json"
  const changedPath = distillationLaunchConfiguration(serviceList, () => "{\"adapters\":[\"one\"]}")
  assert.notEqual(changedPath, initial)
  configureDistillationLaunch(serviceList, ["distillation-triage", "bot-server"], {}, () => false)
  const disabled = distillationLaunchConfiguration(serviceList, () => "")
  assert.notEqual(disabled, changedPath)
  const events = []
  assert.equal(await reconcileDistillationLaunchConfiguration({
    previous: distillationLaunchState(initial, [{ pid: "123" }]),
    current: distillationLaunchState(changedPath, [{ pid: "123" }]),
    async stopBot() { events.push("bot") },
    async stopTriage() { events.push("triage") },
  }), true)
  assert.deepEqual(events, ["bot", "triage"])
  assert.equal(await reconcileDistillationLaunchConfiguration({
    previous: distillationLaunchState(changedPath, [{ pid: "123" }]),
    current: distillationLaunchState(changedPath, [{ pid: "123" }]),
    async stopBot() { throw new Error("should not restart") },
    async stopTriage() { throw new Error("should not restart") },
  }), false)
  assert.equal(await reconcileDistillationLaunchConfiguration({
    previous: distillationLaunchState(changedPath, [{ pid: "123" }]),
    current: distillationLaunchState(changedPath, [{ pid: "456" }]),
    async stopBot() { events.push("bot") },
    async stopTriage() { events.push("triage") },
  }), true)
  assert.equal(await reconcileDistillationLaunchConfiguration({
    previous: distillationLaunchState(changedPath, [{ pid: "123" }], [{ pid: "7" }]),
    current: distillationLaunchState(changedPath, [{ pid: "123" }], [{ pid: "8" }]),
    async stopBot() { events.push("bot") },
    async stopTriage() { events.push("triage") },
  }), true)
  assert.equal(await reconcileDistillationLaunchConfiguration({
    previous: distillationLaunchState(changedPath, [{ pid: "123" }]),
    current: distillationLaunchState(disabled, [{ pid: "123" }]),
    async stopBot() { events.push("bot") },
    async stopTriage() { events.push("triage") },
  }), true)
  assert.deepEqual(events, ["bot", "triage", "bot", "triage", "bot", "triage", "bot", "triage"])
})

test("a referenced credential rotation changes only the persisted distillation fingerprint", () => {
  const serviceList = [{
    name: "bot-server",
    env: {
      GENIO_ONE_DISTILLATION_TRIAGE_URL: "http://127.0.0.1:8182/v1/distillation-triage",
      GENIO_ONE_DISTILLATION_TRIAGE_TOKEN: "local-distillation-triage",
      GENIO_ONE_DISTILLATION_ADAPTER_ID: "jev-production",
    },
  }, {
    name: "distillation-triage",
    env: {
      GENIO_ONE_AI_PROCESSOR_HTTP_LISTEN: "127.0.0.1:8182",
      GENIO_ONE_DISTILLATION_TRIAGE_TOKEN: "local-distillation-triage",
      GENIO_ONE_PROCESSOR_ADAPTERS_FILE: "/tmp/adapters.json",
    },
  }]
  const registry = JSON.stringify({
    schema_version: 1,
    adapters: [{
      id: "jev-production",
      tenant_id: "tenant-default",
      kind: "JEV",
      credential_env: "JEV_API_KEY",
    }],
  })
  const previous = distillationLaunchConfiguration(serviceList, () => registry, {
    GENIO_ONE_PROCESSOR_ADAPTER_CREDENTIAL_ENV_NAMES: "JEV_API_KEY",
    JEV_API_KEY: "credential-before-rotation",
  })
  const current = distillationLaunchConfiguration(serviceList, () => registry, {
    GENIO_ONE_PROCESSOR_ADAPTER_CREDENTIAL_ENV_NAMES: "JEV_API_KEY",
    JEV_API_KEY: "credential-after-rotation",
  })
  const changedNames = distillationLaunchConfiguration(serviceList, () => registry, {
    GENIO_ONE_PROCESSOR_ADAPTER_CREDENTIAL_ENV_NAMES: "JEV_API_KEY,SAFETY_TEST_TOKEN",
    JEV_API_KEY: "credential-before-rotation",
    SAFETY_TEST_TOKEN: "unused-credential",
  })
  assert.notEqual(current, previous)
  assert.notEqual(changedNames, previous)
  const persisted = distillationLaunchState(current, [], [])
  assert.equal(persisted.includes("credential-before-rotation"), false)
  assert.equal(persisted.includes("credential-after-rotation"), false)
  assert.equal(persisted.includes("JEV_API_KEY"), false)
})

test("configuration reconciliation leaves an adopted processor to its Gateway controller", () => {
  const checkout = resolve(services.find((service) => service.name === "distillation-triage").cwd, "..", "..")
  assert.equal(canRestartStandaloneDistillationTriage([{
    pid: "7",
    cwd: checkout,
    command: "bun runtimes/gateway/services/processor/server.ts",
  }], checkout), false)
  assert.equal(canRestartStandaloneDistillationTriage([{
    pid: "8",
    cwd: resolve(checkout, "runtimes/gateway"),
    command: "bun services/processor/local-distillation-triage.ts",
  }], checkout), true)
})

test("adopting a verified Processor preserves its controller handoff and creates a missing recovery state", () => {
  const checkout = resolve(services.find((service) => service.name === "distillation-triage").cwd, "..", "..")
  let marker = "controller-owned-marker\n"
  let handoffs = 0
  const adopt = (owners) => adoptDistillationProcessor({
    owners,
    checkoutRoot: checkout,
    handoffExists() { return marker !== undefined },
    createHandoff() {
      handoffs += 1
      marker = "supervisor-created-marker\n"
    },
  })
  assert.equal(adopt([{
    pid: "7",
    cwd: resolve(checkout, "runtimes/gateway"),
    command: "bun services/processor/server.ts",
  }]), true)
  assert.equal(marker, "controller-owned-marker\n")
  assert.equal(handoffs, 0)
  marker = undefined
  assert.equal(adopt([{
    pid: "8",
    cwd: resolve(checkout, "runtimes/gateway"),
    command: "bun services/processor/server.ts",
  }]), true)
  assert.equal(marker, "supervisor-created-marker\n")
  assert.equal(handoffs, 1)
  assert.equal(adopt([{
    pid: "9",
    cwd: resolve(checkout, "runtimes/gateway"),
    command: "bun services/processor/local-distillation-triage.ts",
  }]), false)
  assert.equal(adopt([{
    pid: "10",
    cwd: resolve(checkout, "runtimes/gateway"),
    command: "bun services/processor/server.ts",
  }, {
    pid: "11",
    cwd: resolve(checkout, "runtimes/gateway"),
    command: "bun services/processor/local-distillation-triage.ts",
  }]), false)
  assert.equal(adopt([{
    pid: "12",
    cwd: "/tmp/other-checkout",
    command: "bun services/processor/server.ts",
  }]), false)
  assert.equal(handoffs, 1)
})

test("a verified processor takeover retains active handoff ownership", () => {
  assert.equal(nextTriageHandoffAction({ processorListening: true, handoffExists: true, timedOut: false }), "active")
  assert.equal(nextTriageHandoffAction({ processorListening: true, handoffExists: true, timedOut: true }), "active")
})

test("a failed processor takeover restores standalone triage", () => {
  assert.equal(nextTriageHandoffAction({ processorListening: false, handoffExists: true, timedOut: false }), "wait")
  assert.equal(nextTriageHandoffAction({ processorListening: false, handoffExists: false, timedOut: false }), "restore")
  assert.equal(nextTriageHandoffAction({ processorListening: false, handoffExists: true, timedOut: true }), "restore")
})

test("a supervisor restart waits only for an in-progress handoff while the Processor listener is briefly free", () => {
  const takingOverRecovery = triageHandoffStartupRecoveryOptions({
    handoffExists: true,
    portOccupied: false,
    handoffPhase: "taking-over",
  })
  const readyRecovery = triageHandoffStartupRecoveryOptions({
    handoffExists: true,
    portOccupied: false,
    handoffPhase: "ready",
  })
  assert.deepEqual(takingOverRecovery, { waitForProcessor: true })
  assert.deepEqual(readyRecovery, { waitForProcessor: false })
  assert.deepEqual(triageHandoffStartupRecoveryOptions({
    handoffExists: true,
    portOccupied: false,
    handoffPhase: undefined,
  }), { waitForProcessor: false })
  assert.equal(nextTriageHandoffAction({ processorListening: false, handoffExists: true, timedOut: false }), "wait")
  assert.equal(nextTriageHandoffAction({
    processorListening: false,
    handoffExists: true,
    timedOut: !readyRecovery.waitForProcessor,
  }), "restore")
  assert.equal(triageHandoffStartupRecoveryOptions({
    handoffExists: true,
    portOccupied: true,
    handoffPhase: "taking-over",
  }), undefined)
  assert.equal(triageHandoffStartupRecoveryOptions({
    handoffExists: false,
    portOccupied: false,
    handoffPhase: "taking-over",
  }), undefined)
})

test("a retained ready handoff restores standalone triage immediately after the supervisor restarts", () => {
  const recovery = triageHandoffStartupRecoveryOptions({
    handoffExists: true,
    portOccupied: false,
    handoffPhase: "ready",
  })
  assert.deepEqual(recovery, { waitForProcessor: false })
  assert.equal(nextTriageHandoffAction({
    processorListening: false,
    handoffExists: true,
    timedOut: !recovery.waitForProcessor,
  }), "restore")
})

test("an unmanaged handoff marker starts one bounded recovery", () => {
  assert.equal(shouldMonitorUnmanagedTriageHandoff({
    handoffExists: false,
    triageChildActive: false,
    recoveryActive: false,
    processorActive: false,
  }), false)
  assert.equal(shouldMonitorUnmanagedTriageHandoff({
    handoffExists: true,
    triageChildActive: true,
    recoveryActive: false,
    processorActive: false,
  }), false)
  assert.equal(shouldMonitorUnmanagedTriageHandoff({
    handoffExists: true,
    triageChildActive: false,
    recoveryActive: true,
    processorActive: false,
  }), false)
  assert.equal(shouldMonitorUnmanagedTriageHandoff({
    handoffExists: true,
    triageChildActive: false,
    recoveryActive: false,
    processorActive: true,
  }), false)
  assert.equal(shouldMonitorUnmanagedTriageHandoff({
    handoffExists: true,
    triageChildActive: false,
    recoveryActive: false,
    processorActive: false,
  }), true)
})

test("a lost active Processor schedules standalone triage recovery", () => {
  assert.equal(nextTriageHandoffAction({ processorListening: true, handoffExists: true, timedOut: false }), "active")
  assert.equal(nextTriageHandoffAction({ processorListening: false, handoffExists: true, timedOut: false }), "wait")
  assert.equal(nextTriageHandoffAction({ processorListening: false, handoffExists: true, timedOut: true }), "restore")
  assert.equal(shouldMonitorUnmanagedTriageHandoff({
    handoffExists: true,
    triageChildActive: false,
    recoveryActive: false,
    processorActive: true,
  }), false)
  assert.equal(shouldMonitorUnmanagedTriageHandoff({
    handoffExists: true,
    triageChildActive: false,
    recoveryActive: false,
    processorActive: false,
  }), true)
})

test("a live takeover retains its grace period while an established Processor crash recovers promptly", () => {
  const recoveryOptions = []
  const trigger = (handoffPhase, processorActive) => triggerUnmanagedTriageRecovery({
    handoffExists: true,
    triageChildActive: false,
    recoveryActive: false,
    processorActive,
    handoffPhase,
    recover(options) {
      recoveryOptions.push(options)
    },
  })
  assert.equal(triageHandoffPhase("taking-over\ngeneration-1\n"), "taking-over")
  assert.equal(triageHandoffPhase("ready\ngeneration-1\n"), "ready")
  assert.equal(triageHandoffPhase("2026-09-23T10:00:00.000Z\n"), "ready")
  assert.equal(trigger("taking-over", true), false)
  assert.equal(trigger("taking-over", false), true)
  assert.equal(trigger("ready", false), true)
  assert.deepEqual(recoveryOptions, [{ waitForProcessor: true }, { waitForProcessor: false }])
  assert.deepEqual(unmanagedTriageRecoveryOptions({ handoffPhase: "taking-over" }), { waitForProcessor: true })
  assert.deepEqual(unmanagedTriageRecoveryOptions({ handoffPhase: "ready" }), { waitForProcessor: false })
  assert.equal(nextTriageHandoffAction({
    processorListening: false,
    handoffExists: true,
    timedOut: !recoveryOptions[1].waitForProcessor,
  }), "restore")
})

test("an occupied listener without verified triage ownership is not replaced", () => {
  assert.equal(nextTriageRestoreAction({ portOccupied: true, ownersVerified: false }), "wait")
  assert.equal(nextTriageRestoreAction({ portOccupied: true, ownersVerified: true }), "ready")
  assert.equal(nextTriageRestoreAction({ portOccupied: false, ownersVerified: false }), "spawn")
})

test("a verified standalone triage is rechecked before clearing recovery state", () => {
  const service = { name: "distillation-triage", port: 8182, cwd: "/work/gateway", marker: "local-distillation-triage.ts" }
  const owners = [{ pid: "42", cwd: "/work/gateway", command: "bun services/processor/local-distillation-triage.ts" }]
  assert.equal(canCompleteTriageRecovery({
    service,
    expectedOwners: owners,
    currentOwners: owners,
    healthy: true,
  }), true)
  assert.equal(canCompleteTriageRecovery({
    service,
    expectedOwners: owners,
    currentOwners: owners,
    healthy: false,
  }), false)
  assert.equal(canCompleteTriageRecovery({
    service,
    expectedOwners: owners,
    currentOwners: [{ ...owners[0], pid: "43" }],
    healthy: true,
  }), false)
})

test("a stale service PID is never signaled and an exited verified PID is tolerated", () => {
  const service = { name: "distillation-triage", port: 8182, cwd: "/work/gateway", marker: "local-distillation-triage.ts" }
  const owner = { pid: "42", cwd: "/work/gateway", command: "bun services/processor/local-distillation-triage.ts" }
  let signals = 0
  assert.throws(() => signalVerifiedServiceOwner({
    service,
    owner,
    currentOwner: { ...owner, command: "node unrelated.mjs" },
    signal() { signals += 1 },
  }), /changed before signal/)
  assert.equal(signals, 0)
  assert.equal(signalVerifiedServiceOwner({
    service,
    owner,
    currentOwner: owner,
    signal() {
      const error = new Error("gone")
      error.code = "ESRCH"
      throw error
    },
  }), "exited")
})

test("an adopted Processor rejects a changed recorded configuration", async () => {
  const previous = distillationLaunchState("configuration-before", [{ pid: "11" }])
  const current = distillationLaunchState("configuration-after", [{ pid: "11" }])
  let stopped = false
  await assert.rejects(reconcileDistillationLaunchConfiguration({
    previous,
    current,
    hasAdoptedProcessor: () => true,
    async stopBot() { stopped = true },
    async stopTriage() { stopped = true },
  }), /Gateway Runtime owns the active Processor; restart and reapply it/)
  assert.equal(stopped, false)
})

test("an adopted Processor requires a verifiable prior configuration", async () => {
  for (const previous of ["", JSON.stringify({ configuration: "legacy-configuration", botPids: ["10"], triagePids: [] })]) {
    let stopped = false
    await assert.rejects(reconcileDistillationLaunchConfiguration({
      previous,
      current: distillationLaunchState("configuration-current", [{ pid: "11" }]),
      hasAdoptedProcessor: () => true,
      async stopBot() { stopped = true },
      async stopTriage() { stopped = true },
    }), /Gateway Runtime owns the active Processor/)
    assert.equal(stopped, false)
  }
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
