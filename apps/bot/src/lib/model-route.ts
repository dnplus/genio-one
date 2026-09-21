export type ModelRoute = "codex-subscription" | "genio-gateway"

export const GENIO_GATEWAY_MODEL_PROVIDER = "genio_one"
export const COMPANY_MODEL_UNAVAILABLE_MESSAGE = "目前沒有可用的公司模型，請聯絡管理員完成模型設定/授權。"
export const GOOGLE_GEMINI_PREPAYMENT_DEPLETED_MESSAGE = "Google Gemini 的預付額度已用盡。請補足 Google 預付額度後重新連線並重試。"
export const MODEL_PROVIDER_RATE_LIMITED_MESSAGE = "供應商拒絕請求（429），請檢查額度與速率限制後重新連線重試。"

export function modelProviderForRoute(route?: ModelRoute) {
  return route === "genio-gateway" ? GENIO_GATEWAY_MODEL_PROVIDER : undefined
}

export function modelRouteRequiresCodexLogin(route?: ModelRoute) {
  return route !== "genio-gateway"
}

function errorSource(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
    try {
      return JSON.stringify(error)
    } catch {}
  }
  return "模型提供者無法使用"
}

function errorText(error: unknown): string {
  const raw = errorSource(error)
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown }
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message
      if (typeof parsed.code === "string" && parsed.code.trim()) return parsed.code
    }
  } catch {}
  return raw
}

function isGoogleGeminiPrepaymentDepleted(error: unknown): boolean {
  const source = errorSource(error)
  return /\bRESOURCE_EXHAUSTED\b/i.test(source) && /prepayment credits? (?:are )?depleted/i.test(source)
}

function isModelProviderRateLimited(error: unknown): boolean {
  return /\b429\b/.test(errorSource(error))
}

function isPolicyFailure(reason: string): boolean {
  return reason === "BOT_CONNECTION_DISABLED" ||
    reason.startsWith("PERSONAL_BOT") ||
    reason.startsWith("RULE_DENY:") ||
    reason.startsWith("POLICY_") ||
    reason.startsWith("RUNTIME_POLICY_") ||
    reason.startsWith("ONE_POLICY_") ||
    reason === "DEFAULT_DENY" ||
    reason === "DEFAULT_POLICY_DENY" ||
    reason === "BOT_CLIENT_REQUIRED" ||
    reason === "TENANT_ADMINISTRATOR_REQUIRED"
}

export function isRuntimePolicyFailure(error: unknown): boolean {
  return isPolicyFailure(errorText(error))
}

export function isModelRouteFailure(error: unknown): boolean {
  const reason = errorText(error)
  return reason.startsWith("BOT_MODEL_") || /\bcodex(?:[._-]?subscription)?\b/i.test(reason)
}

export function runtimeFailureMessage(error: unknown, context: "request" | "codex" | "runtime" = "request"): string {
  if (isGoogleGeminiPrepaymentDepleted(error)) return GOOGLE_GEMINI_PREPAYMENT_DEPLETED_MESSAGE
  if (isModelProviderRateLimited(error)) return MODEL_PROVIDER_RATE_LIMITED_MESSAGE
  const reason = errorText(error)
  if (reason === "BOT_CONNECTION_DISABLED") return "Genio Bot 服務已停用，請聯絡管理員。 [BOT_CONNECTION_DISABLED]"
  if (isPolicyFailure(reason)) {
    if (context === "runtime") return `公司政策不允許啟動執行環境。 [${reason}]`
    if (context === "codex" || /\bcodex(?:[._-]?subscription)?\b/i.test(reason)) return `公司政策不允許使用個人 Codex。 [${reason}]`
    return `公司政策不允許這項要求。 [${reason}]`
  }
  return reason
}

export function canonicalModelRoute(route?: ModelRoute): ModelRoute {
  return route === "genio-gateway" ? "genio-gateway" : "codex-subscription"
}

export function modelRouteFailureMessage(route?: ModelRoute, error?: unknown) {
  const reason = errorText(error)
  const message = runtimeFailureMessage(error, route === "codex-subscription" ? "codex" : "request")
  if (isPolicyFailure(reason)) return message
  if (route === "genio-gateway") return COMPANY_MODEL_UNAVAILABLE_MESSAGE
  return message
}

export function modelCatalogForRoute<T>(route: ModelRoute, companyModels: readonly T[], personalModels: readonly T[]): T[] {
  return [...(route === "genio-gateway" ? companyModels : personalModels)]
}

export interface ModelRoutePresentation {
  providerLabel: string
  cardTitle: string
  loginAction: string
  loginInstruction: string
  waitingState: string
  requiresLogin: boolean
}

export function modelRoutePresentation(route?: ModelRoute): ModelRoutePresentation {
  if (route === "genio-gateway") {
    return {
      providerLabel: "GenioOne AI Gateway",
      cardTitle: "連接模型提供者",
      loginAction: "登入模型提供者",
      loginInstruction: "此 Bot 使用 GenioOne LLM Provider；目前的 GenioOne 登入工作階段會直接沿用",
      waitingState: "等待 GenioOne AI Gateway 工作階段",
      requiresLogin: false,
    }
  }
  return {
    providerLabel: "Codex OAuth",
    cardTitle: "連接模型提供者",
    loginAction: "登入模型提供者",
    loginInstruction: "在登入頁輸入裝置代碼",
    waitingState: "等待 Codex OAuth 登入",
    requiresLogin: true,
  }
}

export function gatewayModelsFromDirectory(models: readonly { publicModelId?: string; displayName?: string }[]) {
  return models.flatMap((model) => {
    const id = model.publicModelId?.trim()
    if (!id) return []
    return [{
      id,
      displayName: model.displayName?.trim() || id,
      description: "GenioOne AI Gateway model",
      supportedReasoningEfforts: [{ reasoningEffort: "minimal", description: "Gateway default" }],
    }]
  })
}
