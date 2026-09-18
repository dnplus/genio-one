import { describe, expect, test } from "bun:test"

import { GENIO_GATEWAY_MODEL_PROVIDER, GOOGLE_GEMINI_PREPAYMENT_DEPLETED_MESSAGE, MODEL_PROVIDER_RATE_LIMITED_MESSAGE, modelCatalogForRoute, modelProviderForRoute, modelRouteFailureMessage, modelRoutePresentation, modelRouteRequiresCodexLogin, runtimeFailureMessage } from "./model-route"

describe("model route presentation", () => {
  test("keeps provider copy and native provider selection separate", () => {
    expect(modelProviderForRoute("codex-subscription")).toBeUndefined()
    expect(modelProviderForRoute("genio-gateway")).toBe(GENIO_GATEWAY_MODEL_PROVIDER)
    expect(modelRoutePresentation("codex-subscription").requiresLogin).toBe(true)
    expect(modelRoutePresentation("genio-gateway").requiresLogin).toBe(false)
    expect(modelRoutePresentation("genio-gateway").loginAction).toBe("登入模型提供者")
  })

  test("company route never exposes Codex login and reports missing models clearly", () => {
    expect(modelRouteRequiresCodexLogin("genio-gateway")).toBe(false)
    expect(modelRouteRequiresCodexLogin("codex-subscription")).toBe(true)
    expect(modelRouteFailureMessage("genio-gateway", new Error("BOT_MODEL_NOT_ENTITLED"))).toBe("目前沒有可用的公司模型，請聯絡管理員完成模型設定/授權。")
  })

  test("attributes policy failures to the denied surface", () => {
    expect(runtimeFailureMessage(new Error("BOT_CONNECTION_DISABLED"))).toBe("Genio Bot 服務已停用，請聯絡管理員。 [BOT_CONNECTION_DISABLED]")
    expect(modelRouteFailureMessage("genio-gateway", new Error("RULE_DENY:codex.subscription"))).toBe("公司政策不允許使用個人 Codex。 [RULE_DENY:codex.subscription]")
    expect(modelRouteFailureMessage("codex-subscription", new Error(JSON.stringify({ code: "POLICY_DISABLED", message: "POLICY_DISABLED" })))).toBe("公司政策不允許使用個人 Codex。 [POLICY_DISABLED]")
    expect(runtimeFailureMessage("DEFAULT_DENY")).toBe("公司政策不允許這項要求。 [DEFAULT_DENY]")
    expect(runtimeFailureMessage("DEFAULT_DENY", "runtime")).toBe("公司政策不允許啟動執行環境。 [DEFAULT_DENY]")
  })

  test("maps a depleted Gemini prepayment balance without exposing the provider response", () => {
    const error = {
      message: "Google API error 429 RESOURCE_EXHAUSTED: Your prepayment credits are depleted. https://generativelanguage.googleapis.com/v1beta/models?key=not-for-display",
    }

    expect(runtimeFailureMessage(error)).toBe(GOOGLE_GEMINI_PREPAYMENT_DEPLETED_MESSAGE)
    expect(runtimeFailureMessage(error)).not.toContain("not-for-display")
  })

  test("maps a bare provider 429 without inferring its provider or cause", () => {
    expect(runtimeFailureMessage("exceeded retry limit, last status: 429 Too Many Requests")).toBe(MODEL_PROVIDER_RATE_LIMITED_MESSAGE)
  })

  test("company model catalog never falls back to personal models", () => {
    expect(modelCatalogForRoute("genio-gateway", ["uat-vertex"], ["gpt-5.6-luna", "gpt-5.6-terra"])).toEqual(["uat-vertex"])
    expect(modelCatalogForRoute("genio-gateway", [], ["gpt-5.6-luna"])).toEqual([])
    expect(modelCatalogForRoute("codex-subscription", ["uat-vertex"], ["gpt-5.6-luna"])).toEqual(["gpt-5.6-luna"])
  })
})
