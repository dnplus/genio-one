import { describe, expect, test } from "bun:test"

import {
  appServerArguments,
  appServerCommand,
  codexChildEnvironment,
  createManagedRuntime,
  e2bCommandResult,
  pendingRuntimeDetails,
  remoteExecServerCommand,
  requiresCodexBootstrap,
  resolveGenioDiscoveryMcpUrl,
  resolveGenioOneMcpUrl,
} from "./runtime"

describe("Codex app-server launch", () => {
  const configuration = {}

  test("does not inject a generic GenioOne MCP server", () => {
    expect(appServerArguments(configuration)).toEqual([
      "app-server",
      "-c",
      "analytics.enabled=false",
      "-c",
      "features.default_mode_request_user_input=true",
      "-c",
      "features.memories=false",
      "-c",
      'otel.exporter="none"',
      "-c",
      'otel.trace_exporter="none"',
      "-c",
      'otel.metrics_exporter="none"',
    ])
  })

  test("quotes the self-hosted desktop command without embedding credentials", () => {
    const command = appServerCommand({
      discoveryMcpUrl: "https://one.example.test/mcp?tenant=acme's",
    })
    expect(command).toContain("'codex' 'app-server'")
    expect(command).toContain("one.example.test")
    expect(command).not.toContain("access_token")
    expect(command).not.toContain("Bearer ")
  })

  test("passes a configured GenioOne model provider through native app-server config", () => {
    const args = appServerArguments({
      ...configuration,
      modelProvider: {
        id: "genio_one",
        name: "GenioOne AI Gateway",
        baseUrl: "https://one.example.test/v1",
        tokenEnvVar: "GENIO_ONE_MODEL_GATEWAY_TOKEN",
      },
    })
    expect(args).toContain('-c')
    expect(args).toContain('model_providers.genio_one.base_url="https://one.example.test/v1"')
    expect(args).toContain('model_providers.genio_one.env_key="GENIO_ONE_MODEL_GATEWAY_TOKEN"')
    expect(args).not.toContain('model_provider="genio_one"')
  })

  test("does not pass the runtime report signing key to the Codex child", () => {
    const child = codexChildEnvironment({
      GENIO_ONE_RUNTIME_REPORT_KEY_ID: "genio-one-bot-runtime",
      GENIO_ONE_RUNTIME_REPORT_PRIVATE_KEY_PEM: "private-key",
      GENIO_ONE_MCP_BEARER_TOKEN: "session-token",
    })
    expect(child.GENIO_ONE_RUNTIME_REPORT_KEY_ID).toBeUndefined()
    expect(child.GENIO_ONE_RUNTIME_REPORT_PRIVATE_KEY_PEM).toBeUndefined()
    expect(child.GENIO_ONE_MCP_BEARER_TOKEN).toBe("session-token")
  })

  test("keeps the agent loop server-side and puts only the native exec-server in E2B", () => {
    expect(remoteExecServerCommand()).toBe(
      "codex exec-server --listen ws://0.0.0.0:4512 --concurrent-requests 8",
    )
    expect(remoteExecServerCommand()).not.toContain("app-server")
  })

  test("pending session details are not exec-ready and have no desktop", () => {
    expect(pendingRuntimeDetails("e2b-self-hosted")).toEqual({
      kind: "e2b-self-hosted",
      tier: "none",
      cwd: "/home/user",
      desktopUrl: null,
      sandboxId: null,
      environmentId: null,
      execServerUrl: null,
      execReady: false,
    })
  })

  test("does not claim a local runtime provision is executable", async () => {
    const previous = process.env.GENIO_BOT_RUNTIME
    process.env.GENIO_BOT_RUNTIME = "local"
    try {
      await expect(createManagedRuntime({
        runtimeSessionId: "runtime-session",
        tenantId: "tenant-local",
        subjectId: "person-dylan",
        actingClientId: "genio-one-bot",
        tier: "headless",
      }, { onExit() {} })).rejects.toThrow("REMOTE_RUNTIME_NOT_CONFIGURED")
    } finally {
      if (previous === undefined) delete process.env.GENIO_BOT_RUNTIME
      else process.env.GENIO_BOT_RUNTIME = previous
    }
  })

  test("starts chat without a generic MCP config", () => {
    expect(appServerArguments({})).toEqual([
      "app-server",
      "-c",
      "analytics.enabled=false",
      "-c",
      "features.default_mode_request_user_input=true",
      "-c",
      "features.memories=false",
      "-c",
      'otel.exporter="none"',
      "-c",
      'otel.trace_exporter="none"',
      "-c",
      'otel.metrics_exporter="none"',
    ])
  })

  test("resolveGenioOneMcpUrl returns null in production when unset instead of throwing", () => {
    expect(resolveGenioOneMcpUrl({ NODE_ENV: "production" })).toBeNull()
    expect(resolveGenioOneMcpUrl({
      NODE_ENV: "production",
      GENIO_ONE_MCP_URL: "https://one.example.test/mcp",
    })).toBe("https://one.example.test/mcp")
  })

  test("retires the generic session-bound relay while retaining catalog Discovery", () => {
    const environment = {
      GENIO_BOT_PORT: "5191",
      GENIO_ONE_MCP_URL: "https://one.example.test/mcp",
      GENIO_ONE_PLATFORM_ORIGIN: "https://platform.example.test",
    } as NodeJS.ProcessEnv
    expect(resolveGenioOneMcpUrl(environment, "runtime/session")).toBeNull()
    expect(resolveGenioDiscoveryMcpUrl(environment, {
      tenantId: "tenant/a",
      subjectId: "person-a",
      actingClientId: "genio-one-bot",
      runtimeSessionId: "runtime/session",
    })).toBe("http://127.0.0.1:5191/api/discovery-mcp/runtime%2Fsession/mcp")
  })
})


