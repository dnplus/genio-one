import {
  Client,
  SdkHttpError,
  UnauthorizedError,
  StreamableHTTPClientTransport,
  type AuthProvider,
} from "@modelcontextprotocol/client"

export interface McpDiscoveryTool {
  name: string
  title: string | null
  description: string | null
}

export interface McpDiscoveryObservation {
  protocol_version: string
  server_name: string
  server_version: string | null
  tools: McpDiscoveryTool[]
}

export interface McpDiscoveryInput {
  endpoint: string
  authProvider?: AuthProvider
  timeoutMs?: number
}

function endpointUrl(value: string): URL {
  const endpoint = new URL(value)
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("MCP endpoint must be an HTTP URL without embedded credentials")
  }
  return endpoint
}

export async function discoverMcpConnection(
  input: McpDiscoveryInput,
): Promise<McpDiscoveryObservation> {
  const transport = new StreamableHTTPClientTransport(endpointUrl(input.endpoint), {
    ...(input.authProvider ? { authProvider: input.authProvider } : {}),
  })
  const client = new Client({ name: "genio-one-gateway-runtime", version: "1.0.0" })
  try {
    await client.connect(transport, { timeout: input.timeoutMs ?? 10_000 })
    const listed = await client.listTools(undefined, {
      cacheMode: "refresh",
      timeout: input.timeoutMs ?? 10_000,
    })
    const server = client.getServerVersion()
    return {
      protocol_version: client.getNegotiatedProtocolVersion() ?? "unknown",
      server_name: server?.name ?? "mcp",
      server_version: server?.version ?? null,
      tools: listed.tools.map((tool) => ({
        name: tool.name,
        title: tool.title ?? null,
        description: tool.description?.slice(0, 16_384) ?? null,
      })),
    }
  } finally {
    await client.close().catch(() => undefined)
  }
}

export async function discoverMcpWithUserAuthorization(input: {
  endpoint: string
  credential: () => Promise<string>
  discover?: typeof discoverMcpConnection
}): Promise<McpDiscoveryObservation> {
  const discover = input.discover ?? discoverMcpConnection
  try {
    return await discover({ endpoint: input.endpoint })
  } catch (error) {
    if (!(error instanceof UnauthorizedError) && !(error instanceof SdkHttpError && error.status === 401)) throw error
    const credential = await input.credential()
    return discover({ endpoint: input.endpoint, authProvider: { token: async () => credential } })
  }
}
