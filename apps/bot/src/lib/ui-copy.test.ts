import { expect, test } from "bun:test"
import { botDisplayName, botStatusText, handsProviderLabel, handsWorkspaceLabel } from "./ui-copy"
import type { RuntimeDetails } from "./codex-client"

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")

function withEnglishBotLocale<T>(run: () => T): T {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "?lang=en" } },
  })
  try {
    return run()
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

test("translates only the original CE demo Bot name and header status tooltips", () => {
  withEnglishBotLocale(() => {
    expect(botDisplayName({ name: "CE 文件與規格 Bot", sourceResourceId: "genio.demo.bot" })).toBe("CE Documentation & Product Bot")
    expect(botDisplayName({ name: "Ada's research Bot", sourceResourceId: "genio.demo.bot" })).toBe("Ada's research Bot")
    expect(botStatusText("1 個工具 · GenioOne SSO")).toBe("1 tool · GenioOne SSO")
    expect(botStatusText("2 個工具 · GenioOne SSO")).toBe("2 tools · GenioOne SSO")
    expect(botStatusText("本機工作資料夾：/workspaces/demo")).toBe("Local workspace: /workspaces/demo")
    expect(botStatusText("遠端受控電腦已連線，點擊切換畫面")).toBe("Remote managed desktop connected; click to switch views")
    expect(botStatusText("基礎遠端沙盒可執行；尚未開啟桌面畫面")).toBe("Basic remote sandbox is ready; the desktop view is not open")
    expect(botStatusText("對話與企業工具可用；執行程式時才會啟動遠端沙盒")).toBe("Conversation and enterprise tools are available; the remote sandbox starts when code execution is needed")
    expect(botStatusText("1 個工具 · 1 個服務 · GenioOne SSO")).toBe("1 tool · 1 service · GenioOne SSO")
    expect(botStatusText("3 個工具 · 2 個服務 · GenioOne SSO")).toBe("3 tools · 2 services · GenioOne SSO")
    expect(botStatusText("GenioOne SSO session 無法使用")).toBe("GenioOne SSO session is unavailable")
    expect(botStatusText("工具連線中")).toBe("Connecting tools")
    expect(botStatusText("展示模式")).toBe("Demo mode")
    expect(botStatusText("等待 Codex OAuth runtime")).toBe("Waiting for Codex OAuth runtime")
    expect(botStatusText("等待 GenioOne AI Gateway runtime")).toBe("Waiting for GenioOne AI Gateway runtime")
    expect(botStatusText("目前工作仍在進行，完成後再重新連線工具。")).toBe("Work is still in progress. Reconnect tools after it finishes.")
    expect(botStatusText("等待新的工作階段載入工具")).toBe("Waiting for a new session to load tools")
    expect(botStatusText("正在確認企業工具")).toBe("Checking enterprise tools")
    expect(botStatusText("GENIO_MANAGED_MCP_UNAVAILABLE")).toBe("GENIO_MANAGED_MCP_UNAVAILABLE")
  })
})

test("keeps enterprise tool status in Traditional Chinese outside the English locale", () => {
  const statuses = [
    "1 個工具 · 1 個服務 · GenioOne SSO",
    "3 個工具 · 2 個服務 · GenioOne SSO",
    "GenioOne SSO session 無法使用",
    "工具連線中",
    "展示模式",
    "等待 Codex OAuth runtime",
    "目前工作仍在進行，完成後再重新連線工具。",
    "等待新的工作階段載入工具",
    "正在確認企業工具",
    "GENIO_MANAGED_MCP_UNAVAILABLE",
  ]
  for (const status of statuses) expect(botStatusText(status)).toBe(status)
})

test("provider and workspace labels follow the reported remote runtime without naming a local endpoint", () => {
  const runtime: RuntimeDetails = {
    kind: "cloudflare-hands", tier: "headless", cwd: "/home/user", desktopUrl: null,
    sandboxId: "cf-sandbox", workspaceId: "workspace-1", workspaceRevision: 7,
    leaseId: "lease-1", environmentId: "environment-1", execServerUrl: "ws://executor", execReady: true,
  }
  expect(handsProviderLabel(runtime)).toBe("Cloudflare Hands")
  expect(handsWorkspaceLabel(runtime)).toBe("工作區 workspace-1 · 已保存版本 7")
  withEnglishBotLocale(() => {
    expect(handsWorkspaceLabel(runtime)).toBe("Workspace workspace-1 · saved revision 7")
    expect(handsProviderLabel({ ...runtime, kind: "e2b-self-hosted" })).toBe("Self-hosted E2B")
  })
  expect(handsProviderLabel({ ...runtime, kind: "endpoint" })).toBeNull()
  expect(handsWorkspaceLabel({ ...runtime, kind: "endpoint" })).toBeNull()
})