test("native OTel export is explicitly configured with prompt logging enabled", () => {
  const args = appServerArguments({ otelEndpoint: "http://127.0.0.1:54318/" })
  expect(args).toContain('otel.exporter={otlp-http={endpoint="http://127.0.0.1:54318/v1/logs",protocol="json"}}')
  expect(args).toContain('otel.trace_exporter={otlp-http={endpoint="http://127.0.0.1:54318/v1/traces",protocol="json"}}')
  expect(args).toContain('otel.metrics_exporter={otlp-http={endpoint="http://127.0.0.1:54318/v1/metrics",protocol="json"}}')
  expect(args).toContain("otel.log_user_prompt=true")
})

test("rethrows E2B transport failures instead of bootstrapping Codex", async () => {
  const transportError = Object.assign(new Error("transport unavailable"), { statusCode: 503 })
  await expect(e2bCommandResult(async () => { throw transportError })).rejects.toBe(transportError)
})

test("bootstraps when the Codex command exits or returns a different version", async () => {
  const missing = await e2bCommandResult(async () => {
    throw Object.assign(new Error("not found"), { exitCode: 127 })
  })
  expect(requiresCodexBootstrap(missing, "0.155.0")).toBe(true)
  expect(requiresCodexBootstrap({ exitCode: 0, stdout: "codex-cli 0.154.0\n" }, "0.155.0")).toBe(true)
  expect(requiresCodexBootstrap({ exitCode: 0, stdout: "codex-cli 0.155.0\n" }, "0.155.0")).toBe(false)
})

 test("Discovery is attached without a generic enterprise MCP", () => {
  const args = appServerArguments({ discoveryMcpUrl: "http://platform/v1/tenants/tenant/discovery/mcp" })
  expect(args).toContain('mcp_servers.genio_discovery.url="http://platform/v1/tenants/tenant/discovery/mcp"')
  expect(args.some((argument) => argument.startsWith("mcp_servers.genio_one."))).toBe(false)
})
