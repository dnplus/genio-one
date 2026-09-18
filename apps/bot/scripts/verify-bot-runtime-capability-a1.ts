/**
 * Epic A-1 verification: Runtime Capability schema + target + audit shapes.
 * Run: bun apps/bot/scripts/verify-bot-runtime-capability-a1.ts
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  KNOWN_RESOURCE_IDS,
  RUNTIME_ACTIONS,
  RUNTIME_AUDIT_KINDS,
  assertRuntimeAuditEventShape,
  assertRuntimeCapabilityShape,
  conflictsWithResourceId,
  formatRuntimeTarget,
  isRuntimeTarget,
  parseRuntimeTarget,
  targetForCapability,
  type RuntimeAuditEvent,
  type RuntimeCapability,
  type RuntimeConstraint,
  type RuntimeObligation,
} from "../server/runtime-capability"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const fixturePath = resolve(
  import.meta.dir,
  "../fixtures/runtime-capability/contract-reviewer-bot.json",
)

type FixtureDoc = {
  schema_version: string
  capabilities: RuntimeCapability[]
  constraints: RuntimeConstraint[]
  obligations: RuntimeObligation[]
  audit_examples: RuntimeAuditEvent[]
  policy_draft: {
    allow: string[]
    deny: string[]
    unmanaged_extension_default: string
  }
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureDoc

assert(fixture.schema_version === "genio.runtime.capability.v1", "schema_version mismatch")
assert(RUNTIME_ACTIONS.includes("expose"), "expose action missing")
assert(RUNTIME_ACTIONS.includes("invoke"), "invoke action missing")
assert(RUNTIME_ACTIONS.includes("load_extension"), "load_extension action missing")
assert(RUNTIME_AUDIT_KINDS.includes("expose"), "audit expose missing")
assert(RUNTIME_AUDIT_KINDS.includes("invoke"), "audit invoke missing")
assert(RUNTIME_AUDIT_KINDS.includes("denied"), "audit denied missing")

const target = formatRuntimeTarget("codex", "shell.exec")
assert(target === "runtime:codex:shell.exec", "target format wrong")
assert(isRuntimeTarget(target), "target not recognized")
assert(parseRuntimeTarget(target)?.capability_id === "shell.exec", "target parse failed")

const requiredKinds = new Set(["shell", "filesystem", "browser", "web_search"])
const seenKinds = new Set(fixture.capabilities.map((c) => c.kind))
for (const kind of requiredKinds) {
  assert(seenKinds.has(kind as never), `fixture missing kind ${kind}`)
}

for (const capability of fixture.capabilities) {
  assertRuntimeCapabilityShape(capability)
  const addressed = targetForCapability(capability)
  assert(addressed.startsWith("runtime:"), "target must use runtime: prefix")
  assert(!conflictsWithResourceId(capability.id), `capability id collides: ${capability.id}`)
  assert(!(KNOWN_RESOURCE_IDS as readonly string[]).includes(capability.id), "id equals resource")
  assert(!(KNOWN_RESOURCE_IDS as readonly string[]).includes(addressed), "target equals resource")
}

assert(fixture.constraints.length >= 1, "constraints fixture empty")
assert(fixture.obligations.length >= 1, "obligations fixture empty")

const auditKinds = new Set(fixture.audit_examples.map((e) => e.kind))
assert(auditKinds.has("expose"), "audit fixture missing expose")
assert(auditKinds.has("invoke"), "audit fixture missing invoke")
assert(auditKinds.has("denied"), "audit fixture missing denied")

for (const event of fixture.audit_examples) {
  assertRuntimeAuditEventShape(event)
}

assert(fixture.policy_draft.deny.includes("browser.open"), "browser should be denied in draft")
assert(fixture.policy_draft.unmanaged_extension_default === "deny", "unmanaged default deny")

// Explicit Resource collision matrix
for (const resourceId of KNOWN_RESOURCE_IDS) {
  assert(conflictsWithResourceId(resourceId), `expected collision flag for ${resourceId}`)
  assert(!isRuntimeTarget(resourceId), `resource id must not parse as runtime target: ${resourceId}`)
}

console.log("OK A-1 Runtime Capability schema + target + audit shapes")
console.log(JSON.stringify({
  module: "apps/bot/server/runtime-capability.ts",
  fixture: "apps/bot/fixtures/runtime-capability/contract-reviewer-bot.json",
  capabilityCount: fixture.capabilities.length,
  kinds: [...seenKinds],
  actions: [...RUNTIME_ACTIONS],
  auditKinds: [...RUNTIME_AUDIT_KINDS],
  sampleTarget: target,
  resourceCollisionChecks: [...KNOWN_RESOURCE_IDS],
  constraintKinds: fixture.constraints.map((c) => c.kind),
  obligationKinds: fixture.obligations.map((o) => o.kind),
  auditExampleIds: fixture.audit_examples.map((e) => e.audit_event_id),
  outOfScope: ["Codex hook", "UI", "E2B", "real shell block", "Epic B–H"],
}, null, 2))
