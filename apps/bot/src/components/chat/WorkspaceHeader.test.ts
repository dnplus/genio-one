import { describe, expect, test } from "bun:test"
import { DEFAULT_BLOUB_AVATAR } from "../../avatar/bloub-avatar"
import type { BotInstance } from "../../bots-storage"
import { demoCatalog } from "../common/helpers"
import { getToolStatus } from "./WorkspaceHeader"

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
