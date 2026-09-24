import { expect, test } from "bun:test"

import { COMPANY_MODEL_UNAVAILABLE_MESSAGE } from "../../lib/model-route"
import { runtimeErrorPresentation } from "./ChatComposer"

test("presents an interrupted turn as a stopped reply with recoverable output", () => {
  const presentation = runtimeErrorPresentation({
    runtimeError: "執行中止",
    modelRoute: "genio-gateway",
    messages: [
      { id: "user-1", role: "user", text: "請繼續" },
      { id: "thread:item-1", role: "assistant", text: "已產生部分回覆" },
    ],
  })

  expect(presentation.title).toBe("這次回覆已停止")
  expect(presentation.detail).toContain("部分輸出已保留")
  expect(presentation.detail).toContain("重新連線")
  expect(presentation.title).not.toBe("Bot 無法啟動")
})

test("does not claim partial output when an interrupted turn has no assistant output", () => {
  const presentation = runtimeErrorPresentation({
    runtimeError: "執行中止",
    modelRoute: "genio-gateway",
    messages: [
      { id: "user-1", role: "user", text: "請繼續" },
      { id: "interrupted-1", role: "assistant", text: "⚠️ 此輪已中止" },
    ],
  })

  expect(presentation.title).toBe("這次回覆已停止")
  expect(presentation.detail).toContain("尚未產生可顯示的回覆內容")
  expect(presentation.detail).not.toContain("部分輸出已保留")
})

test("keeps the company model exposure recovery copy for an empty model directory", () => {
  const presentation = runtimeErrorPresentation({
    runtimeError: COMPANY_MODEL_UNAVAILABLE_MESSAGE,
    modelRoute: "genio-gateway",
    messages: [],
  })

  expect(presentation.title).toBe("公司模型目前不可用")
  expect(presentation.detail).toContain("Runtime Policy")
})

test("maps NO_HEALTHY_CONNECTION to an actionable safe recovery without raw gateway details", () => {
  const rawError = "unexpected status 503 from /api/model-gateway/tenant/hash NO_HEALTHY_CONNECTION"
  const presentation = runtimeErrorPresentation({
    runtimeError: rawError,
    modelRoute: "genio-gateway",
    messages: [],
  })

  expect(presentation.title).toBe("公司模型連線尚未就緒")
  expect(presentation.detail).toContain("驗證模型 Connection")
  expect(presentation.detail).toContain("重新發佈 Resource")
  expect(presentation.detail).toContain("重新連線")
  expect(presentation.detail).not.toContain("NO_HEALTHY_CONNECTION")
  expect(presentation.detail).not.toContain("/api/model-gateway/")
  expect(presentation.showTechnicalDetail).toBe(false)
})
