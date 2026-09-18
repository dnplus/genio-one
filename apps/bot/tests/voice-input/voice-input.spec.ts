import { test, expect } from "@playwright/test"

test("recording appends to the current draft; failure retries; switching cancels late results", async ({ page }) => {
  let fail = false
  let delay = false
  let uploaded = 0
  let release: (() => void) | undefined
  await page.route("**/api/transcription", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { available: true, displayName: "Breeze ASR 25" } })
    expect(route.request().headers()["content-type"]).toContain("audio/webm")
    expect(route.request().postDataBuffer()!.length).toBeGreaterThan(0)
    uploaded++
    if (delay) await new Promise<void>((resolve) => { release = resolve })
    await route.fulfill({ status: fail ? 429 : 200, json: fail ? { error: "ASR_BUSY" } : { text: "辨識的文字" } }).catch(() => {})
  })
  await page.goto("/tests/voice-input/")
  const input = page.getByRole("textbox")
  await page.getByRole("button", { name: "語音輸入", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("錄音中")
  await expect(page.getByRole("button", { name: "送出", exact: true })).toBeDisabled()
  await input.fill("錄音時修改的草稿")
  await expect(page.getByRole("status")).toContainText(/錄音中 [1-9]/)
  await page.getByRole("button", { name: "停止錄音並辨識" }).click()
  await expect(input).toHaveValue("錄音時修改的草稿 辨識的文字")
  fail = true
  await page.getByRole("button", { name: "語音輸入", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("錄音中")
  await expect(page.getByRole("status")).toContainText(/錄音中 [1-9]/)
  await page.getByRole("button", { name: "停止錄音並辨識" }).click()
  await expect(page.getByRole("alert")).toContainText("忙碌")
  await expect(input).toHaveValue("錄音時修改的草稿 辨識的文字")
  await page.screenshot({ path: "test-results/voice-input-error.png", fullPage: true })
  fail = false
  await page.getByRole("button", { name: "重試語音辨識" }).click()
  await expect(input).toHaveValue("錄音時修改的草稿 辨識的文字 辨識的文字")
  delay = true
  await page.getByRole("button", { name: "語音輸入", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("錄音中")
  await expect(page.getByRole("status")).toContainText(/錄音中 [1-9]/)
  await page.getByRole("button", { name: "停止錄音並辨識" }).click()
  await expect.poll(() => uploaded).toBe(4)
  await page.getByRole("button", { name: "切換對話" }).click()
  release?.()
  await expect(input).toHaveValue("另一個對話")
  await page.getByRole("button", { name: "語音輸入", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("錄音中")
  await page.getByRole("button", { name: "取消語音輸入" }).click()
  await expect(page.getByRole("status")).toHaveCount(0)
  await expect(input).toHaveValue("另一個對話")
  expect(uploaded).toBe(4)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: "test-results/voice-input-mobile.png", fullPage: true })
})

test("missing model is visible and leaves the draft unchanged", async ({ page }) => {
  await page.route("**/api/transcription", (route) => route.fulfill({ json: { available: false } }))
  await page.goto("/tests/voice-input/")
  await page.getByRole("button", { name: "語音輸入", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("預設語音模型尚未就緒")
  await expect(page.getByRole("textbox")).toHaveValue("原有草稿")
})

test("model authoring saves transcription capability and shows the created model", async ({ page }) => {
  let created: Record<string, unknown> | undefined
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === "POST") {
      created = route.request().postDataJSON()
      expect(created?.capabilities).toEqual(["TRANSCRIPTION"])
      return route.fulfill({ json: { model_id: "model-test", ...created } })
    }
    if (path.endsWith("model-mappings")) return route.fulfill({ json: created ? [{ public_model_id: "model-test", connection_id: "connection-test", provider_model: "breeze-asr" }] : [] })
    return route.fulfill({ json: created ? [{ model_id: "model-test", lifecycle: "PUBLISHED", ...created }] : [] })
  })
  await page.goto("http://127.0.0.1:5198/tests/public-models/")
  await page.getByRole("button", { name: /Add model|新增模型/ }).click()
  await page.getByRole("combobox", { name: "模型用途" }).click()
  await page.getByRole("option", { name: "語音轉文字" }).click()
  const inputs = page.getByRole("textbox")
  await inputs.nth(0).fill("breeze-asr")
  await inputs.nth(1).fill("Breeze 語音輸入")
  await page.getByRole("button", { name: /Save model|儲存模型/ }).click()
  await expect(page.getByText("Breeze 語音輸入", { exact: true })).toBeVisible()
  expect(created?.model_name).toBe("breeze-asr")
  await page.screenshot({ path: "test-results/asr-model-created.png", fullPage: true })
})
