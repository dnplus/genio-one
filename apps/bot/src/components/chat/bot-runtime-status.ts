import { GOOGLE_GEMINI_PREPAYMENT_DEPLETED_MESSAGE, MODEL_PROVIDER_RATE_LIMITED_MESSAGE } from "../../lib/model-route"
import { botCopy } from "../../lib/ui-copy"

export function runtimeBlockFromMessage(message: string): { title: string; detail: string } | null {
  let code = message
  try {
    const parsed = JSON.parse(message)
    if (typeof parsed?.code === "string") code = parsed.code
  } catch {}
  if (code === "PERSONAL_BOT_NOT_ENTITLED" || code === "PERSONAL_BOT_REQUESTABLE" || code === "目前帳號尚未取得 Bot 使用權限") {
    return { title: "尚未授權", detail: "目前帳號尚未取得 Bot 使用權限。請聯絡管理員確認，完成後重新連線。" }
  }
  if (code === "BOT_MODEL_ROUTE_UNAVAILABLE" || code === "BOT_MODEL_UNAVAILABLE") {
    return { title: "模型路線不可用", detail: "這個 Bot 的模型路線目前無法使用。對話記錄仍保留；請確認模型設定與 One Policy 授權，完成後重新連線。" }
  }
  if (message.includes("公司政策不允許啟動執行環境。")) {
    return {
      title: botCopy("Execution environment is not authorized", "執行環境未授權"),
      detail: botCopy("Company policy does not allow this Bot to start an execution environment. Conversation and enterprise tools remain available; ask an administrator to authorize the runtime before generating files or running code.", "公司政策不允許此 Bot 啟動執行環境。對話與企業工具仍可使用；如需產生檔案或執行程式，請由管理員授權 Runtime Policy 後再試。"),
    }
  }
  if (code === "POLICY_NOT_CONFIGURED" || /\bPOLICY_NOT_CONFIGURED\b/.test(code)) {
    return { title: "Codex 訂閱尚未授權", detail: "目前尚未發佈允許這個 Bot 使用 Codex 訂閱的 Runtime Policy。請由管理員完成 One Policy 設定後重新連線。" }
  }
  if (message === GOOGLE_GEMINI_PREPAYMENT_DEPLETED_MESSAGE) {
    return { title: "Google Gemini 額度不足", detail: GOOGLE_GEMINI_PREPAYMENT_DEPLETED_MESSAGE }
  }
  if (message === MODEL_PROVIDER_RATE_LIMITED_MESSAGE) {
    return { title: "模型服務額度或速率受限", detail: MODEL_PROVIDER_RATE_LIMITED_MESSAGE }
  }
  return null
}
