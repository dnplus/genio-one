import { tmpdir } from "node:os"
import type { HandsArtifactCaptureResult, HandsWorkspace } from "@genioone/protocol/hands"
import type { DesktopComputerDriver } from "./desktop-driver"

export type RuntimeKind = "e2b-self-hosted" | "cloudflare-hands" | "local" | "endpoint"
export type RuntimeTier = "none" | "headless" | "desktop"

export interface RuntimeDetails {
  kind: RuntimeKind
  tier: RuntimeTier
  cwd: string
  desktopUrl: string | null
  sandboxId: string | null
  environmentId: string | null
  execServerUrl: string | null
  execReady: boolean
  botId?: string | null
  workspaceId?: string | null
  workspaceRevision?: number | null
  leaseId?: string | null
  endpoint?: { botId: string; hostname: string; expiresAt: number }
}

export interface CodexRuntime {
  send(message: string): Promise<void>
  close(): Promise<void>
  updateToken?(token: string): Promise<void>
}

export interface ManagedDesktop {
  details: RuntimeDetails
  close(): Promise<void>
  computer?: DesktopComputerDriver
  readFile?(path: string): Promise<Uint8Array>
  writeFile?(path: string, data: Uint8Array): Promise<void>
  openFile?(path: string): Promise<void>
  captureArtifact?(path: string, artifactId: string): Promise<HandsArtifactCaptureResult>
  proxy?: {
    executor: { url: string; headers: Record<string, string> }
    desktop?: { url: string; headers: Record<string, string> }
    desktopWebSocket?: { url: string; headers: Record<string, string> }
  }
}

export interface RuntimeCallbacks {
  onMessage(message: string): void
  onExit(reason: string): void
}

export interface RuntimeProvisionRequest {
  runtimeSessionId: string
  leaseRequestId?: string
  tenantId: string
  subjectId: string
  actingClientId: string
  botId?: string
  workspace?: HandsWorkspace
  tier: Exclude<RuntimeTier, "none">
}

export interface CodexHomeNamespace {
  tenantId: string
  subjectId: string
  actingClientId: string
  runtimeSessionId?: string
}

export type CodexRuntimeFactory = (
  accessToken: string,
  callbacks: RuntimeCallbacks,
  namespace?: CodexHomeNamespace,
  relaySecret?: string,
) => CodexRuntime

export function configuredRuntimeKind(environment: NodeJS.ProcessEnv = process.env): RuntimeKind {
  const runtime = environment.GENIO_BOT_RUNTIME?.trim() || "e2b-self-hosted"
  if (runtime === "local" || runtime === "e2b-self-hosted" || runtime === "cloudflare-hands") return runtime
  throw new Error("GENIO_BOT_RUNTIME_INVALID")
}

export function pendingRuntimeDetails(
  kind: RuntimeKind = configuredRuntimeKind(),
  tier: RuntimeTier = "none",
): RuntimeDetails {
  return {
    kind,
    tier,
    cwd: kind === "local" ? (process.env.GENIO_BOT_LOCAL_CWD?.trim() || tmpdir()) : kind === "cloudflare-hands" ? "/workspace" : "/home/user/workspace",
    desktopUrl: null,
    sandboxId: null,
    environmentId: null,
    execServerUrl: null,
    execReady: false,
    workspaceId: null,
    workspaceRevision: null,
    leaseId: null,
  }
}

export class PendingRuntime implements ManagedDesktop {
  constructor(readonly details: RuntimeDetails = pendingRuntimeDetails()) {}
  async close() {}
}
