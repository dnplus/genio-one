import { describe, expect, test } from "bun:test"

import { buildBotCapabilityRows, runtimePolicySourceLabel } from "./CapabilityToolsPanel"
import type { CatalogAddRow, RuntimePolicySnapshot } from "../../lib/bot-api"

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")

function withEnglishBotLocale<T>(run: () => T): T {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "?demo=documents&lang=en" } },
  })
  try {
    return run()
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

describe("CapabilityToolsPanel list builder", () => {
  test("merges runtime discover and enterprise catalog into one list", () => {
    const catalog: CatalogAddRow[] = [
      {
        resourceId: "jira",
        capabilityId: "search",
        resourceDisplayName: "Jira",
        capabilityDisplayName: "Search",
        addState: "AUTO_GRANT",
        connectionStatus: "AVAILABLE",
        reason: "auto_grant_eligible",
        approvalPolicyRef: null,
        skillId: null,
        installBinding: true,
        pendingBinding: false,
        usableFromCatalogAlone: false,
        binding: null,
      },
      {
        resourceId: "denied-res",
        capabilityId: "x",
        resourceDisplayName: "Denied Res",
        capabilityDisplayName: "X",
        addState: "DENIED",
        connectionStatus: "AVAILABLE",
        reason: "no_entitlement",
        approvalPolicyRef: null,
        skillId: null,
        installBinding: false,
        pendingBinding: false,
        usableFromCatalogAlone: false,
        binding: null,
      },
    ]

    const rows = buildBotCapabilityRows(catalog, null)
    expect(rows.some((r) => r.source === "runtime")).toBe(true)
    expect(rows.some((r) => r.source === "enterprise")).toBe(true)
    expect(rows.filter((r) => r.source === "runtime").length).toBeGreaterThanOrEqual(4)

    const auto = rows.find((r) => r.key.includes("jira"))
    expect(auto?.statusLabel).toBe("可用")
    expect(auto?.ctaLabel).toBe("加入")
    expect(auto?.statusLabel).not.toContain("AUTO_GRANT")
    expect(auto?.ctaLabel).not.toContain("AUTO_GRANT")

    const deniedEnt = rows.find((r) => r.key.includes("denied-res"))
    expect(deniedEnt?.statusLabel).toBe("無法使用")

    const deniedRt = rows.find((r) => r.runtime?.capabilityId === "browser.open")
    expect(deniedRt?.statusLabel).toBe("無法使用")
    expect(deniedRt?.effectiveAllow).toBe(false)
    expect(deniedRt?.denialKind).toBe("exposure")
    expect(deniedRt?.userMessage).toBeTruthy()

    const needs = buildBotCapabilityRows([
      {
        resourceId: "sn",
        capabilityId: "q",
        resourceDisplayName: "SN",
        capabilityDisplayName: "Q",
        addState: "NEEDS_CONNECTION",
        connectionStatus: "NEEDS_CONNECTION",
        reason: "needs_connection",
        approvalPolicyRef: null,
        skillId: null,
        installBinding: false,
        pendingBinding: false,
        usableFromCatalogAlone: false,
        binding: null,
      },
    ], null)
    const conn = needs.find((r) => r.key.includes("sn"))
    expect(conn?.statusLabel).toBe("需連線")
    expect(conn?.ctaLabel).toBe("連接")
    expect(conn?.denialKind).toBe("connection")
  })

  test("uses the effective Platform runtime policy and closes missing capabilities", () => {
    const snapshot: RuntimePolicySnapshot = {
      tenant_id: "tenant-local",
      subject_id: "person-dylan",
      client_id: "genio-one-bot",
      bot_id: "bot-dylan",
      runtime_id: "codex",
      policy_id: "one-policy.runtime.capabilities",
      policy_display_name: "Runtime capabilities",
      policy_revision: 7,
      decisions: [
        "codex.subscription",
        "shell.exec",
        "filesystem.read",
        "filesystem.write",
        "browser.open",
        "web_search.query",
      ].map((capability_id) => ({
        tenant_id: "tenant-local",
        subject_id: "person-dylan",
        client_id: "genio-one-bot",
        bot_id: "bot-dylan",
        runtime_id: "codex",
        policy_id: "one-policy.runtime.capabilities",
        policy_display_name: "Runtime capabilities",
        policy_revision: 7,
        capability_id,
        action: capability_id === "codex.subscription" ? "use" as const : "expose" as const,
        target: `runtime:codex:${capability_id}`,
        decision: capability_id === "shell.exec" ? "DENY" as const : "ALLOW" as const,
        reason_code: capability_id === "shell.exec" ? "RULE_DENY:shell" : "RULE_ALLOW:default",
        constraints: [],
        obligations: [],
        correlation_id: null,
        session_id: null,
        evaluated_at: 1_757_000_000,
      })),
    }

    const rows = buildBotCapabilityRows([], snapshot)
    expect(rows.find((row) => row.runtime?.capabilityId === "codex.subscription")?.effectiveAllow).toBe(true)
    expect(rows.find((row) => row.runtime?.capabilityId === "shell.exec")?.effectiveAllow).toBe(false)
    expect(rows.find((row) => row.runtime?.capabilityId === "shell.exec")?.statusLabel).toBe("無法使用")
    expect(rows.find((row) => row.runtime?.capabilityId === "browser.open")?.effectiveAllow).toBe(true)

    const composite = {
      ...snapshot,
      policy_id: null,
      policy_display_name: null,
      policy_revision: null,
      decisions: snapshot.decisions.map((item, index) => index === 0 ? item : {
        ...item,
        policy_id: "one-policy.other",
        policy_display_name: "Other policy",
        policy_revision: 8,
      }),
    } satisfies RuntimePolicySnapshot
    expect(runtimePolicySourceLabel(composite)).toBe("多項政策")
  })

  test("shows every runtime capability as unavailable when the effective read is unavailable", () => {
    const rows = buildBotCapabilityRows([], null)
    expect(rows.filter((row) => row.source === "runtime")).toHaveLength(9)
    expect(rows.filter((row) => row.source === "runtime").every((row) => row.effectiveAllow === false)).toBe(true)
  })
})

test("groups Discovery tools without combining per-capability permissions and collapses runtime controls", async () => {
  const { createElement } = await import("react")
  const { renderToStaticMarkup } = await import("react-dom/server")
  const { CapabilityToolsPanel, groupEnterpriseCapabilityRows } = await import("./CapabilityToolsPanel")
  const row = (resourceId: string, capabilityId: string, addState: CatalogAddRow["addState"]): CatalogAddRow => ({
    resourceId, capabilityId, resourceDisplayName: resourceId === "genio-one-discovery" ? "GenioOne Discovery" : "Mail2000",
    capabilityDisplayName: capabilityId, builtinService: resourceId === "genio-one-discovery" ? "DISCOVERY" : null,
    addState, connectionStatus: "AVAILABLE", reason: "catalog", approvalPolicyRef: null, skillId: null,
    installBinding: false, pendingBinding: false, usableFromCatalogAlone: false, binding: null,
  })
  const catalogRows = [row("genio-one-discovery", "search_resources", "ENTITLED"), row("genio-one-discovery", "get_resource", "DENIED"), row("mail2000", "search_resources", "REQUEST")]
  const groups = groupEnterpriseCapabilityRows(buildBotCapabilityRows(catalogRows, null))
  expect(groups).toHaveLength(2)
  expect(groups[0]?.rows).toHaveLength(2)
  expect(groups[0]?.rows.map((item) => item.status)).toEqual(["available", "unavailable"])
  expect(groups[1]?.rows[0]?.status).toBe("request")
  const html = renderToStaticMarkup(createElement(CapabilityToolsPanel, { catalogRows, runtimePolicy: null, addBusy: null, addMessage: "", onEnterpriseAction: () => {} }))
  expect(html.match(/GenioOne Discovery/g)).toHaveLength(1)
  expect(html).toContain("平台內建")
  expect(html).toContain('<details class="runtime-capabilities">')
  expect(html).not.toContain('<details class="runtime-capabilities" open')
  expect(html.indexOf('id="enterprise-capabilities-title"')).toBeLessThan(html.indexOf('<details'))
})

test("renders the capabilities and OAuth connection path in English without changing provider copy", async () => {
  const { createElement } = await import("react")
  const { renderToStaticMarkup } = await import("react-dom/server")
  const { CapabilityToolsPanel } = await import("./CapabilityToolsPanel")
  const catalogRows: CatalogAddRow[] = [{
    resourceId: "microsoft-learn",
    capabilityId: "read-docs",
    resourceDisplayName: "Microsoft Learn",
    capabilityDisplayName: "Read documentation",
    addState: "NEEDS_CONNECTION",
    connectionStatus: "NEEDS_CONNECTION",
    reason: "needs_connection",
    approvalPolicyRef: null,
    skillId: null,
    installBinding: false,
    pendingBinding: false,
    usableFromCatalogAlone: false,
    binding: null,
  }]

  const html = withEnglishBotLocale(() => renderToStaticMarkup(createElement(CapabilityToolsPanel, {
    catalogRows,
    runtimePolicy: null,
    addBusy: null,
    addMessage: "",
    onEnterpriseAction: () => {},
    onRetryRuntimePolicy: () => {},
  })))

  expect(html).toContain("Choose the enterprise tools this Bot can use, then review access and connection status.")
  expect(html).toContain("Enterprise tools")
  expect(html).toContain("Microsoft Learn")
  expect(html).toContain("Read documentation")
  expect(html).toContain("Enterprise · Connection required")
  expect(html).toContain("This capability needs an account connection before it can be added or invoked.")
  expect(html).toContain(">Connect<")
  expect(html).toContain("Runtime capabilities")
  expect(html).toContain("9 items")
  expect(html).toContain("Runtime policy is not available. Runtime capabilities are paused.")
  expect(html).toContain(">Retry<")
  expect(html).not.toContain("企業工具")
  expect(html).not.toContain("需連線")
})
