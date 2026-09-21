import { observeIncomingRequest } from "@genioone/telemetry/operation-observability"
import { readConnectorConfigurationToken, type ConnectorConfiguration, type ConnectorKind } from "./configuration"

export function createConnectorHost(options: {
  kind: ConnectorKind
  configurationKey: string
  configuredHandler: (configuration: ConnectorConfiguration) => (request: Request) => Promise<Response>
  discoveryHandler: (request: Request) => Promise<Response>
}) {
  if (options.configurationKey.length < 32) throw new Error("CONNECTOR_CONFIGURATION_KEY_REQUIRED")
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === "/health") return Response.json({ service: `genio-connector-${options.kind}`, status: "ready", configuration: "per-connection" })
    if (url.pathname === "/mcp") return options.discoveryHandler(request)
    const token = /^\/mcp\/([A-Za-z0-9_.-]+)$/.exec(url.pathname)?.[1]
    if (!token) return new Response(null, { status: 404 })
    let configuration: ConnectorConfiguration
    try {
      configuration = readConnectorConfigurationToken(token, options.configurationKey)
      if (configuration.kind !== options.kind) throw new Error("CONNECTOR_KIND_MISMATCH")
    } catch {
      return Response.json({ error: "CONNECTOR_CONFIGURATION_UNTRUSTED" }, { status: 403 })
    }
    url.pathname = "/mcp"
    return options.configuredHandler(configuration)(new Request(url, request))
  }
  return (request: Request) => observeIncomingRequest(`genio-connector-${options.kind}`, request, () => handle(request))
}
