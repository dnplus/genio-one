import { expect, test } from "bun:test"
import { GOOGLE_GEMINI_PREPAYMENT_DEPLETED_MESSAGE, MODEL_PROVIDER_RATE_LIMITED_MESSAGE } from "../../lib/model-route"
import { runtimeBlockFromMessage } from "./bot-runtime-status"

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

test("capability and model failures remain explicit instead of looking like connecting", () => {
  expect(runtimeBlockFromMessage("PERSONAL_BOT_NOT_ENTITLED")?.title).toBe("尚未授權")
  expect(runtimeBlockFromMessage(JSON.stringify({ code: "BOT_MODEL_ROUTE_UNAVAILABLE" }))?.title).toBe("模型路線不可用")
  expect(runtimeBlockFromMessage("BOT_MODEL_UNAVAILABLE")?.detail).toContain("對話")
  expect(runtimeBlockFromMessage("Headless：公司政策不允許啟動執行環境。 [POLICY_NOT_CONFIGURED]")?.title).toBe("執行環境未授權")
  expect(runtimeBlockFromMessage("POLICY_NOT_CONFIGURED")?.title).toBe("Codex 訂閱尚未授權")
  expect(runtimeBlockFromMessage("公司政策不允許使用個人 Codex。 [POLICY_NOT_CONFIGURED]")?.title).toBe("Codex 訂閱尚未授權")
  expect(runtimeBlockFromMessage("正在恢復連線")).toBeNull()
  expect(runtimeBlockFromMessage("upstream mentioned BOT_MODEL_UNAVAILABLE elsewhere")).toBeNull()
})

test("runtime denial uses the English runtime recovery copy", () => {
  const block = withEnglishBotLocale(() => runtimeBlockFromMessage("Headless：公司政策不允許啟動執行環境。 [DEFAULT_DENY]"))

  expect(block).toEqual({
    title: "Execution environment is not authorized",
    detail: "Company policy does not allow this Bot to start an execution environment. Conversation and enterprise tools remain available; ask an administrator to authorize the runtime before generating files or running code.",
  })
})

test("Gemini prepayment exhaustion provides a safe recovery instruction", () => {
  const block = runtimeBlockFromMessage(GOOGLE_GEMINI_PREPAYMENT_DEPLETED_MESSAGE)

  expect(block).toEqual({
    title: "Google Gemini 額度不足",
    detail: GOOGLE_GEMINI_PREPAYMENT_DEPLETED_MESSAGE,
  })
})

test("provider 429 explains the generic retry path without attributing a cause", () => {
  expect(runtimeBlockFromMessage(MODEL_PROVIDER_RATE_LIMITED_MESSAGE)).toEqual({
    title: "模型服務額度或速率受限",
    detail: MODEL_PROVIDER_RATE_LIMITED_MESSAGE,
  })
})
