import { expect, test, type Page } from "@playwright/test"

const bot = {
  id: "bot-ui-test",
  revision: 4,
  name: "排程測試 Bot",
  title: "排程測試",
  description: "處理測試工作",
  role: "處理測試工作",
  avatar: { shape: "galet", expression: "attentif", color: "#6db6a5" },
  workspacePath: "/workspaces/bot-ui-test",
  skills: [],
  createdAt: 1_700_000_000_000,
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean }

function result(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: false }
}

function failure(code: string): ToolResult {
  return { content: [{ type: "text", text: code }], isError: true }
}

async function seedProductionFixture(page: Page, currentBot: () => typeof bot = () => bot, runtimeMode?: "headless" | "headless-delayed" | "headless-disconnect" | "desktop-denied") {
  await page.addInitScript((mode) => {
    localStorage.setItem("genioone.bot.access_token", "fixture-token")
    const fixture = { requests: [] as Array<{ method: string; params: any; configured: boolean }>, rejected: false, thread: 0, configured: false, releaseHeadless: null as (() => void) | null, dropConnection: null as (() => void) | null, disconnected: false }
    ;(window as any).__codexFixture = fixture
    const details = (tier: "headless" | "desktop") => ({ kind: "e2b-self-hosted", tier, cwd: "/workspaces/bot-ui-test", desktopUrl: null, sandboxId: tier, environmentId: `${tier}-fixture`, execServerUrl: `ws://${tier}.fixture`, execReady: true })
    const active = details(mode === "desktop-denied" ? "desktop" : "headless")
    const NativeWebSocket = window.WebSocket
    class FixtureWebSocket extends EventTarget {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readonly url: string
      readyState = FixtureWebSocket.OPEN
      constructor(url: string | URL, protocols?: string | string[]) {
        super()
        this.url = String(url)
        if (!this.url.includes("/api/codex")) return new NativeWebSocket(url, protocols) as unknown as FixtureWebSocket
        setTimeout(() => this.dispatchEvent(new Event("open")), 0)
      }
      send(raw: string) {
        const request = JSON.parse(raw)
        fixture.requests.push({ method: request.method, params: request.params, configured: fixture.configured })
        const reply = (value: unknown) => setTimeout(() => {
          if (this.readyState === FixtureWebSocket.OPEN) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }))
        }, 0)
        const result = (value: unknown) => reply({ id: request.id, result: value })
        if (request.method === "genio/runtime/start") {
          reply({ method: "genio/codexReady", params: {} })
          return
        }
        if (mode && request.method === "genio/runtime/ensure") {
          if (mode === "headless-delayed") {
            fixture.releaseHeadless = () => reply({ method: "genio/runtime/ready", params: details("headless") })
            return
          }
          if (mode === "headless-disconnect" && !fixture.disconnected) {
            fixture.dropConnection = () => {
              fixture.disconnected = true
              this.close()
            }
            return
          }
          reply({ method: "genio/runtime/ready", params: details("headless") })
          return
        }
        if (typeof request.id !== "number") return
        if (!mode) return result({})
        switch (request.method) {
          case "genio/runtime/status": return result({ active, tiers: { [active.tier]: active } })
          case "genio/bot/select": return result({ modelDirectory: "genio-gateway", models: [{ publicModelId: "fixture-model", displayName: "Fixture" }] })
          case "skills/list": return result({ data: [] })
          case "account/read": return result({ account: { type: "chatgpt" } })
          case "model/list": return result({ data: [{ id: "fixture-model", displayName: "Fixture", supportedReasoningEfforts: [] }] })
          case "thread/start":
          case "thread/resume": {
            if (mode === "desktop-denied" && request.params.environments?.length && !fixture.rejected) {
              fixture.rejected = true
              return reply({ id: request.id, error: { code: "DEFAULT_DENY", message: "DEFAULT_DENY" } })
            }
            const response = { id: request.id, result: { thread: { id: `fixture-thread-${++fixture.thread}`, turns: [] } } }
            setTimeout(() => {
              if (this.readyState !== FixtureWebSocket.OPEN) return
              fixture.configured = Boolean(request.params.environments?.length)
              this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(response) }))
            }, request.params.environments?.length ? 30 : 0)
            return
          }
          case "thread/turns/list": return result({ data: [], nextCursor: null })
          case "mcpServerStatus/list": return result({ data: [] })
          case "genio/thread/pending": return result([])
          default: return result({})
        }
      }
      close() {
        this.readyState = FixtureWebSocket.CLOSED
        this.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "FIXTURE_CLOSED" }))
      }
    }
    window.WebSocket = FixtureWebSocket as unknown as typeof WebSocket
  }, runtimeMode)
  await page.route("**/v1/identity/session", (route) => route.fulfill({ json: {
    tenant_id: "tenant-ui-test", subject_id: "fixture-owner", display_name: "測試擁有者", email: "fixture@example.com", acting_client_id: "genio-one-bot", role: "USER", organization_ids: ["tenant-ui-test"], scopes: [],
  } }))
  await page.route("**/v1/tenants/tenant-ui-test/catalog", (route) => route.fulfill({ json: {
    tenant_id: "tenant-ui-test", catalog_revision: "fixture", subject_id: "fixture-owner", subject_display_name: "測試擁有者", capabilities: [],
  } }))
  await page.route("**/api/bots/roster", (route) => route.fulfill({ json: [{
    bot: currentBot(),
    session: { botId: currentBot().id, appServerThreadId: null, codexHomeNamespace: "fixture", activeRuntimeTier: "none", memoryPointer: null, unread: false, workState: "idle", updatedAt: Date.now(), lastEventAt: Date.now() },
    summary: { preview: "Fixture Bot" },
  }] }))
  await page.route("**/api/bot-groups", (route) => route.fulfill({ json: [] }))
  await page.route("**/api/bots", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: [currentBot()] })
    return route.fulfill({ json: currentBot() })
  })
}

async function openSettings(page: Page, language: "en" | "zh-TW" = "zh-TW") {
  await page.goto(language === "en" ? "/?lang=en" : "/")
  await expect(page.getByTestId("workspace")).toBeVisible()
  await page.getByRole("button", { name: "測試擁有者" }).click()
  const settingsLabel = language === "en" ? "Bot settings" : "Bot 設定"
  await page.getByTestId("bot-roster").getByRole("button", { name: settingsLabel, exact: true }).click()
  await expect(page.getByRole("dialog", { name: new RegExp(settingsLabel) })).toBeVisible()
}


async function runtimeFixture(page: Page, mode: "headless" | "headless-delayed" | "headless-disconnect" | "desktop-denied") {
  await seedProductionFixture(page, () => ({ ...bot, modelRoute: "genio-gateway" }), mode)
  await page.route(`**/api/bots/${bot.id}/session`, (route) => route.fulfill({ json: { botId: bot.id, appServerThreadId: null, activeRuntimeTier: "none" } }))
  for (const suffix of ["execution-segments", "timeline", "artifacts"]) {
    await page.route(`**/api/bots/${bot.id}/${suffix}`, (route) => route.fulfill({ json: [] }))
  }
  await page.goto("/")
  await expect(page.getByTestId("workspace")).toBeVisible()
}

