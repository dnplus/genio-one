import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { DEFAULT_BLOUB_AVATAR } from "../../avatar/bloub-avatar"
import type { BotInstance, ChatMessage } from "../../bots-storage"
import { ChatMessageList } from "./ChatMessageList"

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

const activeBot: BotInstance = {
  id: "bot-1",
  name: "Documentation Bot",
  role: "Research documentation",
  title: "Documentation Bot",
  description: "Research documentation",
  avatar: DEFAULT_BLOUB_AVATAR,
  workspacePath: "/workspaces/bot-1",
  skills: [],
  createdAt: Date.now(),
}

test("renders tool activity and reply navigation labels in English without translating message content", () => {
  const messages: ChatMessage[] = [
    { id: "activity", role: "system", text: "工具執行", kind: "activity" },
    { id: "original", role: "user", text: "Original message" },
    { id: "reply", role: "assistant", text: "Reply content", replyToMessageId: "original" },
  ]
  const html = withEnglishBotLocale(() => renderToStaticMarkup(
    <ChatMessageList
      messages={messages}
      activeBot={activeBot}
      effectiveStatus={{ text: "Ready", state: "idle", isReady: true }}
      isAgentBusy={false}
      agentState="idle"
      codexLogin={null}
      messageFeedbacks={{}}
      copiedMessageId={null}
      showScrollBottom={false}
      messagesContainerRef={{ current: null }}
      onScroll={() => {}}
      onScrollToBottom={() => {}}
      onFeedback={() => {}}
      onRetry={() => {}}
      onCopyMessage={() => {}}
      onStarterPromptClick={() => {}}
    />,
  ))

  expect(html).toContain("Tool execution")
  expect(html).toContain("View original message")
  expect(html).toContain("Reply content")
  expect(html).not.toContain("工具執行")
  expect(html).not.toContain("查看原訊息")
})
