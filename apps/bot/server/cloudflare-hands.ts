import type { HandsArtifactCaptureResult, HandsIsolateRequest, HandsIsolateResult, HandsLease, HandsLeaseRequest, HandsWorkspace } from "@genioone/protocol/hands"
import { handsArtifactPath, handsLeaseArtifactsPath, handsLeaseFilesPath, handsLeasePath, handsWorkspaceArtifactsPath, handsWorkspaceExportPath, handsWorkspaceIsolatePath, handsWorkspacePath, isHandsRelativePath } from "@genioone/protocol/hands"
import { E2BDesktopDriver, type DesktopComputerOperation, type E2BDesktopSdk } from "./desktop-driver"
import type { BotWorkspaceStore } from "./bot-workspace-store"
import type { ManagedDesktop, RuntimeDetails, RuntimeProvisionRequest } from "./runtime"

type ProxyTarget = { url: string; headers: Record<string, string> }

export function cloudflareHandsConfiguration(environment: NodeJS.ProcessEnv = process.env) {
  const origin = environment.GENIO_CF_HANDS_ORIGIN?.trim()
  const token = environment.GENIO_CF_HANDS_TOKEN?.trim()
  if (!origin || !token) throw new Error("CLOUDFLARE_HANDS_CONFIG_REQUIRED")
  const url = new URL(origin)
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("CLOUDFLARE_HANDS_ORIGIN_INVALID")
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("CLOUDFLARE_HANDS_HTTPS_REQUIRED")
  return { origin: url.origin, token }
}

class CloudflareHandsClient {
  readonly origin: string
  readonly headers: Record<string, string>

  constructor(readonly workspace: HandsWorkspace, actorClientId: string) {
    const configuration = cloudflareHandsConfiguration()
    this.origin = configuration.origin
    this.headers = {
      authorization: `Bearer ${configuration.token}`,
      "x-hands-tenant-id": workspace.tenantId,
      "x-hands-bot-id": workspace.botId,
      "x-hands-subject-id": workspace.ownerSubjectId,
      "x-hands-client-id": workspace.actingClientId,
      "x-hands-actor-client-id": actorClientId,
    }
  }

  url(path: string) { return new URL(path, this.origin).toString() }
  proxy(path: string): ProxyTarget { return { url: this.url(path), headers: this.headers } }

  async request(path: string, method: string, body?: BodyInit, contentType?: string) {
    const response = await fetch(this.url(path), {
      method,
      headers: { ...this.headers, ...(contentType ? { "content-type": contentType } : {}) },
      body,
      redirect: "error",
    })
    if (!response.ok) {
      const result = await response.json().catch(() => null) as { error?: string } | null
      throw new Error(result?.error || `CLOUDFLARE_HANDS_HTTP_${response.status}`)
    }
    return response
  }

  async json<T>(path: string, method: string, value?: unknown): Promise<T> {
    const response = await this.request(path, method, value === undefined ? undefined : JSON.stringify(value), value === undefined ? undefined : "application/json")
    return response.json() as Promise<T>
  }
}

class CloudflareDesktopSdk implements E2BDesktopSdk {
  private size: { width: number; height: number } | null = null

  constructor(private readonly client: CloudflareHandsClient, private readonly basePath: string) {}

  private async input(operation: DesktopComputerOperation) {
    await this.client.request(`${this.basePath}api/input`, "POST", JSON.stringify(operation), "application/json")
  }

  async screenshot(_format: "bytes") {
    const response = await this.client.request(`${this.basePath}api/screenshot`, "GET")
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length >= 24 && bytes.subarray(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      this.size = { width: view.getUint32(16), height: view.getUint32(20) }
    }
    return bytes
  }

  async getScreenSize() {
    if (!this.size) await this.screenshot("bytes")
    if (!this.size) throw new Error("COMPUTER_SCREEN_SIZE_UNAVAILABLE")
    return this.size
  }

  leftClick(x: number, y: number) { return this.input({ operation: "click", x, y }) }
  doubleClick(x: number, y: number) { return this.input({ operation: "double_click", x, y }) }
  rightClick(x: number, y: number) { return this.input({ operation: "right_click", x, y }) }
  write(text: string, _options: { chunkSize: number; delayInMs: number }) { return this.input({ operation: "type", text }) }
  press(keys: string | string[]) { return this.input({ operation: "key", keys: Array.isArray(keys) ? keys : [keys] }) }
  scroll(direction: "up" | "down", amount: number) { return this.input({ operation: "scroll", direction, amount }) }
}

