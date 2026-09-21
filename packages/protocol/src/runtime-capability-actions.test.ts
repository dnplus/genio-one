import assert from "node:assert/strict"
import test from "node:test"

import {
  RUNTIME_CAPABILITY_IDS,
  RUNTIME_CAPABILITY_REGISTRY,
  capabilityActions,
  defaultRuntimeCapabilityAction,
  isRuntimeCapabilityAction,
  isRuntimeCapabilityId,
} from "./runtime-capability-actions"

test("the runtime capability registry declares every executable Bot policy target", () => {
  assert.deepEqual(RUNTIME_CAPABILITY_IDS, [
    "codex.subscription",
    "model.invoke",
    "shell.exec",
    "filesystem.read",
    "filesystem.write",
    "browser.open",
    "web_search.query",
    "mcp.invoke",
    "remote_hands.use",
  ])
  assert.deepEqual(RUNTIME_CAPABILITY_REGISTRY["shell.exec"], ["expose", "execute"])
  assert.deepEqual(RUNTIME_CAPABILITY_REGISTRY["mcp.invoke"], ["expose", "invoke"])
  assert.deepEqual(RUNTIME_CAPABILITY_REGISTRY["remote_hands.use"], ["expose", "use"])
  assert.deepEqual(RUNTIME_CAPABILITY_REGISTRY["browser.open"], ["expose"])
  assert.deepEqual(RUNTIME_CAPABILITY_REGISTRY["web_search.query"], ["expose"])
})

test("the static registry rejects action pairs that do not have an enforcing runtime path", () => {
  assert.equal(isRuntimeCapabilityId("mcp.invoke"), true)
  assert.equal(isRuntimeCapabilityId("plugin.install"), false)
  assert.equal(isRuntimeCapabilityId("adapter.discovered"), false)
  assert.equal(isRuntimeCapabilityAction("shell.exec", "execute"), true)
  assert.equal(isRuntimeCapabilityAction("shell.exec", "invoke"), false)
  assert.equal(isRuntimeCapabilityAction("remote_hands.use", "use"), true)
  assert.equal(isRuntimeCapabilityAction("browser.open", "invoke"), false)
  assert.equal(isRuntimeCapabilityAction("web_search.query", "invoke"), false)
  assert.equal(defaultRuntimeCapabilityAction("shell.exec"), "execute")
  assert.equal(defaultRuntimeCapabilityAction("mcp.invoke"), "invoke")
  assert.equal(defaultRuntimeCapabilityAction("remote_hands.use"), "use")
  assert.equal(defaultRuntimeCapabilityAction("browser.open"), "expose")
})

test("legacy resource action inference stays outside the runtime registry", () => {
  assert.deepEqual(capabilityActions("unknown.extension", "EXTENSION"), ["expose", "load_extension"])
  assert.deepEqual(capabilityActions("unknown.mcp"), ["expose", "invoke"])
})