async function nativeRequests(page: Page) {
  return page.evaluate(() => (window as any).__codexFixture.requests as Array<{ method: string; params: any; configured: boolean }>)
}

test("fixture rendered regression: owned Skill readback identifiers do not request a workspace", async ({ page }) => {
  await runtimeFixture(page, "desktop-denied")
  const task = "Final C1 readback. Use only genio_bot read_self and read_owned_skill for uat-default-tools-model-write-20260921-b. Reply with current profile revision, Skill revision, and GENIO_FINAL_C1_READBACK_20260921_R2."
  await page.locator("textarea").fill(task)
  await page.getByRole("button", { name: "送出", exact: true }).click()
  await expect.poll(async () => (await nativeRequests(page)).filter((request) => request.method === "turn/start").length).toBe(1)
  const requests = await nativeRequests(page)
  expect(requests.some((request) => request.method === "genio/runtime/ensure")).toBe(false)
  expect(requests.find((request) => request.method === "turn/start")?.params.environments).toEqual([])
  await expect(page.locator("[data-message-id]").getByText(task, { exact: true })).toBeVisible()
})

test("fixture rendered regression: retained Headless prepares before dispatching the workspace task", async ({ page }) => {
  await runtimeFixture(page, "headless")
  await expect.poll(async () => (await nativeRequests(page)).filter((r) => r.method === "thread/start").length).toBe(1)
  expect((await nativeRequests(page)).find((r) => r.method === "thread/start")?.params.environments).toEqual([])
  await page.locator("textarea").fill("請建立 report.html 檔案")
  await page.getByRole("button", { name: "送出", exact: true }).click()
  await expect.poll(async () => (await nativeRequests(page)).filter((r) => r.method === "turn/start").length).toBe(1)
  const requests = await nativeRequests(page)
  const configured = requests.findIndex((r) => (r.method === "thread/start" || r.method === "thread/resume") && r.params.environments?.length)
  const turn = requests.findIndex((r) => r.method === "turn/start")
  expect(configured).toBeGreaterThan(-1)
  expect(turn).toBeGreaterThan(configured)
  expect(requests[turn]!.configured).toBe(true)
  expect(requests[turn]!.params.environments).toEqual([{ environmentId: "headless-fixture", cwd: "/workspaces/bot-ui-test", runtimeWorkspaceRoots: ["/workspaces/bot-ui-test"] }])
})

test("fixture rendered regression: retains a second workspace prompt while Headless prepares the first", async ({ page }) => {
  await runtimeFixture(page, "headless-delayed")
  let timelineResponses = 0
  page.on("response", (response) => { if (response.url().endsWith(`/api/bots/${bot.id}/timeline`)) timelineResponses++ })
  await expect.poll(async () => (await nativeRequests(page)).filter((r) => r.method === "thread/start").length).toBe(1)
  const input = page.locator("textarea")
  const send = page.getByRole("button", { name: "送出", exact: true })
  const firstTask = "請建立 first-report.html 檔案"
  const secondTask = "請建立 second-report.html 檔案"
  const progress = page.getByText(/正在準備 Headless 工作區/)
  await input.fill(firstTask)
  await send.click()
  await expect(progress).toBeVisible()
  await input.fill(secondTask)
  await send.click()
  await expect(input).toHaveValue(secondTask)
  expect((await nativeRequests(page)).filter((r) => r.method === "turn/start")).toHaveLength(0)
  const pollsBeforeWait = timelineResponses
  await expect.poll(() => timelineResponses).toBeGreaterThanOrEqual(pollsBeforeWait + 2)
  await expect(progress).toBeVisible()

  await expect.poll(() => page.evaluate(() => Boolean((window as any).__codexFixture.releaseHeadless))).toBe(true)
  await page.evaluate(() => (window as any).__codexFixture.releaseHeadless())
  await expect.poll(async () => (await nativeRequests(page)).filter((r) => r.method === "turn/start").length).toBe(1)
  await expect(progress).toHaveCount(0)
  const turn = (await nativeRequests(page)).find((request) => request.method === "turn/start")
  expect(turn?.params.input[0]?.text).toBe(firstTask)
  await expect(input).toHaveValue(secondTask)
})

test("fixture rendered regression: retains an ordinary prompt while Headless prepares the first", async ({ page }) => {
  await runtimeFixture(page, "headless-delayed")
  await expect.poll(async () => (await nativeRequests(page)).filter((r) => r.method === "thread/start").length).toBe(1)
  const input = page.locator("textarea")
  const send = page.getByRole("button", { name: "送出", exact: true })
  const firstTask = "請建立 first-report.html 檔案"
  const secondTask = "請摘要目前可用的工具"
  const progress = page.getByText(/正在準備 Headless 工作區/)
  await input.fill(firstTask)
  await send.click()
  await expect(progress).toBeVisible()
  await input.fill(secondTask)
  await send.click()
  await expect(input).toHaveValue(secondTask)
  expect((await nativeRequests(page)).filter((r) => r.method === "turn/start")).toHaveLength(0)

  await expect.poll(() => page.evaluate(() => Boolean((window as any).__codexFixture.releaseHeadless))).toBe(true)
  await page.evaluate(() => (window as any).__codexFixture.releaseHeadless())
  await expect.poll(async () => (await nativeRequests(page)).filter((r) => r.method === "turn/start").length).toBe(1)
  await expect(progress).toHaveCount(0)
  const turn = (await nativeRequests(page)).find((request) => request.method === "turn/start")
  expect(turn?.params.input[0]?.text).toBe(firstTask)
  await expect(input).toHaveValue(secondTask)
})

test("fixture rendered regression: retains compact while Headless prepares the first", async ({ page }) => {
  await runtimeFixture(page, "headless-delayed")
  await expect.poll(async () => (await nativeRequests(page)).filter((r) => r.method === "thread/start").length).toBe(1)
  const input = page.locator("textarea")
  const send = page.getByRole("button", { name: "送出", exact: true })
  await input.fill("請建立 first-report.html 檔案")
  await send.click()
  await expect(page.getByText(/正在準備 Headless 工作區/)).toBeVisible()
  await input.fill("/compact")
  await send.click()
  await expect(input).toHaveValue("/compact")
  expect((await nativeRequests(page)).filter((r) => r.method === "thread/compact/start")).toHaveLength(0)
})

test("fixture rendered regression: autocomplete compact retains its draft while Headless prepares the first", async ({ page }) => {
  await runtimeFixture(page, "headless-delayed")
  await expect.poll(async () => (await nativeRequests(page)).filter((r) => r.method === "thread/start").length).toBe(1)
  const input = page.locator("textarea")
  const send = page.getByRole("button", { name: "送出", exact: true })
  await input.fill("請建立 first-report.html 檔案")
  await send.click()
  await expect(page.getByText(/正在準備 Headless 工作區/)).toBeVisible()
  for (const selection of ["click", "Tab", "Enter"]) {
    await input.fill("")
    await input.fill("/comp")
    const compact = page.getByRole("button", { name: /\/compact/ })
    await expect(compact).toBeVisible()
    if (selection === "click") await compact.click()
    else await input.press(selection)
    await expect(compact).not.toBeVisible()
    await expect(input).toHaveValue("/comp")
    expect((await nativeRequests(page)).filter((r) => r.method === "thread/compact/start")).toHaveLength(0)
  }
})

