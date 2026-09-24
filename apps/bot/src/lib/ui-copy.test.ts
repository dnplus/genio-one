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
  })
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
