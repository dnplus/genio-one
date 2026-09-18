import { expect, test } from "bun:test"

import { CE_DEMO_PROMPTS } from "../../../../../packages/protocol/src/ce-demo"
import { requiresHeadlessRuntime } from "./Workspace"

test("keeps the unmodified CE documentation prompt on the tools-only path", () => {
  const prompt = CE_DEMO_PROMPTS.find((item) => item.id === "documents")

  expect(prompt).toBeDefined()
  expect(requiresHeadlessRuntime(prompt!.text)).toBe(false)
})

test("requires an explicit execution action and target before provisioning Headless", () => {
  expect(requiresHeadlessRuntime("請建立 architecture.html 檔案")).toBe(true)
  expect(requiresHeadlessRuntime("請執行 shell command 產生報告")).toBe(true)
  expect(requiresHeadlessRuntime("請讀取工作區的現有設定")).toBe(true)
  expect(requiresHeadlessRuntime("請研究 document upload 的官方文件")).toBe(false)
})