test("fixture rendered regression: autocomplete compact runs when no Headless work is pending", async ({ page }) => {
  await runtimeFixture(page, "headless")
  await expect.poll(async () => (await nativeRequests(page)).filter((r) => r.method === "thread/start").length).toBe(1)
  const input = page.locator("textarea")
  await input.fill("/comp")
  await expect(page.getByRole("button", { name: /\/compact/ })).toBeVisible()
  await input.press("Enter")
  await expect(input).toHaveValue("")
  await expect.poll(async () => (await nativeRequests(page)).filter((r) => r.method === "thread/compact/start").length).toBe(1)
})

test("fixture rendered regression: disconnecting provisioning restores the draft before a new Headless task", async ({ page }) => {
  await runtimeFixture(page, "headless-disconnect")
  await expect.poll(async () => (await nativeRequests(page)).filter((r) => r.method === "thread/start").length).toBe(1)
  const input = page.locator("textarea")
  const send = page.getByRole("button", { name: "送出", exact: true })
  const task = "請建立 recovered-report.html 檔案"
  const progress = page.getByText(/正在準備 Headless 工作區/)
  await input.fill(task)
  await send.click()
  await expect(progress).toBeVisible()
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__codexFixture.dropConnection))).toBe(true)
  await page.evaluate(() => (window as any).__codexFixture.dropConnection())
  await expect(input).toHaveValue(task)
  await expect(progress).toHaveCount(0)

  await send.click()
  await expect.poll(async () => (await nativeRequests(page)).filter((r) => r.method === "turn/start").length).toBe(1)
  const turn = (await nativeRequests(page)).find((request) => request.method === "turn/start")
  expect(turn?.params.input[0]?.text).toBe(task)
})

test("fixture rendered regression: denied Headless preserves the task and recovers ordinary chat", async ({ page }) => {
  await runtimeFixture(page, "desktop-denied")
  let timelineResponses = 0
  page.on("response", (response) => { if (response.url().endsWith(`/api/bots/${bot.id}/timeline`)) timelineResponses++ })
  await expect.poll(async () => (await nativeRequests(page)).filter((r) => r.method === "thread/start").length).toBe(1)
  const input = page.locator("textarea")
  const send = page.getByRole("button", { name: "送出", exact: true })
  await input.fill("請建立 report.html 檔案")
  await send.click()
  await expect(page.getByText("Headless 工作區未獲授權；原工作已保留在輸入框，請取得授權後重新送出。")).toBeVisible()
  const pollsBeforeWait = timelineResponses
  await expect.poll(() => timelineResponses).toBeGreaterThanOrEqual(pollsBeforeWait + 2)
  await expect(page.getByText("Headless 工作區未獲授權；原工作已保留在輸入框，請取得授權後重新送出。")).toBeVisible()
  await expect(input).toHaveValue("請建立 report.html 檔案")
  expect((await nativeRequests(page)).filter((r) => r.method === "turn/start")).toHaveLength(0)
  await input.fill("請摘要可用的工具")
  await expect(send).toBeEnabled()
  await send.click()
  await expect.poll(async () => (await nativeRequests(page)).filter((r) => r.method === "turn/start").length).toBe(1)
  expect((await nativeRequests(page)).find((r) => r.method === "turn/start")?.params.environments).toEqual([])
})

test("fixture rendered regression: create and pause a schedule while retaining edits on conflict", async ({ page }) => {
  let schedule = {
    id: "schedule-fixture", botId: bot.id, prompt: "彙整工單", schedule: { kind: "once", at: "2030-01-02T01:00:00.000Z" }, enabled: true, revision: 1,
    nextRunAt: "2030-01-02T01:00:00.000Z", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  }
  let rejectUpdate = false
  let deferReload = false
  let signalReloadStarted: () => void
  let releaseReload: () => void
  const reloadStarted = new Promise<void>((resolve) => { signalReloadStarted = resolve })
  const delayedReload = new Promise<void>((resolve) => { releaseReload = resolve })
  const updateRevisions: number[] = []
  await seedProductionFixture(page)
  await page.route(`**/api/bots/${bot.id}/default-tools/*`, async (route) => {
    const tool = route.request().url().split("/").pop()
    const args = route.request().postDataJSON() as Record<string, unknown>
    if (tool === "list_schedules") {
      if (deferReload) {
        signalReloadStarted()
        await delayedReload
      }
      return route.fulfill({ json: result({ schedules: schedule ? [schedule] : [], runs: [] }) })
    }
    if (tool === "create_schedule") {
      schedule = { ...schedule, prompt: String(args.prompt), schedule: args.schedule as typeof schedule.schedule, revision: 1 }
      return route.fulfill({ json: result({ schedule, created: true }) })
    }
    if (tool === "update_schedule") {
      updateRevisions.push(Number(args.expectedRevision))
      if (rejectUpdate) return route.fulfill({ json: failure("BOT_SCHEDULE_CHANGED") })
      schedule = { ...schedule, enabled: typeof args.enabled === "boolean" ? args.enabled : schedule.enabled, prompt: typeof args.prompt === "string" ? args.prompt : schedule.prompt, schedule: args.schedule as typeof schedule.schedule ?? schedule.schedule, revision: schedule.revision + 1 }
      return route.fulfill({ json: result({ schedule }) })
    }
    if (tool === "delete_schedule") return route.fulfill({ json: result({ scheduleId: schedule.id, deleted: true }) })
    return route.fulfill({ json: failure("UNEXPECTED_FIXTURE_TOOL") })
  })

  await openSettings(page)
  await page.getByRole("button", { name: "排程", exact: true }).click()
  await page.getByRole("button", { name: "新增排程" }).click()
  await page.getByLabel("要讓 Bot 執行的工作").fill("彙整工單")
  await page.getByLabel("日期與時間").fill("2030-01-02T09:00")
  await page.getByRole("button", { name: "儲存排程" }).click()
  await expect(page.getByText("排程已儲存。到期且仍獲授權時才會執行。")).toBeVisible()
  await page.getByRole("button", { name: "暫停" }).click()
  await expect(page.getByText("已暫停")).toBeVisible()
  await page.getByRole("button", { name: "編輯" }).click()
  await page.getByLabel("要讓 Bot 執行的工作").fill("切換前尚未儲存的內容")
  page.once("dialog", (dialog) => void dialog.dismiss())
  await page.getByRole("button", { name: "新增排程" }).click()
  await expect(page.getByLabel("要讓 Bot 執行的工作")).toHaveValue("切換前尚未儲存的內容")
  page.once("dialog", (dialog) => void dialog.accept())
  await page.getByRole("button", { name: "新增排程" }).click()
  await expect(page.getByLabel("要讓 Bot 執行的工作")).toHaveValue("")
  await page.getByRole("button", { name: "取消" }).click()
  await page.getByRole("button", { name: "編輯" }).click()
  await page.getByLabel("要讓 Bot 執行的工作").fill("衝突後仍保留的內容")
  rejectUpdate = true
  await page.getByRole("button", { name: "儲存變更" }).click()
  await expect(page.getByText("此排程已在其他地方更新")).toBeVisible()
  await expect(page.getByLabel("要讓 Bot 執行的工作")).toHaveValue("衝突後仍保留的內容")
  schedule = { ...schedule, prompt: "其他人已更新", schedule: { kind: "recurring", frequency: "daily", time: "15:30", timezone: "Asia/Tokyo" }, revision: 9 }
  rejectUpdate = false
  deferReload = true
  const firstReload = page.getByRole("button", { name: "重新載入最新版本" }).click()
  await reloadStarted
  await page.getByLabel("要讓 Bot 執行的工作").fill("重新載入期間的草稿")
  deferReload = false
  releaseReload()
  await firstReload
  await expect(page.getByText("已載入最新排程版本")).toBeVisible()
  await expect(page.getByLabel("要讓 Bot 執行的工作")).toHaveValue("重新載入期間的草稿")
  await expect(page.locator('input[type="time"]')).toHaveValue("15:30")
  await expect(page.getByLabel("時區")).toHaveValue("Asia/Tokyo")
  rejectUpdate = true
  await page.getByRole("button", { name: "儲存變更" }).click()
  await expect(page.getByText("此排程已在其他地方更新")).toBeVisible()
  schedule = { ...schedule, prompt: "第二次遠端更新", schedule: { kind: "recurring", frequency: "daily", time: "17:45", timezone: "Europe/London" }, revision: 10 }
  rejectUpdate = false
  await page.getByRole("button", { name: "重新載入最新版本" }).click()
  await expect(page.getByLabel("要讓 Bot 執行的工作")).toHaveValue("重新載入期間的草稿")
  await expect(page.locator('input[type="time"]')).toHaveValue("17:45")
  await expect(page.getByLabel("時區")).toHaveValue("Europe/London")
  await page.getByRole("button", { name: "儲存變更" }).click()
  await expect(page.getByText("已儲存。下一次符合條件的執行會使用此排程。")).toBeVisible()
  expect(updateRevisions).toContain(9)
  expect(updateRevisions).toContain(10)
  await page.screenshot({ path: "test-results/default-tools-schedule-conflict.png", fullPage: true })
})

