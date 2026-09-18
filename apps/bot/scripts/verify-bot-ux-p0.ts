/**
 * UX P0 verification: human status + deny copy + Connect card path + four denials.
 * Run: bun apps/bot/scripts/verify-bot-ux-p0.ts
 */
import {
  DEFAULT_RUNTIME_EXPOSE_POLICY,
  HUMAN_STATUS_LABELS,
  assertHumanPrimaryCopy,
  buildCapabilitySurface,
  buildRuntimeSurfaceRow,
  statusLabelFor,
} from "../server/bot-capability-surface"
import {
  allDenialAcceptanceRows,
  assertNoProtocolLeak,
  denialCopyFor,
  sanitizeUserFacingError,
} from "../server/bot-capability-deny-copy"
import { connectCardPhaseLabel } from "../src/components/modals/ConnectCard"
import { buildBotCapabilityRows } from "../src/components/modals/CapabilityToolsPanel"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

// --- 1) List status vocabulary ---
for (const status of ["available", "connect_first", "request", "unavailable", "pending", "added"] as const) {
  const label = statusLabelFor(status)
  assert((HUMAN_STATUS_LABELS as readonly string[]).includes(label), `status ${status} → ${label} not in vocabulary`)
}

const surface = buildCapabilitySurface({
  enterprise: [
    {
      resourceId: "sn",
      capabilityId: "lookup",
      resourceDisplayName: "ServiceNow",
      capabilityDisplayName: "Lookup",
      addState: "NEEDS_CONNECTION",
      binding: null,
    },
    {
      resourceId: "jira",
      capabilityId: "search",
      resourceDisplayName: "Jira",
      capabilityDisplayName: "Search",
      addState: "REQUEST",
      binding: null,
    },
    {
      resourceId: "vault",
      capabilityId: "read",
      resourceDisplayName: "Vault",
      capabilityDisplayName: "Read",
      addState: "DENIED",
      reason: "no_entitlement",
      binding: null,
    },
    {
      resourceId: "ok",
      capabilityId: "x",
      resourceDisplayName: "OK",
      capabilityDisplayName: "X",
      addState: "AUTO_GRANT",
      binding: null,
    },
  ],
})

const byRes = (id: string) => surface.find((r) => r.key === `enterprise:${id}:` + (id === "sn" ? "lookup" : id === "jira" ? "search" : id === "vault" ? "read" : "x"))
assert(byRes("sn")?.statusLabel === "需連線", "connection status")
assert(byRes("sn")?.ctaLabel === "連接", "connection CTA")
assert(byRes("sn")?.denialKind === "connection", "connection kind")
assert(byRes("jira")?.statusLabel === "需申請", "request status")
assert(byRes("vault")?.statusLabel === "無法使用", "entitlement status")
assert(byRes("vault")?.denialKind === "entitlement", "entitlement kind")
assert(byRes("ok")?.statusLabel === "可用", `available status got ${byRes("ok")?.statusLabel} key=${byRes("ok")?.key}`)

for (const row of surface) {
  assertHumanPrimaryCopy(row.statusLabel, row.ctaLabel, row.userMessage ?? "")
  assert(!row.statusLabel.includes("AUTO_GRANT"), "AUTO_GRANT leak")
  assert(!row.statusLabel.includes("DENIED"), "DENIED leak")
  assert(!row.statusLabel.includes("NEEDS_CONNECTION"), "NEEDS_CONNECTION leak")
  assert(!row.statusLabel.includes("PEP"), "PEP leak")
}

// --- 2) Runtime Exposure deny ≡ UI 無法使用 ---
const browser = buildRuntimeSurfaceRow(
  { id: "browser.open", kind: "browser", display_name: "Browser", description: "Open" },
  DEFAULT_RUNTIME_EXPOSE_POLICY,
)
assert(browser.statusLabel === "無法使用", "exposure UI status")
assert(browser.denialKind === "exposure", "exposure kind")
assert(browser.effectiveAllow === false, "exposure not allow")
assertNoProtocolLeak(browser.userMessage ?? "")

// --- 3) Four denials each have human + CTA ---
const fours = allDenialAcceptanceRows()
assert(fours.length === 4, "four denials")
const kinds = fours.map((r) => r.kind)
assert(kinds.includes("exposure") && kinds.includes("entitlement") && kinds.includes("connection") && kinds.includes("execution"), "kind set")
for (const row of fours) {
  assertNoProtocolLeak(row.statusLabel, row.message, row.ctaLabel)
}

assert(denialCopyFor("execution").statusLabel === "無法使用", "execution status")
assert(denialCopyFor("connection").ctaLabel === "連接", "connection CTA")

// --- 4) Sanitize protocol errors ---
assert(!sanitizeUserFacingError("BOT_ACCESS_DENIED:403").includes("403"), "no http in sanitized")
assert(!sanitizeUserFacingError("runtime_expose_deny").includes("runtime_expose"), "no reason enum")
assert(!sanitizeUserFacingError("agent-runtime-pep").toUpperCase().includes("PEP"), "no PEP")

// --- 5) Connect card phase switch points ---
assert(connectCardPhaseLabel("choose") === "需連線", "card choose")
assert(connectCardPhaseLabel("connected") === "可用", "card connected → 可用")
assert(connectCardPhaseLabel("oauth_pending") === "連線中", "oauth path")

// --- 6) Panel builder merge ---
const panel = buildBotCapabilityRows([
  {
    resourceId: "sn",
    capabilityId: "lookup",
    resourceDisplayName: "ServiceNow",
    capabilityDisplayName: "Lookup",
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
assert(panel.some((r) => r.source === "runtime"), "panel runtime")
assert(panel.some((r) => r.denialKind === "connection"), "panel connection")
assert(panel.some((r) => r.denialKind === "exposure"), "panel exposure")

console.log("OK UX P0 human deny + Connect card")
console.log(
  JSON.stringify(
    {
      module: "apps/bot/server/bot-capability-deny-copy.ts",
      surface: "apps/bot/server/bot-capability-surface.ts",
      connectCard: "apps/bot/src/components/modals/ConnectCard.tsx",
      panel: "apps/bot/src/components/modals/CapabilityToolsPanel.tsx",
      statusVocabulary: HUMAN_STATUS_LABELS,
      fourDenials: fours.map((r) => ({
        kind: r.kind,
        statusLabel: r.statusLabel,
        ctaLabel: r.ctaLabel,
      })),
      connectPaths: ["oauth"],
      sample: surface
        .filter((r) => r.source === "enterprise")
        .map((r) => ({
          key: r.key,
          statusLabel: r.statusLabel,
          ctaLabel: r.ctaLabel,
          denialKind: r.denialKind,
        })),
      outOfScope: ["real marketplace", "second auth console", "P1 handoff/group", "Notion"],
    },
    null,
    2,
  ),
)
