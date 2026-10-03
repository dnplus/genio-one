import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { BotMemoryPanel, selectedAfterLegacyImport } from "./BotMemoryPanel"

test("legacy memory panel states that old Bot memory is preview-only and separate from the work summary", () => {
  const html = renderToStaticMarkup(<BotMemoryPanel botId="bot-1" botName="測試 Bot" token="token" />)
  expect(html).toContain("舊 Bot 記憶")
  expect(html).toContain("不再自動用於對話")
  expect(html).toContain("不會自動遷移")
  expect(html).toContain("只提供預覽")
  expect(html).toContain("目前工作摘要在「工作」頁獨立管理")
  expect(html).not.toContain("新增記憶")
  expect(html).not.toContain("<form")
})

test("failed legacy imports retain their selected memory IDs", () => {
  const selected = new Set(["imported", "grantless", "read-back-failed"])
  const imported = [{ legacyMemory: { id: "imported" } }]
  expect([...selectedAfterLegacyImport(selected, imported)]).toEqual(["grantless", "read-back-failed"])
})