test("fixture rendered regression: create, edit, revert an owned Skill and preserve conflict edits", async ({ page }) => {
  let skill: { skillName: string; revision: number; files: Array<{ path: string; content: string }>; createdAt: number; updatedAt: number } | null = null
  let revisions: Array<{ revision: number; updatedAt: number; deleted: boolean }> = []
  let rejectWrite = false
  await seedProductionFixture(page)
  await page.route(`**/api/bots/${bot.id}/default-tools/*`, async (route) => {
    const tool = route.request().url().split("/").pop()
    const args = route.request().postDataJSON() as { skillName?: string; files?: Record<string, string>; revision?: number }
    if (tool === "list_owned_skills") return route.fulfill({ json: result({ skills: skill ? [{ skillName: skill.skillName, revision: skill.revision, updatedAt: skill.updatedAt }] : [] }) })
    if (tool === "read_owned_skill") {
      if (!skill) return route.fulfill({ json: failure("OWNED_SKILL_NOT_FOUND") })
      return route.fulfill({ json: result({ skill, revisions }) })
    }
    if (tool === "write_owned_skill") {
      if (rejectWrite) return route.fulfill({ json: failure("OWNED_SKILL_REVISION_CONFLICT") })
      const nextRevision = (skill?.revision ?? 0) + 1
      skill = { skillName: args.skillName!, revision: nextRevision, files: Object.entries(args.files ?? {}).map(([path, content]) => ({ path, content })), createdAt: skill?.createdAt ?? Date.now(), updatedAt: Date.now() }
      revisions = [{ revision: nextRevision, updatedAt: skill.updatedAt, deleted: false }, ...revisions]
      return route.fulfill({ json: result({ skill, pendingApply: true, applyState: "PENDING_RUNTIME_REFRESH" }) })
    }
    if (tool === "revert_owned_skill") {
      const source = revisions.find((item) => item.revision === args.revision)
      if (!source || !skill) return route.fulfill({ json: failure("OWNED_SKILL_REVISION_NOT_FOUND") })
      skill = { ...skill, revision: skill.revision + 1, updatedAt: Date.now() }
      revisions = [{ revision: skill.revision, updatedAt: skill.updatedAt, deleted: false }, ...revisions]
      return route.fulfill({ json: result({ skill, pendingApply: true, applyState: "PENDING_RUNTIME_REFRESH" }) })
    }
    return route.fulfill({ json: failure("UNEXPECTED_FIXTURE_TOOL") })
  })

  await openSettings(page)
  await page.getByRole("button", { name: "專屬技能" }).click()
  await page.getByPlaceholder("release-check").fill("release-check")
  await page.getByPlaceholder("簡短說明").fill("發布前檢查")
  await page.getByRole("button", { name: "建立", exact: true }).click()
  await expect(page.getByRole("button", { name: "儲存", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "儲存", exact: true }).click()
  await expect(page.getByText("已儲存版本 1。Bot 下次工作時會載入。")).toBeVisible()
  const source = page.getByRole("textbox", { name: "SKILL.md", exact: true })
  await source.fill("---\nname: release-check\ndescription: 發布前檢查\n---\n\n# 第一版\n")
  await page.getByRole("button", { name: "儲存", exact: true }).click()
  await expect(page.getByText("已儲存版本 2。Bot 下次工作時會載入。")).toBeVisible()
  await source.fill("---\nname: release-check\ndescription: 發布前檢查\n---\n\n# 第二版\n")
  await page.getByRole("button", { name: "儲存", exact: true }).click()
  await expect(page.getByText("已儲存版本 3。Bot 下次工作時會載入。")).toBeVisible()
  await page.getByRole("button", { name: "回復至 v1" }).click()
  await expect(page.getByText("已回復並儲存為版本 4。Bot 下次工作時會載入。")).toBeVisible()
  await source.fill("---\nname: release-check\ndescription: 發布前檢查\n---\n\n# 尚未儲存\n")
  await page.getByPlaceholder("release-check").fill("other-skill")
  page.once("dialog", (dialog) => void dialog.dismiss())
  await page.getByRole("button", { name: "建立", exact: true }).click()
  await expect(source).toHaveValue(/尚未儲存/)
  await source.fill("---\nname: release-check\ndescription: 發布前檢查\n---\n\n# 衝突修改\n")
  rejectWrite = true
  await page.getByRole("button", { name: "儲存", exact: true }).click()
  await expect(page.getByText("此 Skill 已在其他地方更新")).toBeVisible()
  await expect(source).toHaveValue(/衝突修改/)
  page.once("dialog", (dialog) => void dialog.dismiss())
  await page.getByRole("button", { name: "重新載入已儲存 Skill" }).click()
  await expect(source).toHaveValue(/衝突修改/)
  page.once("dialog", (dialog) => void dialog.accept())
  await page.getByRole("button", { name: "重新載入已儲存 Skill" }).click()
  await expect(source).not.toHaveValue(/衝突修改/)
  await page.screenshot({ path: "test-results/default-tools-owned-skill-conflict.png", fullPage: true })
})

test("fixture rendered regression: locks an owned Skill while save, revert, or create lookup is pending", async ({ page }) => {
  let skill = { skillName: "release-check", revision: 2, files: [{ path: "SKILL.md", content: "---\nname: release-check\ndescription: Release checks\n---\n\n# Release\n" }], createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }
  const revisions = [{ revision: 1, updatedAt: 1_699_000_000_000, deleted: false }]
  let deferred = ""
  let signalStarted: (() => void) | undefined
  let releaseRequest: (() => void) | undefined
  let pendingRequest = Promise.resolve()
  const defer = (tool: string) => {
    deferred = tool
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    pendingRequest = new Promise<void>((resolve) => { releaseRequest = resolve })
    return { started, release: () => { deferred = ""; releaseRequest?.() } }
  }
  await seedProductionFixture(page)
  await page.route(`**/api/bots/${bot.id}/default-tools/*`, async (route) => {
    const tool = route.request().url().split("/").pop()
    const args = route.request().postDataJSON() as { skillName?: string; files?: Record<string, string> }
    if (tool === "list_owned_skills") return route.fulfill({ json: result({ skills: [{ skillName: skill.skillName, revision: skill.revision, updatedAt: skill.updatedAt }] }) })
    if (tool === "read_owned_skill") {
      if (args.skillName === "new-skill" && deferred === "lookup") {
        signalStarted?.()
        await pendingRequest
        return route.fulfill({ json: failure("OWNED_SKILL_NOT_FOUND") })
      }
      return route.fulfill({ json: result({ skill, revisions }) })
    }
    if (tool === "write_owned_skill") {
      if (deferred === "write") {
        signalStarted?.()
        await pendingRequest
      }
      skill = { ...skill, revision: skill.revision + 1, files: Object.entries(args.files ?? {}).map(([path, content]) => ({ path, content })), updatedAt: Date.now() }
      return route.fulfill({ json: result({ skill, pendingApply: true, applyState: "PENDING_RUNTIME_REFRESH" }) })
    }
    if (tool === "revert_owned_skill") {
      if (deferred === "revert") {
        signalStarted?.()
        await pendingRequest
      }
      skill = { ...skill, revision: skill.revision + 1, updatedAt: Date.now() }
      return route.fulfill({ json: result({ skill, pendingApply: true, applyState: "PENDING_RUNTIME_REFRESH" }) })
    }
    return route.fulfill({ json: failure("UNEXPECTED_FIXTURE_TOOL") })
  })

  await openSettings(page)
  await page.getByRole("button", { name: "專屬技能" }).click()
  await page.getByRole("button", { name: "release-check" }).click()
  const source = page.getByRole("textbox", { name: "SKILL.md", exact: true })
  await source.fill("---\nname: release-check\ndescription: Release checks\n---\n\n# Edited\n")
  const save = defer("write")
  await page.getByRole("button", { name: "儲存", exact: true }).click()
  await save.started
  await expect(source).toBeDisabled()
  await expect(page.locator(".owned-skill-file-controls select")).toBeDisabled()
  await expect(page.getByRole("button", { name: "新增", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "release-check" })).toBeDisabled()
  save.release()
  await expect(page.getByText("已儲存版本 3。Bot 下次工作時會載入。")).toBeVisible()

  const revert = defer("revert")
  await page.getByRole("button", { name: "回復至 v1" }).click()
  await revert.started
  await expect(source).toBeDisabled()
  await expect(page.getByRole("button", { name: "release-check" })).toBeDisabled()
  revert.release()
  await expect(page.getByText("已回復並儲存為版本 4。Bot 下次工作時會載入。")).toBeVisible()

  await page.getByPlaceholder("release-check").fill("new-skill")
  const lookup = defer("lookup")
  await page.getByRole("button", { name: "建立", exact: true }).click()
  await lookup.started
  await expect(source).toBeDisabled()
  await expect(page.getByPlaceholder("release-check")).toBeDisabled()
  await expect(page.getByRole("button", { name: "release-check" })).toHaveCount(0)
  lookup.release()
  await expect(page.getByText("新的 Skill 已可編輯。完成指引後請儲存。")).toBeVisible()
  await expect(page.getByText("new-skill", { exact: true })).toBeVisible()
})

test("fixture rendered regression: a deleted Skill name recreates from its tombstone revision", async ({ page }) => {
  let tombstone = true
  const revisions: number[] = []
  await seedProductionFixture(page)
  await page.route(`**/api/bots/${bot.id}/default-tools/*`, async (route) => {
    const tool = route.request().url().split("/").pop()
    const args = route.request().postDataJSON() as { expectedRevision?: number; skillName?: string; files?: Record<string, string> }
    if (tool === "list_owned_skills") return route.fulfill({ json: result({ skills: tombstone ? [] : [{ skillName: "release-check", revision: 4, updatedAt: Date.now() }] }) })
    if (tool === "read_owned_skill") {
      if (tombstone) return route.fulfill({ json: result({ skill: { skillName: "release-check", revision: 3, deleted: true, files: [], updatedAt: Date.now() }, revisions: [{ revision: 3, updatedAt: Date.now(), deleted: true }] }) })
      return route.fulfill({ json: result({ skill: { skillName: "release-check", revision: 4, files: Object.entries(args.files ?? {}).map(([path, content]) => ({ path, content })), updatedAt: Date.now() }, revisions: [{ revision: 4, updatedAt: Date.now(), deleted: false }] }) })
    }
    if (tool === "write_owned_skill") {
      revisions.push(args.expectedRevision ?? -1)
      tombstone = false
      return route.fulfill({ json: result({ skill: { skillName: args.skillName, revision: 4, files: Object.entries(args.files ?? {}).map(([path, content]) => ({ path, content })), updatedAt: Date.now() }, pendingApply: true, applyState: "PENDING_RUNTIME_REFRESH" }) })
    }
    return route.fulfill({ json: failure("UNEXPECTED_FIXTURE_TOOL") })
  })
  await openSettings(page)
  await page.getByRole("button", { name: "專屬技能" }).click()
  await page.getByPlaceholder("release-check").fill("release-check")
  await page.getByRole("button", { name: "建立", exact: true }).click()
  await expect(page.getByText("已載入先前刪除的 Skill 版本，可重新建立")).toBeVisible()
  await expect(page.getByRole("button", { name: "儲存", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "儲存", exact: true }).click()
  await expect(page.getByText("已儲存版本 4。Bot 下次工作時會載入。")).toBeVisible()
  expect(revisions).toEqual([3])
})

test("fixture rendered regression: keeps an owned Skill draft through tabs and guards every settings close path", async ({ page }) => {
  await seedProductionFixture(page)
  await page.route(`**/api/bots/${bot.id}/default-tools/*`, async (route) => {
    const tool = route.request().url().split("/").pop()
    const args = route.request().postDataJSON() as { skillName?: string }
    if (tool === "list_owned_skills") return route.fulfill({ json: result({ skills: [] }) })
    if (tool === "read_owned_skill" && args.skillName === "draft-skill") return route.fulfill({ json: failure("OWNED_SKILL_NOT_FOUND") })
    return route.fulfill({ json: failure("UNEXPECTED_FIXTURE_TOOL") })
  })
  await openSettings(page)
  await page.getByRole("button", { name: "專屬技能" }).click()
  await page.getByPlaceholder("release-check").fill("draft-skill")
  await page.getByRole("button", { name: "建立", exact: true }).click()
  const source = page.getByRole("textbox", { name: "SKILL.md", exact: true })
  await source.fill("---\nname: draft-skill\ndescription: Draft\n---\n\n# Keep this draft\n")
  await page.getByRole("button", { name: "基本資料" }).click()
  await expect(source).not.toBeVisible()
  await page.getByRole("button", { name: "專屬技能" }).click()
  await expect(source).toHaveValue(/Keep this draft/)

  page.once("dialog", (dialog) => void dialog.dismiss())
  await page.getByRole("button", { name: "關閉設定" }).click()
  await expect(page.getByRole("dialog", { name: /Bot 設定/ })).toHaveCount(1)
  page.once("dialog", (dialog) => void dialog.dismiss())
  await page.locator(".profile-dialog-backdrop").click({ position: { x: 2, y: 2 } })
  await expect(page.getByRole("dialog", { name: /Bot 設定/ })).toHaveCount(1)
  page.once("dialog", (dialog) => void dialog.dismiss())
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: /Bot 設定/ })).toHaveCount(1)
  page.once("dialog", (dialog) => void dialog.accept())
  await page.getByRole("button", { name: "關閉設定" }).click()
  await expect(page.getByRole("dialog", { name: /Bot 設定/ })).toHaveCount(0)
})

