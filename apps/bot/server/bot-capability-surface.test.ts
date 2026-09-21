import { describe, expect, test } from "bun:test"

import { CODEX_CORE_CAPABILITY_DEFS, CODEX_CORE_KINDS } from "./codex-runtime-catalog"
import { RUNTIME_CAPABILITY_IDS } from "@genioone/protocol/runtime-capability-actions"
import {
  DEFAULT_RUNTIME_EXPOSE_POLICY,
  assertHumanPrimaryCopy,
  buildCapabilitySurface,
  buildEnterpriseSurfaceRow,
  buildRuntimeSurfaceRow,
  listRuntimeSurfaceRows,
  mapEnterpriseToSurfaceStatus,
  resolveRuntimeEffectiveAllow,
  statusLabelFor,
} from "./bot-capability-surface"

describe("Epic C bot capability surface", () => {
  test("runtime list has at least four kinds + effective allow/deny", () => {
    const rows = listRuntimeSurfaceRows()
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows.every((r) => r.source === "runtime")).toBe(true)

    const kinds = new Set(rows.map((r) => r.runtime?.kind))
    for (const kind of CODEX_CORE_KINDS) {
      expect(kinds.has(kind)).toBe(true)
    }

    const allow = rows.filter((r) => r.runtime?.effective === "ALLOW")
    const deny = rows.filter((r) => r.runtime?.effective === "DENY")
    expect(allow.length).toBeGreaterThan(0)
    expect(deny.length).toBeGreaterThan(0)

    const browser = rows.find((r) => r.runtime?.capabilityId === "browser.open")
    expect(browser?.effectiveAllow).toBe(false)
    expect(browser?.statusLabel).toBe("無法使用")
    expect(browser?.ctaLabel).toBe("無法使用")
    expect(browser?.status).toBe("unavailable")
  })

  test("runtime surface covers the shared capability registry", () => {
    const ids = ["codex.subscription", ...CODEX_CORE_CAPABILITY_DEFS.map((definition) => definition.id)]
    expect(ids).toEqual([...RUNTIME_CAPABILITY_IDS])
    expect(ids).toContain("mcp.invoke")
    expect(ids).toContain("remote_hands.use")
  })

  test("default policy matches A-1 draft allow/deny", () => {
    expect(resolveRuntimeEffectiveAllow("shell.exec")).toBe("ALLOW")
    expect(resolveRuntimeEffectiveAllow("filesystem.read")).toBe("ALLOW")
    expect(resolveRuntimeEffectiveAllow("web_search.query")).toBe("ALLOW")
    expect(resolveRuntimeEffectiveAllow("browser.open")).toBe("DENY")
    expect(DEFAULT_RUNTIME_EXPOSE_POLICY.deny).toContain("browser.open")
  })

  test("deny wins over allow", () => {
    expect(
      resolveRuntimeEffectiveAllow("shell.exec", {
        allow: ["shell.exec"],
        deny: ["shell.exec"],
      }),
    ).toBe("DENY")
  })

  test("enterprise + runtime share one list interaction model", () => {
    const rows = buildCapabilitySurface({
      enterprise: [
        {
          resourceId: "servicenow-csm",
          capabilityId: "mcp-tool-lookup",
          resourceDisplayName: "ServiceNow CSM",
          capabilityDisplayName: "Lookup case",
          addState: "NEEDS_CONNECTION",
          binding: null,
        },
        {
          resourceId: "jira",
          capabilityId: "mcp-tool-search",
          resourceDisplayName: "Jira",
          capabilityDisplayName: "Search issues",
          addState: "AUTO_GRANT",
          binding: null,
        },
        {
          resourceId: "secret-vault",
          capabilityId: "mcp-tool-x",
          resourceDisplayName: "Vault",
          capabilityDisplayName: "Read secret",
          addState: "DENIED",
          reason: "no_entitlement",
          binding: null,
        },
      ],
    })

    expect(rows.some((r) => r.source === "runtime")).toBe(true)
    expect(rows.some((r) => r.source === "enterprise")).toBe(true)
    expect(rows.filter((r) => r.source === "runtime").length).toBe(CODEX_CORE_CAPABILITY_DEFS.length)

    const connect = rows.find((r) => r.key.includes("servicenow-csm"))
    expect(connect?.statusLabel).toBe("需連線")
    expect(connect?.ctaLabel).toBe("連接")

    const auto = rows.find((r) => r.key.includes("jira"))
    expect(auto?.statusLabel).toBe("可用")
    expect(auto?.ctaLabel).toBe("加入")
    expect(auto?.statusLabel.includes("AUTO_GRANT")).toBe(false)
    expect(auto?.ctaLabel.includes("AUTO_GRANT")).toBe(false)

    const denied = rows.find((r) => r.key.includes("secret-vault"))
    expect(denied?.statusLabel).toBe("無法使用")
    expect(denied?.ctaLabel).toBe("無法使用")
    expect(denied?.statusLabel.includes("DENIED")).toBe(false)
    expect(denied?.ctaLabel.includes("DENIED")).toBe(false)

    for (const row of rows) {
      assertHumanPrimaryCopy(row.statusLabel, row.ctaLabel)
    }
  })

  test("AUTO_GRANT / DENIED never appear as primary status labels", () => {
    for (const state of ["AUTO_GRANT", "DENIED", "ENTITLED", "REQUEST", "NEEDS_CONNECTION", "CONNECTED"] as const) {
      const row = buildEnterpriseSurfaceRow({
        resourceId: "r",
        capabilityId: "c",
        resourceDisplayName: "R",
        capabilityDisplayName: "C",
        addState: state,
        binding: null,
      })
      expect(row.statusLabel).not.toContain("AUTO_GRANT")
      expect(row.statusLabel).not.toContain("DENIED")
      expect(row.ctaLabel).not.toContain("AUTO_GRANT")
      expect(row.ctaLabel).not.toContain("DENIED")
    }
  })

  test("binding INSTALLED / PENDING map to human status", () => {
    expect(
      mapEnterpriseToSurfaceStatus({
        addState: "ENTITLED",
        binding: { state: "INSTALLED" },
      }),
    ).toBe("added")
    expect(statusLabelFor("added")).toBe("可用")
    expect(
      mapEnterpriseToSurfaceStatus({
        addState: "REQUEST",
        binding: { state: "PENDING" },
      }),
    ).toBe("pending")
  })

  test("runtime denied row is clearly unavailable", () => {
    const row = buildRuntimeSurfaceRow(
      {
        id: "browser.open",
        kind: "browser",
        display_name: "Browser",
        description: "Open URLs",
      },
      DEFAULT_RUNTIME_EXPOSE_POLICY,
    )
    expect(row.effectiveAllow).toBe(false)
    expect(row.status).toBe("unavailable")
    expect(row.statusLabel).toBe("無法使用")
    expect(row.runtime?.target).toBe("runtime:codex:browser.open")
  })

  test("UX P0 human vocabulary on list status labels", () => {
    expect(statusLabelFor("available")).toBe("可用")
    expect(statusLabelFor("connect_first")).toBe("需連線")
    expect(statusLabelFor("request")).toBe("需申請")
    expect(statusLabelFor("unavailable")).toBe("無法使用")
    expect(statusLabelFor("pending")).toBe("審批中")
    expect(statusLabelFor("added")).toBe("可用")
  })

  test("runtime exposure deny carries human message without protocol tokens", () => {
    const row = buildRuntimeSurfaceRow(
      {
        id: "browser.open",
        kind: "browser",
        display_name: "Browser",
        description: "Open URLs",
      },
      DEFAULT_RUNTIME_EXPOSE_POLICY,
    )
    expect(row.denialKind).toBe("exposure")
    expect(row.userMessage).toBeTruthy()
    expect(row.statusLabel).toBe("無法使用")
    assertHumanPrimaryCopy(row.statusLabel, row.ctaLabel, row.userMessage!)
  })
})
