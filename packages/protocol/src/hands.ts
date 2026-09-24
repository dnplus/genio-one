export type HandsProvider = "e2b-self-hosted" | "cloudflare-hands"
export type HandsTier = "headless" | "desktop"
export type HandsLevel = "L1" | "L2" | "L3"
export type HandsExecutionCapability = "code.javascript" | "shell.native" | "desktop.control"

export interface HandsLevelDescriptor {
  level: HandsLevel
  execution: readonly HandsExecutionCapability[]
  workspaceFiles: boolean
}

export interface HandsProviderDescriptor {
  provider: HandsProvider
  levels: readonly HandsLevelDescriptor[]
}

export const HANDS_PROVIDER_DESCRIPTORS: readonly HandsProviderDescriptor[] = [
  {
    provider: "e2b-self-hosted",
    levels: [
      { level: "L2", execution: ["shell.native"], workspaceFiles: true },
      { level: "L3", execution: ["shell.native", "desktop.control"], workspaceFiles: true },
    ],
  },
  {
    provider: "cloudflare-hands",
    levels: [
      { level: "L1", execution: ["code.javascript"], workspaceFiles: true },
      { level: "L2", execution: ["shell.native"], workspaceFiles: true },
      { level: "L3", execution: ["shell.native", "desktop.control"], workspaceFiles: true },
    ],
  },
]

export interface HandsWorkspaceIdentity {
  workspaceId: string
  tenantId: string
  botId: string
  ownerSubjectId: string
  actingClientId: string
  provider: HandsProvider
}

export interface HandsWorkspace extends HandsWorkspaceIdentity {
  revision: number
  createdAt: number
  updatedAt: number
}

export interface HandsLeaseRequest {
  runtimeSessionId: string
  tier: HandsTier
  expectedRevision?: number
}

export interface HandsLease {
  workspaceId: string
  leaseId: string
  runtimeSessionId: string
  tier: HandsTier
  revision: number
  cwd: string
  environmentId: string
  execServerPath: string
  desktopPath: string | null
}

export interface HandsCheckpointRequest {
  expectedRevision: number
}

export interface HandsCheckpointResult {
  workspaceId: string
  leaseId: string
  revision: number
}

export interface HandsIsolateRequest {
  runtimeSessionId: string
  requestId: string
  code: string
  workspaceAccess?: "none" | "read" | "read-write"
  timeoutMs?: number
  expectedRevision?: number
}

export interface HandsIsolateResult {
  requestId: string
  stdout: string
  stderr: string
  exitCode: number
  revision: number
}

export interface HandsArtifactCaptureRequest {
  artifactId: string
  path: string
}

export interface HandsArtifactCaptureResult {
  artifactId: string
  workspaceId: string
  revision: number
  digest: string
  size: number
  storageRef: string
}

export const handsWorkspacePath = (workspaceId: string) => `/v1/workspaces/${encodeURIComponent(workspaceId)}`
export const handsWorkspaceExportPath = (workspaceId: string) => `${handsWorkspacePath(workspaceId)}/export`
export const handsWorkspaceArtifactsPath = (workspaceId: string) => `${handsWorkspacePath(workspaceId)}/artifacts`
export const handsLeasePath = (workspaceId: string, leaseId: string) => `${handsWorkspacePath(workspaceId)}/leases/${encodeURIComponent(leaseId)}`
export const handsLeaseFilesPath = (workspaceId: string, leaseId: string, path: string) => `${handsLeasePath(workspaceId, leaseId)}/files?path=${encodeURIComponent(path)}`
export const handsLeaseArtifactsPath = (workspaceId: string, leaseId: string) => `${handsLeasePath(workspaceId, leaseId)}/artifacts`
export const handsArtifactPath = (workspaceId: string, artifactId: string) => `${handsWorkspacePath(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`
export const handsWorkspaceIsolatePath = (workspaceId: string) => `${handsWorkspacePath(workspaceId)}/isolate`
export const handsLeaseExecPath = (workspaceId: string, leaseId: string) => `${handsLeasePath(workspaceId, leaseId)}/exec`
export const handsLeaseDesktopPath = (workspaceId: string, leaseId: string) => `${handsLeasePath(workspaceId, leaseId)}/desktop/`

export function isHandsRelativePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(path)) return false
  const segments = path.split("/")
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}
