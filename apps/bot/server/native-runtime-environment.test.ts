import { expect, test } from "bun:test"

import { nativeRuntimeEnvironment } from "./native-runtime-environment"
import type { RuntimeSession } from "./runtime-broker"

function session(): RuntimeSession {
  const desktop = { kind: "local", tier: "desktop", cwd: "/workspace/desktop", desktopUrl: "https://desktop.example", sandboxId: "desktop-sandbox", environmentId: "desktop-environment", execServerUrl: "ws://desktop.example", execReady: true }
  const headless = { kind: "local", tier: "headless", cwd: "/workspace/headless", desktopUrl: null, sandboxId: "headless-sandbox", environmentId: "headless-environment", execServerUrl: "ws://headless.example", execReady: true }
  return {
    id: "runtime-session",
    selectedBotId: "bot-a",
    details: desktop,
    runtimeDetails: { desktop, headless },
  } as RuntimeSession
}

test("selects a native runtime only from an explicit owned environment", () => {
  const runtime = session()

  expect(nativeRuntimeEnvironment(runtime, {}, "bot-a")).toEqual({ hasRuntimeEnvironment: false, hasDesktopRuntime: false })
  expect(nativeRuntimeEnvironment(runtime, { environments: [] }, "bot-a")).toEqual({ hasRuntimeEnvironment: false, hasDesktopRuntime: false })
  expect(nativeRuntimeEnvironment(runtime, { environments: [{ environmentId: "desktop-environment" }] }, "bot-a")).toEqual({ hasRuntimeEnvironment: true, hasDesktopRuntime: true })
  expect(nativeRuntimeEnvironment(runtime, { environments: [{ environmentId: "headless-environment" }] }, "bot-a")).toEqual({ hasRuntimeEnvironment: true, hasDesktopRuntime: false })
  expect(nativeRuntimeEnvironment(runtime, { environments: [{ environmentId: "foreign-environment" }] }, "bot-a")).toEqual({ hasRuntimeEnvironment: false, hasDesktopRuntime: false })
})
