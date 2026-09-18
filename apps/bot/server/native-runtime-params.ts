import type { BotRegistry } from "./bot-registry"
import type { BotModelDirectory } from "./model-directory"
import type { RuntimeSession } from "./runtime-broker"
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams"
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams"
import type { TurnStartParams } from "./generated/v2/TurnStartParams"
import { canonicalRuntimeEnvironments } from "./native-runtime-environment"
import { nativeRuntimeConfig, nativeRuntimeSandboxMode, type NativeRuntimeEnvironment, type NativeRuntimeExposure } from "./native-runtime-policy"

const clientFields = {
  "thread/start": ["model", "serviceTier"] satisfies Array<keyof ThreadStartParams>,
  "thread/resume": ["threadId", "model", "serviceTier", "excludeTurns"] satisfies Array<keyof ThreadResumeParams>,
  "turn/start": ["threadId", "clientUserMessageId", "input", "model", "serviceTier", "serviceTierForTurn", "effort", "summary", "outputSchema", "additionalContext"] satisfies Array<keyof TurnStartParams>,
}

export async function canonicalizeNativeParams(options: {
  method: keyof typeof clientFields
  params: unknown
  session: RuntimeSession
  botId: string
  exposure: NativeRuntimeExposure
  environment: NativeRuntimeEnvironment
  botRegistry: Pick<BotRegistry, "getOwned">
  modelDirectory: BotModelDirectory
  accessToken?: string
}): Promise<Record<string, unknown>> {
  const { method, params, session, botId, exposure, environment } = options
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("RUNTIME_PARAMS_INVALID")
  const input = params as Record<string, unknown>
  const environments = canonicalRuntimeEnvironments(session, input.environments, botId)
  const bot = options.botRegistry.getOwned(botId, session.principal)
  if (!bot) throw new Error("BOT_NOT_FOUND")
  const route = bot.modelRoute === "genio-gateway"
    ? { kind: "genio-gateway" as const, modelProvider: "genio_one" }
    : { kind: "codex-subscription" as const }
  const plans = await options.modelDirectory.resolve(session.principal, bot.id, route, options.accessToken)
  const requestedModel = typeof input.model === "string" ? input.model.trim() : ""
  if (route.kind === "genio-gateway" && requestedModel && !plans.some((plan) => plan.publicModelId === "*" || plan.publicModelId === requestedModel)) {
    throw new Error("BOT_MODEL_NOT_ALLOWED")
  }
  const clientParams: Record<string, unknown> = {}
  for (const field of clientFields[method]) {
    if (Object.hasOwn(input, field)) clientParams[field] = input[field]
  }
  const roots = environments[0]?.runtimeWorkspaceRoots ?? []
  const common = {
    ...clientParams,
    approvalPolicy: "on-request",
    environments,
    cwd: environments[0]?.cwd ?? session.details.cwd,
    runtimeWorkspaceRoots: roots,
    ...(route.kind === "genio-gateway" ? { modelProvider: route.modelProvider } : {}),
  }
  const { writable } = nativeRuntimeSandboxMode(exposure, environment)
  if (method === "turn/start") {
    return {
      ...common,
      sandboxPolicy: writable
        ? { type: "workspaceWrite", writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
        : { type: "readOnly", networkAccess: false },
    }
  }
  return {
    ...common,
    sandbox: writable ? "workspace-write" : "read-only",
    serviceName: "genio-one-bot",
    baseInstructions: `You are ${bot.name}, an enterprise GenioOne personal agent. Treat server capability decisions and resource access as authoritative. ${bot.description ?? ""}`.trim(),
    config: nativeRuntimeConfig(exposure, environment),
  }
}
