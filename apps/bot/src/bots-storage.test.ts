import { preferredModel, DEFAULT_CODEX_MODEL } from "../shared/model-selection"
import { beforeEach, describe, expect, it } from "bun:test"

class LocalStorageMock {
  private store = new Map<string, string>()

  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }
}

const mockStorage = new LocalStorageMock()
;(globalThis as any).localStorage = mockStorage

import {
  readBotMessages,
  saveBotMessages,
  readSavedModel,
  saveSavedModel,
  readMessageFeedbacks,
  saveMessageFeedbacks,
  readUnreadBotIds,
  saveUnreadBotIds,
  type ChatMessage,
} from "./bots-storage"

describe("bots-storage persistence", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("persists and restores chat messages per bot and thread", () => {
    const botId = "bot-test-1"
    const threadId = "thread-123"

    expect(readBotMessages(botId, threadId)).toEqual([])

    const messages: ChatMessage[] = [
      { id: "1", role: "user", text: "Hello" },
      { id: "2", role: "assistant", text: "Hi there!" },
    ]

    saveBotMessages(botId, threadId, messages)
    expect(readBotMessages(botId, threadId)).toEqual(messages)
    expect(readBotMessages(botId, "thread-456")).toEqual([])
  })

  it("persists and restores model selection per bot and globally", () => {
    expect(readSavedModel("bot-a")).toBeNull()

    saveSavedModel("gpt-5.6-luna", "bot-a")
    expect(readSavedModel("bot-a")).toBe("gpt-5.6-luna")
    expect(readSavedModel()).toBe("gpt-5.6-luna")

    saveSavedModel("o3-mini", "bot-b")
    expect(readSavedModel("bot-b")).toBe("o3-mini")
    expect(readSavedModel("bot-a")).toBe("gpt-5.6-luna")
  })

  it("persists and restores message feedbacks", () => {
    expect(readMessageFeedbacks()).toEqual({})

    const feedbacks: Record<string, "positive" | "negative"> = {
      "msg-1": "positive",
      "msg-2": "negative",
    }
    saveMessageFeedbacks(feedbacks)
    expect(readMessageFeedbacks()).toEqual(feedbacks)
  })

  it("persists and restores unread bot ids", () => {
    expect(readUnreadBotIds()).toEqual([])

    const unread = ["bot-feedback-1", "bot-agent-2"]
    saveUnreadBotIds(unread)
    expect(readUnreadBotIds()).toEqual(unread)
  })
})

it("prefers Spark initially and restores explicit choices after reload and bot switches", () => {
  localStorage.clear()
  const catalog = [{ id: "gpt-5.6-luna" }, { id: DEFAULT_CODEX_MODEL }]
  expect(preferredModel(catalog, readSavedModel("first"))).toBe(DEFAULT_CODEX_MODEL)
  saveSavedModel("gpt-5.6-luna", "first")
  expect(preferredModel(catalog, readSavedModel("first"))).toBe("gpt-5.6-luna")
  expect(preferredModel(catalog, readSavedModel("new"))).toBe("gpt-5.6-luna")
  saveSavedModel(DEFAULT_CODEX_MODEL, "second")
  expect(preferredModel(catalog, readSavedModel("first"))).toBe("gpt-5.6-luna")
  expect(preferredModel(catalog, readSavedModel("second"))).toBe(DEFAULT_CODEX_MODEL)
  expect(preferredModel([{ id: "company-model" }], readSavedModel("first"))).toBe("company-model")
  expect(readSavedModel("first")).toBe("gpt-5.6-luna")
  expect(preferredModel([], readSavedModel("first"))).toBe("")
})

it("uses the company catalog order without applying the personal subscription default", () => {
  const catalog = [{ id: "company-default" }, { id: DEFAULT_CODEX_MODEL }]
  expect(preferredModel(catalog, null, null)).toBe("company-default")
  expect(preferredModel(catalog, DEFAULT_CODEX_MODEL, null)).toBe(DEFAULT_CODEX_MODEL)
})
