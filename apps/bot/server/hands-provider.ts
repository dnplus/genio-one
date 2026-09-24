import { createHash } from "node:crypto"
import type { HandsIsolateRequest, HandsIsolateResult, HandsProvider, HandsWorkspace } from "@genioone/protocol/hands"
import { CloudflareHandsRuntime } from "./cloudflare-hands"
import { SelfHostedE2BDesktop } from "./e2b-hands"
import type { BotWorkspaceStore } from "./bot-workspace-store"
import type { ManagedDesktop, RuntimeCallbacks, RuntimeProvisionRequest } from "./runtime-contract"

export interface CapturedHandsArtifact {
  artifactId: string
  workspaceId: string | null
  revision: number | null
  digest: string
  size: number
  storageRef: string | null
  bytes?: Uint8Array
}

export interface HandsBackend {
  readonly provider: HandsProvider
  readonly supportsJavascript: boolean
  provision(request: RuntimeProvisionRequest, callbacks: Pick<RuntimeCallbacks, "onExit">, workspaces?: BotWorkspaceStore): Promise<ManagedDesktop>
  runJavascript(workspace: HandsWorkspace, workspaces: BotWorkspaceStore, input: HandsIsolateRequest, actorClientId: string): Promise<HandsIsolateResult>
  captureArtifact(lease: ManagedDesktop, path: string, artifactId: string): Promise<CapturedHandsArtifact>
  captureCommittedArtifact(workspace: HandsWorkspace, path: string, artifactId: string, actorClientId: string): Promise<CapturedHandsArtifact>
  readArtifact(workspace: HandsWorkspace | null, artifactId: string, readLocal: () => Uint8Array, actorClientId: string): Promise<Uint8Array>
  exportWorkspace(workspace: HandsWorkspace, workspaces: BotWorkspaceStore, actorClientId: string): Promise<Response>
}

const e2bHands: HandsBackend = {
  provider: "e2b-self-hosted",
  supportsJavascript: false,
  provision: (request, callbacks, workspaces) => SelfHostedE2BDesktop.create(request, callbacks, workspaces),
  async runJavascript() { throw new Error("HANDS_JAVASCRIPT_UNSUPPORTED") },
  async captureArtifact(lease, path, artifactId) {
    if (!lease.readFile) throw new Error("RUNTIME_ARTIFACT_READ_UNSUPPORTED")
    const bytes = await lease.readFile(path)
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("ARTIFACT_TOO_LARGE")
    return {
      artifactId,
      workspaceId: lease.details.workspaceId ?? null,
      revision: lease.details.workspaceRevision ?? null,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size: bytes.byteLength,
      storageRef: null,
      bytes,
    }
  },
  async captureCommittedArtifact() { throw new Error("HANDS_COMMITTED_ARTIFACT_UNSUPPORTED") },
  async readArtifact(_workspace, _artifactId, readLocal) { return readLocal() },
  async exportWorkspace(workspace, workspaces) {
    const archive = workspaces.readCheckpoint(workspace.workspaceId, workspace.revision)
    return archive ? new Response(Buffer.from(archive), { headers: { "content-type": "application/gzip" } }) : new Response(null, { status: 204 })
  },
}

const cloudflareHands: HandsBackend = {
  provider: "cloudflare-hands",
  supportsJavascript: true,
  async provision(request, _callbacks, workspaces) {
    if (!workspaces || !request.workspace) throw new Error("WORKSPACE_STORE_REQUIRED")
    return CloudflareHandsRuntime.create(request, workspaces, request.workspace)
  },
  runJavascript: (workspace, workspaces, input, actorClientId) => CloudflareHandsRuntime.isolate(workspace, workspaces, input, actorClientId),
  async captureArtifact(lease, path, artifactId) {
    if (!lease.captureArtifact) throw new Error("RUNTIME_ARTIFACT_CAPTURE_UNSUPPORTED")
    const result = await lease.captureArtifact(path, artifactId)
    return {
      artifactId: result.artifactId,
      workspaceId: result.workspaceId,
      revision: result.revision,
      digest: result.digest,
      size: result.size,
      storageRef: result.storageRef,
    }
  },
  async captureCommittedArtifact(workspace, path, artifactId, actorClientId) {
    const result = await CloudflareHandsRuntime.captureCommittedArtifact(workspace, artifactId, path, workspace.revision, actorClientId)
    return { artifactId: result.artifactId, workspaceId: result.workspaceId, revision: result.revision, digest: result.digest, size: result.size, storageRef: result.storageRef }
  },
  async readArtifact(workspace, artifactId, _readLocal, actorClientId) {
    if (!workspace || workspace.provider !== "cloudflare-hands") throw new Error("ARTIFACT_SOURCE_WORKSPACE_NOT_FOUND")
    const response = await CloudflareHandsRuntime.readArtifact(workspace, artifactId, actorClientId)
    if (Number(response.headers.get("content-length")) > 10 * 1024 * 1024) throw new Error("ARTIFACT_TOO_LARGE")
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("ARTIFACT_TOO_LARGE")
    return bytes
  },
  exportWorkspace: (workspace, _workspaces, actorClientId) => CloudflareHandsRuntime.exportWorkspace(workspace, actorClientId),
}

export function handsBackendFor(provider: HandsProvider): HandsBackend {
  if (provider === "e2b-self-hosted") return e2bHands
  if (provider === "cloudflare-hands") return cloudflareHands
  throw new Error("HANDS_PROVIDER_INVALID")
}
