import { describe, expect, test } from "bun:test"
import { DEFAULT_BLOUB_AVATAR } from "../../avatar/bloub-avatar"
import type { BotInstance } from "../../bots-storage"
import type { RuntimeDetails } from "../../lib/codex-client"
import { demoCatalog } from "../common/helpers"
import { getDesktopStatus, getToolStatus } from "./WorkspaceHeader"

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

describe("WorkspaceHeader getToolStatus", () => {
  const dummyBot: BotInstance = {
    id: "bot-test",
    name: "測試助手",
    role: "測試員",
    title: "測試員",
    description: "說明",
    avatar: DEFAULT_BLOUB_AVATAR,
    workspacePath: "/tmp",
    skills: [],
    bindings: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  test("returns 尚未加入工具 when bot has no installed bindings", () => {
    const catalog = demoCatalog()
    const status = getToolStatus("", catalog, dummyBot)
    expect(status.text).toBe("尚未加入工具")
    expect(status.active).toBe(false)
  })

  test("counts only INSTALLED bindings for active bot", () => {
    const catalog = demoCatalog()
    const botWithBindings: BotInstance = {
      ...dummyBot,
      bindings: [
        {
          resourceId: "servicenow-csm",
          capabilityId: "mcp-tool-read",
          version: "1.0.0",
          state: "INSTALLED",
          kind: "MCP",
        },
        {
          resourceId: "jira",
          capabilityId: "mcp-tool-jira",
          version: "1.0.0",
          state: "PENDING",
          kind: "MCP",
        },
      ],
    }

    const status = getToolStatus("", catalog, botWithBindings)
    expect(status.text).toBe("1 個工具")
    expect(status.active).toBe(true)
    expect(status.warning).toBe(true)

    const englishStatus = withEnglishBotLocale(() => getToolStatus("1 tool", catalog, botWithBindings))
    expect(englishStatus.text).toBe("1 tool")
    expect(englishStatus.warning).toBe(false)
  })

  test("does not treat runtime MCP count as this bot's tool count", () => {
    expect(getToolStatus("已連線", null, dummyBot).text).toBe("尚未加入工具")
    expect(getToolStatus("4 個工具 · 就緒", null, dummyBot).text).toBe("尚未加入工具")
  })
})

const cloudflare: RuntimeDetails = {
  kind: "cloudflare-hands",
  tier: "headless",
  cwd: "/home/user",
  desktopUrl: null,
  sandboxId: "cf-sandbox",
  workspaceId: "workspace-1",
  workspaceRevision: 4,
  leaseId: "lease-1",
  environmentId: "environment-1",
  execServerUrl: "ws://executor",
  execReady: true,
}

test("header status names the active Hands provider and workspace", () => {
  expect(getDesktopStatus(cloudflare)).toEqual({
    text: "Cloudflare Hands 就緒",
    active: true,
    offline: true,
    title: "Cloudflare Hands · 工作區 workspace-1 · 已保存版本 4 · 遠端沙盒可執行",
  })
  expect(getDesktopStatus({ ...cloudflare, tier: "desktop", desktopUrl: "/api/desktop/runtime-1/vnc.html" }).text).toBe("Cloudflare Hands 電腦")
})

test("local endpoint keeps its own status and folder", () => {
  expect(getDesktopStatus({ ...cloudflare, kind: "endpoint", cwd: "/local/project" })).toEqual({
    text: "本機已連接",
    active: true,
    offline: false,
    title: "本機工作資料夾：/local/project",
  })
})
