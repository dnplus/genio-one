/**
 * Pure Codex Runtime capability catalog (no Node / process deps).
 * Shared by Epic B adapter + Epic C Bot capability surface UI.
 */
import type { RuntimeCapabilityId } from "@genioone/protocol/runtime-capability-actions"
import type { RuntimeCapabilityKind } from "./runtime-capability"

export interface RuntimeCapabilityCatalogDef {
  id: RuntimeCapabilityId
  kind: RuntimeCapabilityKind
  display_name: string
  description: string
}

export type CodexCoreCapabilityDef = RuntimeCapabilityCatalogDef

export const CODEX_SUBSCRIPTION_CAPABILITY_DEF: CodexCoreCapabilityDef = {
  id: "codex.subscription",
  kind: "model",
  display_name: "Personal Codex",
  description: "Use your own Codex subscription for this Bot",
}

/** Native Codex surface aligned with A-1 contract-reviewer fixture ids. */
export const CODEX_CORE_CAPABILITY_DEFS: readonly CodexCoreCapabilityDef[] = [
  {
    id: "model.invoke",
    kind: "model",
    display_name: "Model inference",
    description: "Invoke an entitled model through the managed gateway",
  },
  {
    id: "code.javascript",
    kind: "code",
    display_name: "Workspace JavaScript",
    description: "Execute JavaScript in the authorized L1 workspace isolate without native shell access",
  },
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
  {
    id: "mcp.invoke",
    kind: "mcp",
    display_name: "Managed MCP",
    description: "Expose and invoke enterprise MCP resources selected for this Bot",
  },
  {
    id: "remote_hands.use",
    kind: "remote_hands",
    display_name: "Remote hands",
    description: "Use an authorized Hands execution provider and workspace, including a verified local endpoint",
  },
] as const

export const GENIO_DESKTOP_ADAPTER_CAPABILITY_DEFS: readonly RuntimeCapabilityCatalogDef[] = [
  {
    id: "computer.use",
    kind: "desktop",
    display_name: "Genio desktop",
    description: "Operate the Bot's authorized managed desktop",
  },
] as const

/** Core four kinds that discover() must surface. */
export const CODEX_CORE_KINDS = ["model", "shell", "code", "filesystem", "browser", "web_search", "mcp", "remote_hands"] as const
export type CodexCoreKind = (typeof CODEX_CORE_KINDS)[number]
