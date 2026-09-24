import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { BotDesignerForm, botDesignerErrorCopy } from "./BotDesignerForm"

test("renders the Gateway prerequisite and an actionable missing-use-case error", () => {
  const error = botDesignerErrorCopy(new Error("USE_CASE_REQUIRED"))
  const html = renderToStaticMarkup(
    <BotDesignerForm submitLabel="建立" error={error} onComplete={() => {}} />,
  )

  expect(html).toContain("建立前需有可驗證的組織與 active Use Case")
  expect(html).toContain("公司模型需要 Use Case")
  expect(html).toContain("補齊所屬組織")
  expect(html).toContain("建立或啟用 Use Case")
  expect(html).toContain("表單內容會保留")
})

test("explains the missing Use Case selector and available short-term paths", () => {
  const error = botDesignerErrorCopy(new Error("USE_CASE_SELECTION_REQUIRED"))

  expect(error.detail).toContain("多個 active Use Case")
  expect(error.detail).toContain("不會替你猜測")
  expect(error.nextStep).toContain("尚未提供 Use Case 選擇器")
  expect(error.nextStep).toContain("管理員")
  expect(error.nextStep).toContain("單一 active Use Case")
  expect(error.nextStep).toContain("帳號有權限")
  expect(error.nextStep).toContain("個人 Codex")
  expect(error.nextStep).not.toContain("完成 Use Case 的選擇")
})
