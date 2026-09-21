import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  KNOWN_RESOURCE_IDS,
  RUNTIME_ACTIONS,
  RUNTIME_AUDIT_KINDS,
  RUNTIME_CAPABILITY_KINDS,
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
} from "./runtime-capability"

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

function loadFixture(): FixtureDoc {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureDoc
}

describe("Runtime Capability schema (Epic A-1)", () => {
  test("exposes core kinds including shell/filesystem/browser/web_search", () => {
    expect(RUNTIME_CAPABILITY_KINDS).toContain("shell")
    expect(RUNTIME_CAPABILITY_KINDS).toContain("filesystem")
    expect(RUNTIME_CAPABILITY_KINDS).toContain("browser")
    expect(RUNTIME_CAPABILITY_KINDS).toContain("web_search")
    expect(RUNTIME_CAPABILITY_KINDS).toContain("remote_hands")
    expect(RUNTIME_CAPABILITY_KINDS).toContain("desktop")
  })

  test("action draft is expose / invoke / load_extension", () => {
    expect([...RUNTIME_ACTIONS]).toEqual(["expose", "invoke", "load_extension"])
  })

  test("audit kinds are expose / invoke / denied", () => {
    expect([...RUNTIME_AUDIT_KINDS]).toEqual(["expose", "invoke", "denied"])
  })

  test("formats and parses runtime:<runtime>:<capability> targets", () => {
    const target = formatRuntimeTarget("codex", "shell.exec")
    expect(target).toBe("runtime:codex:shell.exec")
    expect(isRuntimeTarget(target)).toBe(true)
    expect(parseRuntimeTarget(target)).toEqual({
      runtime_id: "codex",
      capability_id: "shell.exec",
    })
    expect(parseRuntimeTarget("servicenow-csm")).toBeNull()
    expect(parseRuntimeTarget("resource:servicenow-csm:read")).toBeNull()
  })

  test("capability shape requires id, kind, runtime_identity", () => {
    const capability: RuntimeCapability = {
      id: "shell.exec",
      kind: "shell",
      runtime_identity: { runtime_id: "codex", adapter: "codex-app-server" },
      display_name: "Shell",
    }
    expect(() => assertRuntimeCapabilityShape(capability)).not.toThrow()
    expect(targetForCapability(capability)).toBe("runtime:codex:shell.exec")

    expect(() =>
      assertRuntimeCapabilityShape({
        id: "",
        kind: "shell",
        runtime_identity: { runtime_id: "codex" },
      }),
    ).toThrow("RUNTIME_CAPABILITY_ID_REQUIRED")

    expect(() =>
      assertRuntimeCapabilityShape({
        id: "shell.exec",
        kind: "shell",
        runtime_identity: { runtime_id: "" },
      }),
    ).toThrow("RUNTIME_IDENTITY_RUNTIME_ID_REQUIRED")
  })

  test("does not collide with Resource ids", () => {
    for (const resourceId of KNOWN_RESOURCE_IDS) {
      expect(conflictsWithResourceId(resourceId)).toBe(true)
      expect(() =>
        assertRuntimeCapabilityShape({
          id: resourceId,
          kind: "shell",
          runtime_identity: { runtime_id: "codex" },
        }),
      ).toThrow("RUNTIME_CAPABILITY_ID_COLLIDES_WITH_RESOURCE")
    }

    const runtimeTarget = formatRuntimeTarget("codex", "shell.exec")
    expect(conflictsWithResourceId(runtimeTarget)).toBe(false)
    for (const resourceId of KNOWN_RESOURCE_IDS) {
      expect(runtimeTarget).not.toBe(resourceId)
      expect(resourceId.startsWith("runtime:")).toBe(false)
    }
  })

  test("fixture capabilities + constraints + obligations + audit shapes validate", () => {
    const fixture = loadFixture()
    expect(fixture.schema_version).toBe("genio.runtime.capability.v1")
    expect(fixture.capabilities.length).toBeGreaterThanOrEqual(4)

    for (const capability of fixture.capabilities) {
      assertRuntimeCapabilityShape(capability)
      const target = targetForCapability(capability)
      expect(target.startsWith("runtime:")).toBe(true)
      expect(KNOWN_RESOURCE_IDS as readonly string[]).not.toContain(capability.id)
      expect(KNOWN_RESOURCE_IDS as readonly string[]).not.toContain(target)
    }

    expect(fixture.constraints.some((c) => c.kind === "path_allowlist")).toBe(true)
    expect(fixture.obligations.some((o) => o.kind === "audit")).toBe(true)

    const kinds = new Set(fixture.audit_examples.map((e) => e.kind))
    expect(kinds.has("expose")).toBe(true)
    expect(kinds.has("invoke")).toBe(true)
    expect(kinds.has("denied")).toBe(true)

    for (const event of fixture.audit_examples) {
      assertRuntimeAuditEventShape(event)
    }

    expect(fixture.policy_draft.deny).toContain("browser.open")
    expect(fixture.policy_draft.unmanaged_extension_default).toBe("deny")
  })
})
