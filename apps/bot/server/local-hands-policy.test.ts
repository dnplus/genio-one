import { expect, test } from "bun:test"
import { canonicalRuntimeEnvironments, nativeRuntimeEnvironment, ownedRuntimeEnvironment } from "./native-runtime-environment"
import type { RuntimeSession } from "./runtime-broker"
import type { RuntimeDetails } from "./runtime"

test("Endpoint access binds the selected Bot and canonical workspace without host fallback", () => {
  const details: RuntimeDetails = { kind: "endpoint", tier: "headless", cwd: "/local/project", desktopUrl: null, sandboxId: null, environmentId: "endpoint-1", execServerUrl: "ws://127.0.0.1:5181/api/local-hands/executor/endpoint-1", execReady: true, endpoint: { botId: "owner-bot", hostname: "local-device", expiresAt: Date.now() + 60_000 } }
  const session = { selectedBotId: "another-tab-bot", details, runtimeDetails: { headless: details } } as RuntimeSession
  expect(ownedRuntimeEnvironment(session, "endpoint-1", undefined, "other-bot")).toBeNull()
  expect(ownedRuntimeEnvironment(session, "endpoint-1", "ws://attacker.test", "owner-bot")).toBeNull()
  expect(canonicalRuntimeEnvironments(session, [{ environmentId: "endpoint-1", cwd: "/", runtimeWorkspaceRoots: ["/"] }], "owner-bot")).toEqual([{ environmentId: "endpoint-1", cwd: "/local/project", runtimeWorkspaceRoots: ["/local/project"] }])
  expect(nativeRuntimeEnvironment(session, {}, "owner-bot").hasRuntimeEnvironment).toBe(false)
  expect(nativeRuntimeEnvironment(session, { environments: [{ environmentId: "endpoint-1" }] }, "other-bot").hasRuntimeEnvironment).toBe(false)
  expect(nativeRuntimeEnvironment(session, { environments: [{ environmentId: "endpoint-1" }] }, "owner-bot").hasRuntimeEnvironment).toBe(true)
  details.execReady = false
  expect(() => canonicalRuntimeEnvironments(session, [{ environmentId: "endpoint-1" }], "owner-bot")).toThrow("RUNTIME_ENVIRONMENT_NOT_OWNED")
})
