import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { DEFAULT_BLOUB_AVATAR } from "../../avatar/bloub-avatar"
import type { BotInstance } from "../../bots-storage"
import { Sidebar } from "./Sidebar"

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

const demoBot: BotInstance = {
  id: "ce-demo",
  name: "CE 文件與規格 Bot",
  role: "查詢技術文件",
  title: "CE 文件與規格 Bot",
  description: "查詢技術文件",
  avatar: DEFAULT_BLOUB_AVATAR,
  workspacePath: "/workspaces/ce-demo",
  skills: [],
  sourceResourceId: "genio.demo.bot",
  createdAt: Date.now(),
}

test("keeps the CE demo Bot's actual conversation summary in English", () => {
  const html = withEnglishBotLocale(() => renderToStaticMarkup(
    <Sidebar
      bots={[demoBot]}
      activeBot={demoBot}
      onSelectBot={() => {}}
      onAddBot={() => {}}
      summaries={{ "ce-demo": { preview: "Actual conversation summary" } }}
    />,
  ))

  expect(html).toContain("Actual conversation summary")
  expect(html).not.toContain("Source-linked documentation research")
})

test("renders the working roster status in English", () => {
  const html = withEnglishBotLocale(() => renderToStaticMarkup(
    <Sidebar
      bots={[demoBot]}
      activeBot={demoBot}
      onSelectBot={() => {}}
      onAddBot={() => {}}
      workStates={{ "ce-demo": "working" }}
      summaries={{ "ce-demo": { preview: "Actual conversation summary" } }}
    />,
  ))

  expect(html).toContain("Working…")
  expect(html).toContain('title="Working"')
  expect(html).not.toContain("工作中")
})

test("renders the approval roster status in English", () => {
  const html = withEnglishBotLocale(() => renderToStaticMarkup(
    <Sidebar
      bots={[demoBot]}
      activeBot={demoBot}
      onSelectBot={() => {}}
      onAddBot={() => {}}
      summaries={{ "ce-demo": { preview: "Actual conversation summary", waitingFor: "approval" } }}
    />,
  ))

  expect(html).toContain("Waiting for your confirmation")
  expect(html).toContain('title="Waiting for your confirmation"')
  expect(html).not.toContain("等待你確認")
})

test("renders non-content roster states in English", () => {
  const cases = [
    {
      expectedPreview: "Unread activity",
      expectedTitle: "Unread activity",
      chinese: "未讀動態",
      props: { unreadBotIds: new Set(["ce-demo"]), summaries: { "ce-demo": { preview: "Actual conversation summary" } } },
    },
    {
      expectedPreview: "Waiting for your answer",
      expectedTitle: "Waiting for your answer",
      chinese: "等待你回答",
      props: { summaries: { "ce-demo": { preview: "Actual conversation summary", waitingFor: "answer" as const } } },
    },
    {
      expectedPreview: "Stopped, no response",
      expectedTitle: "Needs attention",
      chinese: "已停止，未回覆",
      props: { workStates: { "ce-demo": "stopped" as const }, summaries: { "ce-demo": { preview: "Actual conversation summary" } } },
    },
  ]

  for (const item of cases) {
    const html = withEnglishBotLocale(() => renderToStaticMarkup(
      <Sidebar
        bots={[demoBot]}
        activeBot={null}
        onSelectBot={() => {}}
        onAddBot={() => {}}
        {...item.props}
      />,
    ))

    expect(html).toContain(item.expectedPreview)
    expect(html).toContain(`title="${item.expectedTitle}"`)
    expect(html).not.toContain(item.chinese)
  }
})
