/**
 * Pure Codex Runtime capability catalog (no Node / process deps).
 * Shared by Epic B adapter + Epic C Bot capability surface UI.
 */
import type { RuntimeCapabilityKind } from "./runtime-capability"

export interface CodexCoreCapabilityDef {
  id: string
  kind: RuntimeCapabilityKind
  display_name: string
  description: string
}

export const CODEX_SUBSCRIPTION_CAPABILITY_DEF: CodexCoreCapabilityDef = {
  id: "codex.subscription",
  kind: "model",
  display_name: "Personal Codex",
  description: "Use your own Codex subscription for this Bot",
}

/** Native Codex surface aligned with A-1 contract-reviewer fixture ids. */
export const CODEX_CORE_CAPABILITY_DEFS: readonly CodexCoreCapabilityDef[] = [
  {
    id: "shell.exec",
    kind: "shell",
    display_name: "Shell",
    description: "Execute shell commands inside the runtime sandbox",
  },
  {
    id: "filesystem.read",
    kind: "filesystem",
    display_name: "Filesystem read",
    description: "Read files within allowlisted paths",
  },
  {
    id: "filesystem.write",
    kind: "filesystem",
    display_name: "Filesystem write",
    description: "Write files within allowlisted paths",
  },
  {
    id: "browser.open",
    kind: "browser",
    display_name: "Browser",
    description: "Open URLs in the desktop browser",
  },
  {
    id: "web_search.query",
    kind: "web_search",
    display_name: "Web search",
    description: "Query web search providers",
  },
] as const

/** Core four kinds that discover() must surface. */
export const CODEX_CORE_KINDS = ["shell", "filesystem", "browser", "web_search"] as const
export type CodexCoreKind = (typeof CODEX_CORE_KINDS)[number]
