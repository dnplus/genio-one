export function modelGatewayRelayOrigin() {
  return process.env.GENIO_ONE_MODEL_GATEWAY_RELAY_ORIGIN?.trim().replace(/\/$/, "") ||
    `http://127.0.0.1:${process.env.GENIO_BOT_PORT?.trim() || "5181"}`
}

export function botBoundModelGatewayBaseUrl(runtimeSessionId: string, botId: string) {
  return `${modelGatewayRelayOrigin()}/api/model-gateway/${encodeURIComponent(runtimeSessionId)}/bots/${encodeURIComponent(botId)}/v1`
}

export function botBoundModelProviderConfig(runtimeSessionId: string, botId: string) {
  return { "model_providers.genio_one.base_url": botBoundModelGatewayBaseUrl(runtimeSessionId, botId) }
}

export function botBoundDiscoveryMcpUrl(runtimeSessionId: string, botId: string) {
  return `${modelGatewayRelayOrigin()}/api/discovery-mcp/${encodeURIComponent(runtimeSessionId)}/bots/${encodeURIComponent(botId)}/mcp`
}

export function botBoundDiscoveryMcpConfig(runtimeSessionId: string, botId: string) {
  return {
    "mcp_servers.genio_discovery": {
      url: botBoundDiscoveryMcpUrl(runtimeSessionId, botId),
      bearer_token_env_var: "GENIO_ONE_MCP_BEARER_TOKEN",
      default_tools_approval_mode: "writes",
      required: false,
    },
  }
}