test("fixture rendered regression: locks schedule controls until save and readback complete", async ({ page }) => {
  let signalStarted: (() => void) | undefined
  let releaseRequest: (() => void) | undefined
  const saveStarted = new Promise<void>((resolve) => { signalStarted = resolve })
  const saveReleased = new Promise<void>((resolve) => { releaseRequest = resolve })
  let schedule: Record<string, unknown> | null = null
  await seedProductionFixture(page)
  await page.route(`**/api/bots/${bot.id}/default-tools/*`, async (route) => {
    const tool = route.request().url().split("/").pop()
    const args = route.request().postDataJSON() as { prompt?: string; schedule?: unknown }
    if (tool === "list_schedules") return route.fulfill({ json: result({ schedules: schedule ? [schedule] : [], runs: [] }) })
    if (tool === "create_schedule") {
      signalStarted?.()
      await saveReleased
      schedule = { id: "schedule-lock", botId: bot.id, prompt: args.prompt, schedule: args.schedule, enabled: true, revision: 1, nextRunAt: null, createdAt: Date.now(), updatedAt: Date.now() }
      return route.fulfill({ json: result({ schedule, created: true }) })
    }
    return route.fulfill({ json: failure("UNEXPECTED_FIXTURE_TOOL") })
  })
  await openSettings(page)
  await page.getByRole("button", { name: "排程", exact: true }).click()
  await page.getByLabel("要讓 Bot 執行的工作").fill("延遲儲存的排程")
  await page.getByLabel("日期與時間").fill("2030-01-02T09:00")
  await page.getByRole("button", { name: "儲存排程" }).click()
  await saveStarted
  await expect(page.getByLabel("要讓 Bot 執行的工作")).toBeDisabled()
  await expect(page.getByLabel("日期與時間")).toBeDisabled()
  await expect(page.getByRole("button", { name: "取消" }).last()).toBeDisabled()
  await expect(page.getByRole("button", { name: "關閉設定" })).toBeDisabled()
  releaseRequest?.()
  await expect(page.getByText("排程已儲存。到期且仍獲授權時才會執行。")).toBeVisible()
})

