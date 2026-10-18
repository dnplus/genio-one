import { expect, test } from "@playwright/test"

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  for (const locale of [
    { query: "", language: "zh-TW", group: "訊息操作", like: "讚", dislike: "倒讚" },
    { query: "&lang=en", language: "en", group: "Message actions", like: "Like", dislike: "Dislike" },
  ]) {
    test(`fixture rendered regression: feedback toggle states in ${locale.language} on ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.goto(`/?demo=1${locale.query}`)
      const actions = page.getByRole("group", { name: locale.group }).first()
      const like = actions.getByRole("button", { name: locale.like, exact: true })
      const dislike = actions.getByRole("button", { name: locale.dislike, exact: true })

      await expect(actions.getByRole("button", { name: locale.like, exact: true, pressed: false })).toBeVisible()
      await expect(actions.getByRole("button", { name: locale.dislike, exact: true, pressed: false })).toBeVisible()
      await like.focus()
      await page.keyboard.press("Space")
      await expect(like).toHaveAttribute("aria-pressed", "true")
      await expect(dislike).toHaveAttribute("aria-pressed", "false")
      await dislike.click()
      await expect(like).toHaveAttribute("aria-pressed", "false")
      await expect(dislike).toHaveAttribute("aria-pressed", "true")
      await page.reload()
      await expect(dislike).toHaveAttribute("aria-pressed", "true")
      await dislike.focus()
      await page.keyboard.press("Space")
      await expect(like).toHaveAttribute("aria-pressed", "false")
      await expect(dislike).toHaveAttribute("aria-pressed", "false")
    })
  }
}
