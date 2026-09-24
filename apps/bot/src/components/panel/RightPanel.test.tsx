import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ArtifactRef } from "../../lib/bot-api"

import { RightPanel } from "./RightPanel"

test("desktop view offers a visible recovery action while its short-lived browser credential is active", () => {
  const html = renderToStaticMarkup(
    <RightPanel
      activeTab="desktop"
      onTabChange={() => {}}
      bot={{ id: "bot-1", name: "Desktop Bot", role: "", title: "Desktop Bot", description: "", avatar: "aqua", workspacePath: "/home/user", skills: [], createdAt: 1 } as any}
      messages={[]}
      onSelectMessage={() => {}}
      runtime={{ kind: "e2b-self-hosted", tier: "desktop", cwd: "/home/user", desktopUrl: "/api/desktop/runtime-1/vnc.html", sandboxId: "sandbox-1", workspaceId: "workspace-1", workspaceRevision: 3, leaseId: "lease-1", environmentId: "e2b-sandbox-1", execServerUrl: "ws://executor", execReady: true }}
      status="已連線"
      mcpStatus="已連線"
      activities={[]}
      onEnsureRuntime={() => {}}
    />,
  )
  expect(html).toContain("重新連線")
  expect(html).toContain("/api/desktop/runtime-1/vnc.html")
  expect(html).toContain("自架 E2B")
  expect(html).toContain("工作區 workspace-1 · 已保存版本 3")
  expect(html).not.toContain("E2B Managed Desktop")
})

test("Cloudflare Hands workspace is visible while the desktop is not running", () => {
  const html = renderToStaticMarkup(
    <RightPanel
      activeTab="desktop"
      onTabChange={() => {}}
      bot={{ id: "bot-1", name: "Desktop Bot", role: "", title: "Desktop Bot", description: "", avatar: "aqua", workspacePath: "/home/user", skills: [], createdAt: 1 } as any}
      messages={[]}
      onSelectMessage={() => {}}
      runtime={{ kind: "cloudflare-hands", tier: "none", cwd: "/home/user", desktopUrl: null, sandboxId: null, workspaceId: "cf-workspace-1", workspaceRevision: 8, leaseId: null, environmentId: null, execServerUrl: null, execReady: false }}
      status="已連線"
      mcpStatus="已連線"
      activities={[]}
    />,
  )
  expect(html).toContain("Cloudflare Hands")
  expect(html).toContain("工作區 cf-workspace-1 · 已保存版本 8")
  expect(html).toContain("Hands 模擬預覽")
  expect(html).toContain("實際遠端執行請以提供者與工作區狀態為準")
  expect(html).not.toContain("E2B Managed Desktop")
})

test("isolate artifact shows its source and cross-provider desktop import is unavailable", () => {
  const cloudflareArtifact: ArtifactRef = {
    artifactId: "artifact-isolate", tenantId: "tenant-1", botId: "bot-1", sourceTier: "isolate",
    sourceEnvironmentId: "workspace:workspace-1", path: "/workspace/report.txt", digest: "sha256:report",
    contentType: "text/plain", size: 6, storageProvider: "cloudflare-hands", sourceWorkspaceId: "workspace-1",
    sourceRevision: 4, storageRef: "artifacts/report", createdAt: 1,
  }
  const e2bArtifact: ArtifactRef = {
    ...cloudflareArtifact, artifactId: "artifact-e2b", sourceTier: "headless", path: "/home/user/workspace/chart.csv",
    storageProvider: "e2b-self-hosted", sourceWorkspaceId: "workspace-2", storageRef: null,
  }
  const html = renderToStaticMarkup(
    <RightPanel
      activeTab="desktop"
      onTabChange={() => {}}
      bot={{ id: "bot-1", name: "Desktop Bot", role: "", title: "Desktop Bot", description: "", avatar: "aqua", workspacePath: "/workspace", skills: [], createdAt: 1 } as any}
      messages={[]}
      onSelectMessage={() => {}}
      runtime={{ kind: "cloudflare-hands", tier: "desktop", cwd: "/workspace", desktopUrl: "/api/desktop/runtime-1/vnc.html", sandboxId: null, workspaceId: "workspace-1", workspaceRevision: 4, leaseId: "lease-1", environmentId: "hands-lease-1", execServerUrl: "ws://executor", execReady: true }}
      status="已連線"
      mcpStatus="已連線"
      activities={[]}
      artifacts={[cloudflareArtifact, e2bArtifact]}
      onImportArtifact={() => {}}
    />,
  )
  expect(html).toContain("JS 隔離執行 · Cloudflare Hands")
  expect(html).toContain("Headless · 自架 E2B")
  expect(html.match(/<button[^>]*>在 Desktop 開啟<\/button>/)?.[0]).not.toContain("disabled")
  expect(html.match(/<button[^>]*>提供者不同<\/button>/)?.[0]).toContain("disabled")
})
