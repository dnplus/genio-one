import { expect, test } from "bun:test"

import { CE_DEMO_PROMPTS } from "@genioone/protocol/ce-demo"
import { nativeExecutionEnvironments, selectedExecutionRuntime } from "./useCodexSession"
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


test("keeps affirmative Bot-owned Skill management on the tools-only path", () => {
  expect(requiresHeadlessRuntime("請用 write_owned_skill 建立 Skill，檔案只放 SKILL.md")).toBe(false)
  expect(requiresHeadlessRuntime("read_self 與 read_owned_skill；不要讀取工作區")).toBe(false)
  expect(requiresHeadlessRuntime("請建立自有 Skill 的工作指引")).toBe(false)
  expect(requiresHeadlessRuntime("請使用 create_bot 建立一個新的私人 Bot。只建立這一個 Bot，不要重送、不要建立其他 Bot，不要檔案、網路、排程或交接。")).toBe(false)
  expect(requiresHeadlessRuntime("先用 write_owned_skill 建立 Skill，檔案只放 SKILL.md。不要建立 workspace，也不要執行 shell command。")).toBe(false)
  expect(requiresHeadlessRuntime("不要建立 dashboard.html 檔案。")).toBe(false)
})

test("keeps Bot tool readback identifiers on the tools-only path", () => {
  const prompt = "Final C1 readback. Use only genio_bot read_self and read_owned_skill for uat-default-tools-model-write-20260921-b. Reply with current profile revision, Skill revision, and GENIO_FINAL_C1_READBACK_20260921_R2."

  expect(requiresHeadlessRuntime(prompt)).toBe(false)
  expect(requiresHeadlessRuntime("Use only read_self for model-write-profile-file-20260921-b revision readback.")).toBe(false)
  expect(requiresHeadlessRuntime("Please write the file report.txt in the workspace.")).toBe(true)
  expect(requiresHeadlessRuntime("Please execute the shell command to create report.html.")).toBe(true)
  expect(requiresHeadlessRuntime("Please write to project-workspace")).toBe(true)
  expect(requiresHeadlessRuntime("Please run the shell-command")).toBe(true)
})

test("does not exempt workspace or execution requests that mention owner tools", () => {
  expect(requiresHeadlessRuntime("不要用 write_owned_skill，請寫入 workspace 的 SKILL.md")).toBe(true)
  expect(requiresHeadlessRuntime("先用 write_owned_skill，再執行 shell command 產生報告")).toBe(true)
  expect(requiresHeadlessRuntime("請建立 dashboard.html 檔案")).toBe(true)
  expect(requiresHeadlessRuntime("先 read_owned_skill，再建立 report.html 檔案")).toBe(true)
  expect(requiresHeadlessRuntime("不要使用 workspace；請讀取 workspace 的設定")).toBe(true)
})

test("keeps a desktop-only session outside native execution while retaining an explicitly selected Headless workspace", () => {
  const desktop = { kind: "e2b-self-hosted", tier: "desktop", cwd: "/desktop", desktopUrl: "https://desktop.test/vnc.html", sandboxId: "desktop", workspaceId: "workspace-1", workspaceRevision: 3, leaseId: "lease-desktop", environmentId: "desktop-env", execServerUrl: "ws://desktop", execReady: true } as const
  const headless = { kind: "e2b-self-hosted", tier: "headless", cwd: "/workspace", desktopUrl: null, sandboxId: "headless", workspaceId: "workspace-1", workspaceRevision: 3, leaseId: "lease-headless", environmentId: "headless-env", execServerUrl: "ws://headless", execReady: true } as const
  const tiers = { desktop, headless }

  expect(selectedExecutionRuntime(null, tiers)).toBeNull()
  expect(nativeExecutionEnvironments(selectedExecutionRuntime(null, tiers))).toEqual([])
  expect(selectedExecutionRuntime("headless", tiers)).toEqual(headless)
  expect(nativeExecutionEnvironments(selectedExecutionRuntime("headless", tiers))).toEqual([{
    environmentId: "headless-env",
    cwd: "/workspace",
    runtimeWorkspaceRoots: ["/workspace"],
  }])
})