test("fixture rendered regression: locks the profile form while its save is pending", async ({ page }) => {
  let signalStarted: (() => void) | undefined
  let releaseRequest: (() => void) | undefined
  const saveStarted = new Promise<void>((resolve) => { signalStarted = resolve })
  const saveReleased = new Promise<void>((resolve) => { releaseRequest = resolve })
  await seedProductionFixture(page)
  await page.route(`**/api/bots/${bot.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fulfill({ json: bot })
    signalStarted?.()
    await saveReleased
    return route.fulfill({ json: bot })
  })
  await openSettings(page)
  await page.getByLabel("職稱／主要工作（title／job）").fill("等待儲存的職稱")
  await page.getByRole("button", { name: "儲存變更" }).click()
  await saveStarted
  await expect(page.getByLabel("職稱／主要工作（title／job）")).toBeDisabled()
  await expect(page.getByRole("button", { name: "關閉設定" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "專屬技能" })).toBeDisabled()
  releaseRequest?.()
  await expect(page.getByRole("dialog", { name: /Bot 設定/ })).toHaveCount(0)
})

test("fixture rendered regression: profile save keeps settings open when an owned Skill draft needs confirmation", async ({ page }) => {
  await seedProductionFixture(page)
  await page.route(`**/api/bots/${bot.id}/default-tools/*`, async (route) => {
    const tool = route.request().url().split("/").pop()
    const args = route.request().postDataJSON() as { skillName?: string }
    if (tool === "list_owned_skills") return route.fulfill({ json: result({ skills: [] }) })
    if (tool === "read_owned_skill" && args.skillName === "profile-draft") return route.fulfill({ json: failure("OWNED_SKILL_NOT_FOUND") })
    return route.fulfill({ json: failure("UNEXPECTED_FIXTURE_TOOL") })
  })
  await page.route(`**/api/bots/${bot.id}`, (route) => route.fulfill({ json: bot }))
  await openSettings(page)
  await page.getByRole("button", { name: "專屬技能" }).click()
  await page.getByPlaceholder("release-check").fill("profile-draft")
  await page.getByRole("button", { name: "建立", exact: true }).click()
  await page.getByRole("textbox", { name: "SKILL.md", exact: true }).fill("---\nname: profile-draft\ndescription: Draft\n---\n\n# Keep\n")
  await page.getByRole("button", { name: "基本資料" }).click()
  await page.getByLabel("職稱／主要工作（title／job）").fill("儲存基本資料")
  page.once("dialog", (dialog) => void dialog.dismiss())
  await page.getByRole("button", { name: "儲存變更" }).click()
  await expect(page.getByRole("dialog", { name: /Bot 設定/ })).toHaveCount(1)
  await expect(page.getByLabel("職稱／主要工作（title／job）")).toHaveValue("儲存基本資料")
})

test("fixture rendered regression: locks a clean owned Skill while the installed-Skills save is pending", async ({ page }) => {
  let signalStarted: (() => void) | undefined
  let releaseRequest: (() => void) | undefined
  const saveStarted = new Promise<void>((resolve) => { signalStarted = resolve })
  const saveReleased = new Promise<void>((resolve) => { releaseRequest = resolve })
  const skill = { skillName: "clean-skill", revision: 1, files: [{ path: "SKILL.md", content: "---\nname: clean-skill\ndescription: Clean\n---\n\n# Clean\n" }], updatedAt: Date.now() }
  await seedProductionFixture(page)
  await page.route(`**/api/bots/${bot.id}/default-tools/*`, async (route) => {
    const tool = route.request().url().split("/").pop()
    if (tool === "list_owned_skills") return route.fulfill({ json: result({ skills: [{ skillName: skill.skillName, revision: skill.revision, updatedAt: skill.updatedAt }] }) })
    if (tool === "read_owned_skill") return route.fulfill({ json: result({ skill, revisions: [] }) })
    return route.fulfill({ json: failure("UNEXPECTED_FIXTURE_TOOL") })
  })
  await page.route(`**/api/bots/${bot.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fulfill({ json: bot })
    signalStarted?.()
    await saveReleased
    return route.fulfill({ json: bot })
  })
  await openSettings(page)
  await page.getByRole("button", { name: "專屬技能" }).click()
  await page.getByRole("button", { name: "clean-skill" }).click()
  const source = page.getByRole("textbox", { name: "SKILL.md", exact: true })
  await expect(source).toBeEnabled()
  await page.getByRole("button", { name: "儲存技能設定" }).click()
  await saveStarted
  await expect(source).toBeDisabled()
  await expect(page.getByRole("button", { name: "clean-skill" })).toBeDisabled()
  releaseRequest?.()
  await expect(page.getByRole("dialog", { name: /Bot 設定/ })).toHaveCount(0)
})