export class CloudflareHandsRuntime implements ManagedDesktop {
  readonly details: RuntimeDetails
  readonly computer?: E2BDesktopDriver
  readonly proxy: { executor: ProxyTarget; desktop?: ProxyTarget }
  private closing: Promise<void> | null = null

  private constructor(
    private readonly client: CloudflareHandsClient,
    private readonly lease: HandsLease,
    private readonly workspaces: BotWorkspaceStore,
    request: RuntimeProvisionRequest,
  ) {
    const desktopPath = lease.desktopPath
    this.details = {
      kind: "cloudflare-hands",
      tier: request.tier,
      cwd: lease.cwd,
      desktopUrl: desktopPath ? client.url(`${desktopPath}vnc.html`) : null,
      sandboxId: null,
      environmentId: lease.environmentId,
      execServerUrl: `ws://127.0.0.1:${Number.parseInt(process.env.GENIO_BOT_PORT || "5181", 10)}/api/executor/${encodeURIComponent(request.runtimeSessionId)}?tier=${encodeURIComponent(request.tier)}`,
      execReady: true,
      botId: request.botId ?? null,
      workspaceId: client.workspace.workspaceId,
      workspaceRevision: lease.revision,
      leaseId: lease.leaseId,
    }
    this.proxy = {
      executor: client.proxy(lease.execServerPath),
      ...(desktopPath ? { desktop: client.proxy(desktopPath), desktopWebSocket: client.proxy(`${desktopPath}websockify`) } : {}),
    }
    if (desktopPath && request.botId) {
      this.computer = new E2BDesktopDriver(new CloudflareDesktopSdk(client, desktopPath), {
        runtimeSessionId: request.runtimeSessionId,
        tenantId: request.tenantId,
        subjectId: request.subjectId,
        actingClientId: request.actingClientId,
      })
    }
  }

  static async create(request: RuntimeProvisionRequest, workspaces: BotWorkspaceStore, workspace: HandsWorkspace): Promise<CloudflareHandsRuntime> {
    const client = new CloudflareHandsClient(workspace, request.actingClientId)
    const remote = await client.json<{ workspaceId: string; revision: number }>(handsWorkspacePath(workspace.workspaceId), "PUT", workspace)
    if (remote.workspaceId !== workspace.workspaceId) throw new Error("CLOUDFLARE_HANDS_WORKSPACE_INVALID")
    workspaces.updateRevision(workspace.workspaceId, remote.revision)
    const lease = await client.json<HandsLease>(`${handsWorkspacePath(workspace.workspaceId)}/leases`, "POST", {
      runtimeSessionId: request.leaseRequestId ?? request.runtimeSessionId,
      tier: request.tier,
      expectedRevision: remote.revision,
    } satisfies HandsLeaseRequest)
    if (lease.workspaceId !== workspace.workspaceId || lease.runtimeSessionId !== (request.leaseRequestId ?? request.runtimeSessionId) || lease.tier !== request.tier || !lease.leaseId || !lease.execServerPath || !lease.environmentId) throw new Error("CLOUDFLARE_HANDS_LEASE_INVALID")
    workspaces.updateRevision(workspace.workspaceId, lease.revision)
    return new CloudflareHandsRuntime(client, lease, workspaces, request)
  }

  static async isolate(workspace: HandsWorkspace, workspaces: BotWorkspaceStore, input: HandsIsolateRequest, actorClientId = workspace.actingClientId): Promise<HandsIsolateResult> {
    const client = new CloudflareHandsClient(workspace, actorClientId)
    const remote = await client.json<{ workspaceId: string; revision: number }>(handsWorkspacePath(workspace.workspaceId), "PUT", workspace)
    if (remote.workspaceId !== workspace.workspaceId) throw new Error("CLOUDFLARE_HANDS_WORKSPACE_INVALID")
    workspaces.updateRevision(workspace.workspaceId, remote.revision)
    const result = await client.json<HandsIsolateResult>(handsWorkspaceIsolatePath(workspace.workspaceId), "POST", input)
    if (result.requestId !== input.requestId) throw new Error("CLOUDFLARE_HANDS_RECEIPT_INVALID")
    workspaces.updateRevision(workspace.workspaceId, result.revision)
    return result
  }