test("fixture rendered regression: preserves a schedule draft across tabs and confirms before settings close", async ({ page }) => {
  await seedProductionFixture(page)
  await page.route(`**/api/bots/${bot.id}/default-tools/list_schedules`, (route) => route.fulfill({ json: result({ schedules: [], runs: [] }) }))
  await openSettings(page)
  await page.getByRole("button", { name: "排程", exact: true }).click()
  await page.getByLabel("要讓 Bot 執行的工作").fill("保留中的排程草稿")
  await page.getByLabel("日期與時間").fill("2030-01-02T09:00")
  await page.getByRole("button", { name: "基本資料" }).click()
  await page.getByRole("button", { name: "排程", exact: true }).click()
  await expect(page.getByLabel("要讓 Bot 執行的工作")).toHaveValue("保留中的排程草稿")
  page.once("dialog", (dialog) => void dialog.dismiss())
  await page.getByRole("button", { name: "關閉設定" }).click()
  await expect(page.getByRole("dialog", { name: /Bot 設定/ })).toHaveCount(1)
})

test("fixture rendered regression: confirms Skill drafts before deleting a Bot", async ({ page }) => {
  let deletes = 0
  await seedProductionFixture(page)
  await page.route(`**/api/bots/${bot.id}/default-tools/*`, async (route) => {
    const tool = route.request().url().split("/").pop()
    const args = route.request().postDataJSON() as { skillName?: string }
    if (tool === "list_owned_skills") return route.fulfill({ json: result({ skills: [] }) })
    if (tool === "read_owned_skill" && args.skillName === "delete-draft") return route.fulfill({ json: failure("OWNED_SKILL_NOT_FOUND") })
    return route.fulfill({ json: failure("UNEXPECTED_FIXTURE_TOOL") })
  })
  await page.route(`**/api/bots/${bot.id}`, async (route) => {
    if (route.request().method() === "DELETE") {
      deletes++
      return route.fulfill({ json: {} })
    }
    return route.fulfill({ json: bot })
  })
  await openSettings(page)
  await page.getByRole("button", { name: "專屬技能" }).click()
  await page.getByPlaceholder("release-check").fill("delete-draft")
  await page.getByRole("button", { name: "建立", exact: true }).click()
  await page.getByRole("textbox", { name: "SKILL.md", exact: true }).fill("---\nname: delete-draft\ndescription: Draft\n---\n\n# Keep\n")
  await page.getByRole("button", { name: "基本資料" }).click()
  page.once("dialog", (dialog) => void dialog.dismiss())
  await page.getByRole("button", { name: "刪除 Bot" }).click()
  await expect(page.getByRole("dialog", { name: /Bot 設定/ })).toHaveCount(1)
  expect(deletes).toBe(0)
  let confirmation = 0
  page.on("dialog", (dialog) => {
    confirmation++
    void (confirmation === 1 ? dialog.accept() : dialog.dismiss())
  })
  await page.getByRole("button", { name: "刪除 Bot" }).click()
  expect(deletes).toBe(0)
})

test("fixture rendered regression: blocks profile save while an owned Skill is saving", async ({ page }) => {
  let signalStarted: (() => void) | undefined
  let releaseRequest: (() => void) | undefined
  const writeStarted = new Promise<void>((resolve) => { signalStarted = resolve })
  const writeReleased = new Promise<void>((resolve) => { releaseRequest = resolve })
  const skill = { skillName: "busy-skill", revision: 1, files: [{ path: "SKILL.md", content: "---\nname: busy-skill\ndescription: Busy\n---\n\n# Busy\n" }], updatedAt: Date.now() }
  await seedProductionFixture(page)
  await page.route(`**/api/bots/${bot.id}/default-tools/*`, async (route) => {
    const tool = route.request().url().split("/").pop()
    if (tool === "list_owned_skills") return route.fulfill({ json: result({ skills: [{ skillName: skill.skillName, revision: skill.revision, updatedAt: skill.updatedAt }] }) })
    if (tool === "read_owned_skill") return route.fulfill({ json: result({ skill, revisions: [] }) })
    if (tool === "write_owned_skill") {
      signalStarted?.()
      await writeReleased
      return route.fulfill({ json: result({ skill: { ...skill, revision: 2 }, pendingApply: true, applyState: "PENDING_RUNTIME_REFRESH" }) })
    }
    return route.fulfill({ json: failure("UNEXPECTED_FIXTURE_TOOL") })
  })
  await openSettings(page)
  await page.getByRole("button", { name: "專屬技能" }).click()
  await page.getByRole("button", { name: "busy-skill" }).click()
  await page.getByRole("textbox", { name: "SKILL.md", exact: true }).fill("---\nname: busy-skill\ndescription: Busy\n---\n\n# Changed\n")
  await page.getByRole("button", { name: "儲存", exact: true }).click()
  await writeStarted
  await page.getByRole("button", { name: "基本資料" }).click()
  await expect(page.getByRole("button", { name: "儲存變更" })).toBeDisabled()
  releaseRequest?.()
  await expect(page.getByRole("button", { name: "儲存變更" })).toBeEnabled()
})

test("fixture rendered regression: expired default-tools session offers a sign-in action", async ({ page }) => {
  await seedProductionFixture(page)
  await page.route(`**/api/bots/${bot.id}/default-tools/list_schedules`, (route) => route.fulfill({
    status: 401,
    json: { content: [{ type: "text", text: "GENIO_ONE_SESSION_REJECTED" }], isError: true },
  }))
  await openSettings(page)
  await page.getByRole("button", { name: "排程", exact: true }).click()
  await expect(page.getByText("登入已過期，請重新登入後再試。")).toBeVisible()
  await expect(page.getByRole("button", { name: "重新登入" })).toBeVisible()
})