  static async exportWorkspace(workspace: HandsWorkspace, actorClientId = workspace.actingClientId) {
    const client = new CloudflareHandsClient(workspace, actorClientId)
    return client.request(handsWorkspaceExportPath(workspace.workspaceId), "GET")
  }

  static async readArtifact(workspace: HandsWorkspace, artifactId: string, actorClientId = workspace.actingClientId) {
    const client = new CloudflareHandsClient(workspace, actorClientId)
    return client.request(handsArtifactPath(workspace.workspaceId, artifactId), "GET")
  }

  static async captureCommittedArtifact(workspace: HandsWorkspace, artifactId: string, path: string, expectedRevision: number, actorClientId: string): Promise<HandsArtifactCaptureResult> {
    if (!isHandsRelativePath(path) || !/^artifact-[a-f0-9-]+$/i.test(artifactId)) throw new Error("ARTIFACT_PATH_INVALID")
    const client = new CloudflareHandsClient(workspace, actorClientId)
    const result = await client.json<HandsArtifactCaptureResult>(handsWorkspaceArtifactsPath(workspace.workspaceId), "POST", { artifactId, path, expectedRevision })
    if (result.artifactId !== artifactId || result.workspaceId !== workspace.workspaceId || !/^sha256:[a-f0-9]{64}$/.test(result.digest) || !Number.isSafeInteger(result.size) || result.size < 0 || result.size > 10 * 1024 * 1024 || !result.storageRef) throw new Error("HANDS_ARTIFACT_RECEIPT_INVALID")
    return result
  }

  async readFile(path: string) {
    if (!isHandsRelativePath(path)) throw new Error("ARTIFACT_PATH_INVALID")
    const response = await this.client.request(handsLeaseFilesPath(this.lease.workspaceId, this.lease.leaseId, path), "GET")
    return new Uint8Array(await response.arrayBuffer())
  }

  async writeFile(path: string, data: Uint8Array) {
    if (!isHandsRelativePath(path)) throw new Error("ARTIFACT_PATH_INVALID")
    const response = await this.client.request(handsLeaseFilesPath(this.lease.workspaceId, this.lease.leaseId, path), "PUT", data.slice().buffer as ArrayBuffer, "application/octet-stream")
    const result = await response.json() as { revision: number }
    this.workspaces.updateRevision(this.lease.workspaceId, result.revision)
    this.details.workspaceRevision = result.revision
  }

  async openFile(path: string) {
    if (!this.lease.desktopPath) throw new Error("DESKTOP_RUNTIME_REQUIRED")
    if (!isHandsRelativePath(path)) throw new Error("ARTIFACT_PATH_INVALID")
    await this.client.request(`${this.lease.desktopPath}api/open`, "POST", JSON.stringify({ path }), "application/json")
  }

  async captureArtifact(path: string, artifactId: string): Promise<HandsArtifactCaptureResult> {
    if (!isHandsRelativePath(path) || !/^artifact-[a-f0-9-]+$/i.test(artifactId)) throw new Error("ARTIFACT_PATH_INVALID")
    const result = await this.client.json<HandsArtifactCaptureResult>(handsLeaseArtifactsPath(this.lease.workspaceId, this.lease.leaseId), "POST", { artifactId, path })
    if (result.artifactId !== artifactId || result.workspaceId !== this.lease.workspaceId || !/^sha256:[a-f0-9]{64}$/.test(result.digest) || !Number.isSafeInteger(result.size) || result.size < 0 || result.size > 10 * 1024 * 1024 || !result.storageRef) throw new Error("HANDS_ARTIFACT_RECEIPT_INVALID")
    return result
  }

  async close() {
    if (this.closing) return this.closing
    this.closing = this.release().catch((error) => { this.closing = null; throw error })
    return this.closing
  }

  private async release() {
    await this.computer?.close()
    const result = await this.client.json<{ revision: number }>(handsLeasePath(this.lease.workspaceId, this.lease.leaseId), "DELETE")
    this.workspaces.updateRevision(this.lease.workspaceId, result.revision)
    this.details.workspaceRevision = result.revision
  }
}