test("fixture rendered regression: retrying a lost schedule-create response reuses its idempotency key", async ({ page }) => {
  let savedSchedule: Record<string, unknown> | null = null
  const requestIds: string[] = []
  let loseFirstResponse = true
  await seedProductionFixture(page)
  await page.route(`**/api/bots/${bot.id}/default-tools/*`, async (route) => {
    const tool = route.request().url().split("/").pop()
    const args = route.request().postDataJSON() as { clientRequestId?: string; prompt?: string; schedule?: unknown }
    if (tool === "list_schedules") return route.fulfill({ json: result({ schedules: savedSchedule ? [savedSchedule] : [], runs: [] }) })
    if (tool === "create_schedule") {
      requestIds.push(args.clientRequestId ?? "")
      savedSchedule ??= { id: "schedule-receipt", botId: bot.id, prompt: args.prompt, schedule: args.schedule, enabled: true, revision: 1, nextRunAt: null, createdAt: Date.now(), updatedAt: Date.now() }
      if (loseFirstResponse) {
        loseFirstResponse = false
        return route.abort("failed")
      }
      return route.fulfill({ json: result({ schedule: savedSchedule, created: false }) })
    }
    return route.fulfill({ json: failure("UNEXPECTED_FIXTURE_TOOL") })
  })
  await openSettings(page)
  await page.getByRole("button", { name: "排程", exact: true }).click()
  await page.getByLabel("要讓 Bot 執行的工作").fill("只建立一次")
  await page.getByLabel("日期與時間").fill("2030-01-02T09:00")
  await page.getByRole("button", { name: "儲存排程" }).click()
  await expect(page.getByText("排程尚未更新")).toBeVisible()
  await page.getByRole("button", { name: "儲存排程" }).click()
  await expect(page.getByText("已確認先前的儲存，沒有建立重複排程。")).toBeVisible()
  expect(requestIds).toHaveLength(2)
  expect(requestIds[0]).toBeTruthy()
  expect(requestIds[1]).toBe(requestIds[0])
})

test("fixture rendered regression: an English profile conflict reloads a fresh revision without roster polling", async ({ page }) => {
  const latest = { ...bot, revision: 7, title: "Latest remote title", description: "Latest remote description", role: "Latest remote description" }
  const revisions: number[] = []
  let freshReadAvailable = false
  let signalFreshReadStarted: () => void
  let releaseFreshRead: () => void
  const freshReadStarted = new Promise<void>((resolve) => { signalFreshReadStarted = resolve })
  const freshRead = new Promise<void>((resolve) => { releaseFreshRead = resolve })
  await seedProductionFixture(page)
  await page.route("**/api/bots", async (route) => {
    if (!freshReadAvailable) return route.fulfill({ json: [bot] })
    signalFreshReadStarted()
    await freshRead
    return route.fulfill({ json: [latest] })
  })
  await page.route(`**/api/bots/${bot.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fulfill({ json: latest })
    const payload = route.request().postDataJSON() as { expectedRevision?: number }
    revisions.push(payload.expectedRevision ?? -1)
    if (revisions.length === 1) {
      freshReadAvailable = true
      return route.fulfill({ status: 409, json: { error: "REVISION_CONFLICT" } })
    }
    return route.fulfill({ json: { ...latest, ...payload } })
  })

  await openSettings(page, "en")
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByText("This Bot changed elsewhere. Use the latest version to reapply your current edits, then save again.")).toBeVisible()
  const rebase = page.getByRole("button", { name: "Use latest version" }).click()
  await freshReadStarted
  await page.getByLabel("Title / primary work").fill("Typed during refresh")
  releaseFreshRead()
  await rebase
  await expect(page.getByText("Latest Bot version loaded. Review your current edits, then save to apply them.")).toBeVisible()
  await expect(page.getByLabel("Title / primary work")).toHaveValue("Typed during refresh")
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByRole("dialog", { name: /Bot settings/ })).toHaveCount(0)
  expect(revisions).toEqual([4, 7])
})

test("fixture rendered regression: profile rebase keeps one draft through tabs and consecutive remote versions", async ({ page }) => {
  test.slow()
  let liveBot = { ...bot, skills: [] as string[], sharePolicy: { visibility: "PRIVATE" as const, discoverable: false, invocable: false, approval: "ALWAYS_ASK" as const, audienceIds: [] as string[] } }
  const payloads: Array<{ expectedRevision?: number; name?: string; title?: string; description?: string; skills?: string[]; sharePolicy?: { discoverable?: boolean } }> = []
  await seedProductionFixture(page, () => liveBot)
  await page.route(`**/api/bots/${bot.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fulfill({ json: liveBot })
    const payload = route.request().postDataJSON() as typeof payloads[number]
    payloads.push(payload)
    liveBot = { ...liveBot, revision: 7, ...payload, name: payload.name ?? liveBot.name }
    return route.fulfill({ json: liveBot })
  })
  await openSettings(page)
  liveBot = {
    ...liveBot,
    revision: 5,
    name: "其他人更新的名稱",
    title: "遠端職稱",
    description: "遠端工作說明",
    role: "遠端工作說明",
    skills: ["doc-search"],
  }
  await expect(page.getByText("已有較新的 Bot 版本")).toBeVisible({ timeout: 12_000 })
  await page.getByLabel("職稱／主要工作（title／job）").fill("我的草稿職稱")
  await page.getByRole("button", { name: "使用最新版本重新套用" }).click()
  await expect(page.getByText("已載入最新 Bot 版本")).toBeVisible()
  await expect(page.getByLabel("工作說明與長期規則（description）")).toHaveValue("遠端工作說明")
  await page.getByRole("button", { name: "分享與 @" }).click()
  await page.getByRole("checkbox", { name: "允許被搜尋" }).check()
  await page.getByRole("button", { name: "基本資料" }).click()
  await expect(page.getByLabel("職稱／主要工作（title／job）")).toHaveValue("我的草稿職稱")
  liveBot = {
    ...liveBot,
    revision: 6,
    name: "第二次遠端名稱",
    title: "第二次遠端職稱",
    description: "第二次遠端工作說明",
    role: "第二次遠端工作說明",
    skills: ["code-review"],
  }
  await expect(page.getByText("已有較新的 Bot 版本")).toBeVisible({ timeout: 12_000 })
  await page.getByRole("button", { name: "使用最新版本重新套用" }).click()
  await expect(page.getByLabel("職稱／主要工作（title／job）")).toHaveValue("我的草稿職稱")
  await expect(page.getByLabel("工作說明與長期規則（description）")).toHaveValue("第二次遠端工作說明")
  await page.getByRole("button", { name: "儲存變更" }).click()
  await expect(page.getByRole("dialog", { name: /Bot 設定/ })).toHaveCount(0)
  expect(payloads).toHaveLength(1)
  expect(payloads[0]).toMatchObject({
    expectedRevision: 6,
    name: "第二次遠端名稱",
    title: "我的草稿職稱",
    description: "第二次遠端工作說明",
    skills: ["code-review"],
    sharePolicy: { discoverable: true },
  })
})
